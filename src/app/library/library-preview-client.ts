/** A small, private per-player cache; every Blob URL belongs to this client. */
export function createLibraryPreviewClient(libraryId: string, cacheEntries = 24) {
  const cache = new Map<number, string>();
  let active: { bucket: number; controller: AbortController; promise: Promise<string | undefined> } | undefined;
  let disposed = false;
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  // Moving the pointer cancels only that caller's wait. Finishing one small
  // frame avoids abandoning an extractor which is still busy on the server.
  const observe = (promise: Promise<string | undefined>, signal?: AbortSignal) => new Promise<string | undefined>((resolve) => {
    const finish = (value?: string) => { signal?.removeEventListener('abort', cancel); resolve(signal?.aborted ? undefined : value); };
    const cancel = () => finish();
    if (signal?.aborted) { resolve(undefined); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    void promise.then(finish);
  });
  const load = async (bucket: number, controller: AbortController) => {
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      // The extractor has a five-second upper bound. Allow a request already
      // started by another tab to finish before giving up on the latest hover.
      for (let attempt = 0; attempt < 8; attempt++) {
        const response = await fetch(`/api/library/${encodeURIComponent(libraryId)}/preview?time=${bucket}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (response.status === 503 && attempt < 7) {
          const seconds = Number(response.headers.get('retry-after'));
          const delay = Number.isFinite(seconds) && seconds > 0 ? Math.min(1500, Math.max(250, seconds * 1000)) : 750;
          await response.body?.cancel(); await wait(delay, controller.signal); continue;
        }
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) { await response.body?.cancel(); return; }
        const blob = await response.blob();
        if (disposed || controller.signal.aborted || !blob.size || blob.size > 1024 * 1024) return;
        const url = URL.createObjectURL(blob);
        cache.set(bucket, url);
        while (cache.size > Math.max(1, cacheEntries)) {
          const oldest = cache.keys().next().value as number;
          URL.revokeObjectURL(cache.get(oldest)!); cache.delete(oldest);
        }
        return url;
      }
    } catch { /* A failed preview leaves playback untouched. */ }
    finally { clearTimeout(timeout); }
  };

  return {
    async get(time: number, signal?: AbortSignal): Promise<string | undefined> {
      if (disposed || signal?.aborted || !Number.isFinite(time) || time < 0) return;
      const bucket = Math.floor(time / 5) * 5;
      for (;;) {
        if (disposed || signal?.aborted) return;
        const cached = cache.get(bucket);
        if (cached) { cache.delete(bucket); cache.set(bucket, cached); return cached; }
        if (active) {
          const job = active;
          const result = await observe(job.promise, signal);
          if (job.bucket === bucket) return result;
          continue;
        }
        const controller = new AbortController();
        const job = { bucket, controller, promise: Promise.resolve<string | undefined>(undefined) };
        job.promise = load(bucket, controller).finally(() => { if (active === job) active = undefined; });
        active = job;
        return observe(job.promise, signal);
      }
    },
    dispose() {
      disposed = true;
      active?.controller.abort();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    },
  };
}
