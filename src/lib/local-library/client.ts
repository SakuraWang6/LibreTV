'use client';

import type { SaveTarget } from '../download-saver';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryEntry, type LibraryMetadata, type LibraryResponse } from './types';
export { guessLibraryMetadata } from './filename';

type LibraryFormat = 'MP4' | 'TS' | 'WEBM' | 'MOV';
const UPLOAD_CHUNK_BYTES = 1024 * 1024;
const PENDING_UPLOAD_PREFIX = 'libretv:pending-library-upload:';
const UPLOAD_OWNER_KEY = 'libretv:library-upload-owner';
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const documentId = crypto.randomUUID();
const activeUploads = new Set<string>();
let cleanupInFlight: Promise<void> | undefined;

interface PendingUpload {
  id: string;
  owner: string;
  documentId: string;
  startedAt: number;
  heartbeatAt: number;
  usesLock: boolean;
}

class LibraryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function uploadOwner(): string {
  try {
    const tabOwner = sessionStorage.getItem(UPLOAD_OWNER_KEY) || crypto.randomUUID();
    sessionStorage.setItem(UPLOAD_OWNER_KEY, tabOwner);
    return tabOwner;
  } catch {
    return documentId;
  }
}

function forgetUpload(id: string): void {
  try { localStorage.removeItem(`${PENDING_UPLOAD_PREFIX}${id}`); } catch { /* Retry on the next app opening. */ }
}

async function cancelPendingUpload(id: string): Promise<void> {
  try {
    await libraryRequest(`/api/library/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
  } catch (error) {
    // DELETE cannot delete library media. A lost completion response may leave an already committed ID here.
    if (!(error instanceof LibraryRequestError) || ![404, 409, 410].includes(error.status)) throw error;
  }
  forgetUpload(id);
}

function lockManager(): LockManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.locks : undefined;
}

/** A Web Lock survives background timer throttling, and the browser releases it after a crash/refresh. */
async function holdUploadLock(id: string): Promise<{ usesLock: boolean; release: () => Promise<void> }> {
  const locks = lockManager();
  if (!locks) return { usesLock: false, release: async () => {} };
  return new Promise((resolve) => {
    const finished: Promise<unknown> = locks.request(`${PENDING_UPLOAD_PREFIX}${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve({ usesLock: false, release: async () => {} }); return; }
      await new Promise<void>((release) => resolve({ usesLock: true, release: async () => { release(); await finished; } }));
    }).catch(() => resolve({ usesLock: false, release: async () => {} }));
  });
}

function readPendingUploads(): PendingUpload[] {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    return keys.flatMap((key) => {
      if (!key?.startsWith(PENDING_UPLOAD_PREFIX)) return [];
      try {
        const record = JSON.parse(localStorage.getItem(key) || 'null') as PendingUpload | null;
        return record && record.id === key.slice(PENDING_UPLOAD_PREFIX.length)
          && typeof record.owner === 'string' && typeof record.documentId === 'string'
          && Number.isFinite(record.startedAt) && Number.isFinite(record.heartbeatAt) ? [record] : [];
      } catch { return []; }
    });
  } catch { return []; }
}

/** Best effort: keep failed/unauthorized cancellations persisted so login or the next opening can retry. */
export function cleanupInterruptedLibraryUploads(): Promise<void> {
  if (cleanupInFlight) return cleanupInFlight;
  cleanupInFlight = (async () => {
    for (const record of readPendingUploads()) {
      if (activeUploads.has(record.id)) continue;
      try {
        const locks = lockManager();
        if (record.usesLock && locks) {
          await locks.request(`${PENDING_UPLOAD_PREFIX}${record.id}`, { ifAvailable: true }, async (lock) => {
            if (lock && !activeUploads.has(record.id)) await cancelPendingUpload(record.id);
          });
        } else if ((record.owner === uploadOwner() && record.documentId !== documentId)
          || Date.now() - record.heartbeatAt > STALE_UPLOAD_MS) {
          // Older browsers: reclaim this tab's previous document immediately, other tabs only after a day without heartbeat.
          await cancelPendingUpload(record.id);
        }
      } catch { /* Login/network failures remain in localStorage for the next retry. */ }
    }
  })().finally(() => { cleanupInFlight = undefined; });
  return cleanupInFlight;
}

/** Retry only transient failures. Reusing the same upload offset makes a lost response safe. */
async function libraryRequest<T>(url: string, init?: RequestInit, retry = false): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < (retry ? 3 : 1); attempt++) {
    if (init?.signal?.aborted) throw new Error('已取消保存到本地影视库');
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        cache: 'no-store',
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (init?.signal?.aborted) throw new Error('已取消保存到本地影视库');
      lastError = error;
      if (attempt < 2 && retry) continue;
      throw new Error('连接本地影视库失败，请确认光影正在运行后重试');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
      const message = response.status === 401
        ? '请登录后重试本地影视库操作'
        : payload.error || payload.message || `本地影视库操作失败（HTTP ${response.status}）`;
      lastError = new LibraryRequestError(message, response.status);
      if (retry && response.status >= 500 && attempt < 2) continue;
      throw lastError;
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  throw lastError instanceof Error ? lastError : new Error('本地影视库操作失败');
}

export async function fetchLibrary(): Promise<LibraryResponse> {
  void cleanupInterruptedLibraryUploads();
  // Do not cache a pre-login 401: this component can live outside AuthProvider.
  const result = await libraryRequest<LibraryResponse>('/api/library');
  if (typeof result.enabled !== 'boolean' || !Array.isArray(result.items)) throw new Error('本地影视库返回异常，请重试');
  return result;
}

export async function createLibrarySaveTarget(metadata: LibraryMetadata, format: LibraryFormat = 'MP4'): Promise<SaveTarget> {
  void cleanupInterruptedLibraryUploads();
  // Fail before creating server staging if crash recovery cannot be persisted in this browser.
  try {
    localStorage.setItem(`${PENDING_UPLOAD_PREFIX}probe`, '1');
    localStorage.removeItem(`${PENDING_UPLOAD_PREFIX}probe`);
  } catch { throw new Error('浏览器无法保存下载任务记录，请允许本站使用本地存储后重试'); }
  const upload = await libraryRequest<{ id: string; offset: number }>('/api/library/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metadata, format }),
  });
  if (!upload.id || upload.offset !== 0) throw new Error('本地影视库未能创建写入任务，请重试');
  activeUploads.add(upload.id);
  // Acquire protection before publishing the ID to other tabs. No video bytes are written before tracking succeeds.
  const lease = await holdUploadLock(upload.id);
  const record: PendingUpload = {
    id: upload.id, owner: uploadOwner(), documentId, usesLock: lease.usesLock,
    startedAt: Date.now(), heartbeatAt: Date.now(),
  };
  try { localStorage.setItem(`${PENDING_UPLOAD_PREFIX}${upload.id}`, JSON.stringify(record)); }
  catch {
    await lease.release();
    activeUploads.delete(upload.id);
    await cancelPendingUpload(upload.id).catch(() => {});
    throw new Error('浏览器无法记录下载进度，本次下载已取消，请检查本地存储空间');
  }
  const heartbeat = setInterval(() => {
    record.heartbeatAt = Date.now();
    try { localStorage.setItem(`${PENDING_UPLOAD_PREFIX}${upload.id}`, JSON.stringify(record)); } catch { /* Existing recovery record remains. */ }
  }, 20_000);
  const stopTracking = async () => {
    clearInterval(heartbeat);
    activeUploads.delete(upload.id);
    await lease.release();
  };
  const uploadUrl = `/api/library/uploads/${encodeURIComponent(upload.id)}`;
  const controller = new AbortController();
  let offset = upload.offset;
  let state: 'open' | 'closing' | 'closed' | 'aborted' | 'failed' = 'open';
  let pending = Promise.resolve();
  let closing: Promise<void> | undefined;
  let aborting: Promise<void> | undefined;

  return {
    kind: 'fs',
    write(data) {
      if (state !== 'open') return Promise.reject(new Error('本地影视库写入已结束，请重新下载'));
      const operation = pending.then(async () => {
        if (controller.signal.aborted) throw new Error('已取消保存到本地影视库');
        for (let start = 0; start < data.byteLength; start += UPLOAD_CHUNK_BYTES) {
          // Copy one bounded chunk, never an entire film; fetch may retain its body until resolved.
          const chunk = data.slice(start, start + UPLOAD_CHUNK_BYTES);
          const next = await libraryRequest<{ offset: number }>(`${uploadUrl}?offset=${offset}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk.buffer as ArrayBuffer,
            signal: controller.signal,
          }, true);
          if (next.offset !== offset + chunk.byteLength) throw new Error('本地影视库写入进度不一致，请重新下载');
          offset = next.offset;
        }
      });
      pending = operation;
      return operation;
    },
    close() {
      if (state === 'closed') return Promise.resolve();
      if (closing) return closing;
      if (state !== 'open') return Promise.reject(new Error('本地影视库保存已取消'));
      state = 'closing';
      closing = (async () => {
        try {
          await pending;
          if (controller.signal.aborted) throw new Error('已取消保存到本地影视库');
          const result = await libraryRequest<{ item: LibraryEntry }>(`${uploadUrl}/complete`, { method: 'POST', signal: controller.signal }, true);
          if (!result.item?.id) throw new Error('本地影视库未确认保存完成，请重试');
          state = 'closed';
          forgetUpload(upload.id);
          await stopTracking();
          if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_LIBRARY_UPDATED_EVENT));
        } catch (error) {
          if (!controller.signal.aborted) state = 'failed';
          throw error;
        }
      })();
      return closing;
    },
    abort() {
      if (state === 'closed') return Promise.resolve();
      if (aborting) return aborting;
      state = 'aborted';
      controller.abort();
      aborting = (async () => {
        try {
          await pending.catch(() => {});
          await cancelPendingUpload(upload.id);
        } finally { await stopTracking(); }
      })();
      return aborting;
    },
  };
}

export async function importLibraryFile(
  file: File,
  metadata: LibraryMetadata,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const format: LibraryFormat | undefined = extension === 'mp4' || extension === 'm4v' ? 'MP4'
    : extension === 'webm' ? 'WEBM' : extension === 'mov' ? 'MOV' : undefined;
  if (!format) throw new Error('请选择 MP4、M4V、WebM 或 MOV 视频文件');
  if (!file.size) throw new Error('视频文件为空，请选择完整的视频文件');
  const target = await createLibrarySaveTarget(metadata, format);
  try {
    onProgress?.(0);
    for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK_BYTES) {
      await target.write(new Uint8Array(await file.slice(offset, offset + UPLOAD_CHUNK_BYTES).arrayBuffer()));
      onProgress?.(Math.min(99, Math.floor((offset + Math.min(UPLOAD_CHUNK_BYTES, file.size - offset)) / file.size * 100)));
    }
    await target.close();
    onProgress?.(100);
  } catch (error) {
    await target.abort().catch(() => {});
    throw error;
  }
}

export async function updateLibraryMetadata(id: string, metadata: LibraryMetadata): Promise<LibraryEntry> {
  const result = await libraryRequest<{ item: LibraryEntry }>(`/api/library/${encodeURIComponent(id)}/metadata`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata }),
  });
  if (!result.item?.id) throw new Error('影视库未确认资料更新');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_LIBRARY_UPDATED_EVENT));
  return result.item;
}
