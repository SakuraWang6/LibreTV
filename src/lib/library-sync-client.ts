'use client';

import type { SyncCacheTask, SyncStatus } from './library-sync/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('暂时无法连接同步服务，本地视频仍可播放');
  }
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 401 ? '请验证后使用服务器片库' : result.error || '同步操作失败，请稍后重试');
  return result;
}

export async function fetchLibrarySync(): Promise<SyncStatus> {
  const result = await request<SyncStatus>('/api/library-sync');
  if (typeof result?.enabled !== 'boolean' || !Array.isArray(result.catalog) || !Array.isArray(result.progressConflicts)) throw new Error('同步服务返回异常，本地视频仍可播放');
  return result;
}

export async function cacheServerVideo(itemId: string): Promise<SyncCacheTask> {
  const result = await request<{ task: SyncCacheTask }>('/api/library-sync/cache', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId }),
  });
  if (!result.task?.id) throw new Error('未能确认缓存任务，请刷新服务器片库检查');
  return result.task;
}

export async function resolveLibraryProgress(itemId: string, choice: 'local' | 'server'): Promise<void> {
  await request('/api/library-sync/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, choice }),
  });
}
