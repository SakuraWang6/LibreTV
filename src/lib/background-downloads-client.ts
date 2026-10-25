'use client';

import type { LibraryMetadata } from './local-library/types';
import type { BackgroundDownloadTask, BackgroundDownloadsResponse } from './background-downloads/types';
import type { MediaContext } from './media-context';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('无法连接后台下载服务，请确认 LibreTV 正在运行');
  }
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(response.status === 401 ? '请登录后管理后台下载' : result.error || `后台下载操作失败（HTTP ${response.status}）`);
  }
  return result;
}

export async function fetchBackgroundDownloads(): Promise<BackgroundDownloadsResponse> {
  const result = await request<BackgroundDownloadsResponse>('/api/downloads');
  if (typeof result.enabled !== 'boolean' || !Array.isArray(result.tasks)) throw new Error('后台下载服务返回异常，请稍后重试');
  return result;
}

export async function createBackgroundDownload(url: string, metadata: LibraryMetadata, idempotencyKey = crypto.randomUUID(), mediaContext?: MediaContext): Promise<BackgroundDownloadTask> {
  // Do not retry a creation silently: the same key can safely be reused when migrating an old browser task.
  const result = await request<{ task: BackgroundDownloadTask }>('/api/downloads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, metadata, idempotencyKey, mediaContext }),
  });
  if (!result.task?.id) throw new Error('后台下载未确认创建成功，请先打开下载管理检查任务');
  return result.task;
}

export async function changeBackgroundDownload(id: string, action: 'cancel' | 'retry'): Promise<BackgroundDownloadTask> {
  const result = await request<{ task: BackgroundDownloadTask }>(`/api/downloads/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  if (result.task?.id !== id) throw new Error('后台下载未确认操作结果，请刷新任务列表');
  return result.task;
}

export async function removeBackgroundDownload(id: string): Promise<void> {
  await request(`/api/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
