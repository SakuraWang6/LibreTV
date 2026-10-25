'use client';

import type { BackgroundDownloadTask } from './background-downloads/types';
import type { LibraryMetadata } from './local-library/types';

export interface QuarkStatus {
  enabled: boolean;
  connected: boolean;
  accountLabel?: string;
  pending?: boolean;
  error?: string;
}

export interface QuarkLogin { authUrl?: string; pending?: boolean }

export interface QuarkShareEntry {
  id: string;
  name: string;
  size: number;
  isDirectory: boolean;
  downloadable: boolean;
}

export interface QuarkShareListing {
  entries: QuarkShareEntry[];
  folderId: string;
  shareTitle?: string;
  hasMore?: boolean;
}

export const QUARK_STATUS_QUERY_KEY = ['quark-status'] as const;

export function isQuarkShareUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.hostname === 'pan.quark.cn' && /^\/s\/[a-zA-Z0-9]+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Authorization destinations must remain on the official service. */
export function validateQuarkAuthUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('夸克登录地址无效');
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.hostname === 'pan.quark.cn') return url.href;
  } catch { /* Treat malformed URLs exactly like untrusted destinations. */ }
  throw new Error('夸克登录地址无效');
}

async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'same-origin', cache: 'no-store', signal: signal ?? AbortSignal.timeout(60_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('无法连接夸克服务，请稍后重试');
  }
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(response.status === 401 ? '请先登录 LibreTV' : result.error || '夸克操作失败，请稍后重试');
  return result;
}

export async function fetchQuarkStatus(): Promise<QuarkStatus> {
  const status = await request<QuarkStatus>('/api/quark');
  if (typeof status.enabled !== 'boolean' || typeof status.connected !== 'boolean') throw new Error('夸克连接状态异常');
  return status;
}

export async function startQuarkLogin(): Promise<QuarkLogin> {
  const result = await request<QuarkLogin>('/api/quark', { action: 'login' });
  if (result.authUrl) return { authUrl: validateQuarkAuthUrl(result.authUrl), pending: true };
  if (result.pending === true) return { pending: true };
  throw new Error('夸克登录未启动，请重试');
}

export async function checkQuarkLogin(): Promise<QuarkStatus> {
  const status = await request<QuarkStatus>('/api/quark', { action: 'check-login' });
  if (typeof status.enabled !== 'boolean' || typeof status.connected !== 'boolean') throw new Error('夸克连接状态异常');
  return status;
}

export async function completeQuarkLogin(code: string): Promise<QuarkStatus> {
  const normalizedCode = code.trim();
  if (!/^AAC-[a-fA-F0-9]{32}$/.test(normalizedCode)) throw new Error('授权码格式不正确');
  const status = await request<QuarkStatus>('/api/quark', { action: 'complete-login', code: normalizedCode });
  if (typeof status.enabled !== 'boolean' || typeof status.connected !== 'boolean') throw new Error('夸克连接状态异常');
  return {
    enabled: status.enabled, connected: status.connected,
    ...(typeof status.accountLabel === 'string' ? { accountLabel: status.accountLabel } : {}),
    ...(typeof status.pending === 'boolean' ? { pending: status.pending } : {}),
    ...(typeof status.error === 'string' ? { error: status.error } : {}),
  };
}

export async function listQuarkShare(url: string, folderId?: string, signal?: AbortSignal): Promise<QuarkShareListing> {
  if (!isQuarkShareUrl(url)) throw new Error('夸克分享链接无效');
  const result = await request<QuarkShareListing>('/api/quark/share', { url, folderId }, signal);
  if (!Array.isArray(result.entries) || typeof result.folderId !== 'string'
    || !result.entries.every((entry) => typeof entry.id === 'string' && typeof entry.name === 'string'
      && typeof entry.isDirectory === 'boolean' && typeof entry.downloadable === 'boolean')) throw new Error('夸克文件列表异常');
  return result;
}

export async function createQuarkDownloads(url: string, fileIds: string[], metadata: LibraryMetadata, idempotencyKey: string): Promise<BackgroundDownloadTask[]> {
  if (!isQuarkShareUrl(url)) throw new Error('夸克分享链接无效');
  const selected = [...new Set(fileIds)].filter(Boolean);
  if (selected.length === 0) throw new Error('请选择视频');
  // A collection must never inherit the currently playing episode for every file.
  const normalizedMetadata = { ...metadata };
  if (selected.length > 1) { delete normalizedMetadata.episodeNumber; delete normalizedMetadata.episodeTitle; }
  if (normalizedMetadata.kind === 'movie') {
    delete normalizedMetadata.seasonNumber; delete normalizedMetadata.episodeNumber; delete normalizedMetadata.episodeTitle;
  }
  const result = await request<{ tasks: BackgroundDownloadTask[] }>('/api/quark/downloads', {
    url, fileIds: selected, metadata: normalizedMetadata, idempotencyKey,
  });
  if (!Array.isArray(result.tasks) || result.tasks.length === 0 || !result.tasks.every((task) => typeof task.id === 'string')) throw new Error('未确认任务已创建，请先检查下载列表');
  return result.tasks;
}
