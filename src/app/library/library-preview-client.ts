/** A small, private per-player cache; every Blob URL belongs to this client. */
export function createLibraryPreviewClient(libraryId: string, cacheEntries = 24) {
  const cache = new Map<number, string>();
  const active = new Set<AbortController>();
  let disposed = false;
  const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });

  return {
    async get(time: number, signal?: AbortSignal): Promise<string | undefined> {
      if (disposed || signal?.aborted || !Number.isFinite(time) || time < 0) return;
      const bucket = Math.floor(time / 5) * 5;
      const cached = cache.get(bucket);
      if (cached) { cache.delete(bucket); cache.set(bucket, cached); return cached; }
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      active.add(controller);
      const timeout = setTimeout(cancel, 15_000);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetch(`/api/library/${encodeURIComponent(libraryId)}/preview?time=${bucket}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
          if (response.status === 503 && attempt < 2) { await response.body?.cancel(); await wait(attempt ? 1000 : 650, controller.signal); continue; }
          if (!response.ok || !response.headers.get('content-type')?.startsWith('image/jpeg')) { await response.body?.cancel(); return; }
          const blob = await response.blob();
          if (disposed || controller.signal.aborted || !blob.size || blob.size > 1024 * 1024) return;
          const existing = cache.get(bucket);
          if (existing) return existing;
          const url = URL.createObjectURL(blob);
          cache.set(bucket, url);
          while (cache.size > Math.max(1, cacheEntries)) {
            const oldest = cache.keys().next().value as number;
            URL.revokeObjectURL(cache.get(oldest)!); cache.delete(oldest);
          }
          return url;
        }
      } catch { /* Failed previews leave the timestamp visible and playback untouched. */ }
      finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); active.delete(controller); }
    },
    dispose() {
      disposed = true;
      for (const controller of active) controller.abort();
      active.clear();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
    },
  };
}
