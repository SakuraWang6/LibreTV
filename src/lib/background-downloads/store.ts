import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LibraryError, validateLibraryMetadata } from '@/lib/local-library/server';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { withFileLock } from '@/lib/local-library/file-lock';
import { parseMediaContext } from '@/lib/media-context';
import type { BackgroundDownloadTask, BackgroundDownloadsResponse } from './types';

export interface StoredTask extends BackgroundDownloadTask { version: 1; idempotencyKey?: string; uploadId?: string; cancelRequested?: boolean }
const ID = /^[a-f0-9]{32}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function downloadsEnabled(): boolean {
  return !!process.env.LOCAL_LIBRARY_DIR?.trim() && process.env.BACKGROUND_DOWNLOADS_ENABLED !== '0';
}

export async function downloadsRoot(): Promise<string> {
  if (!downloadsEnabled()) throw new LibraryError('后台下载未开启', 503);
  const configured = process.env.LOCAL_LIBRARY_DIR!.trim();
  if (!path.isAbsolute(configured)) throw new LibraryError('影视库目录必须使用绝对路径', 503);
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(configured);
  let directory = root;
  for (const part of ['.libretv', 'background']) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('后台下载目录包含不安全的链接', 409);
  }
  return directory;
}

export function taskId(id: string): string {
  if (!ID.test(id)) throw new LibraryError('无效的下载任务编号', 404);
  return id;
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readTask(id: string): Promise<StoredTask> {
  const file = path.join(await downloadsRoot(), `${taskId(id)}.json`);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > 128 * 1024) throw new LibraryError('下载记录过大', 409);
    const task = JSON.parse(await handle.readFile('utf8')) as StoredTask;
    if (task.version !== 1 || task.id !== id) throw new LibraryError('下载记录不可用', 409);
    try { parseMediaContext(task.mediaContext); } catch { throw new LibraryError('下载记录的来源上下文不可用', 409); }
    return task;
  } finally { await handle.close(); }
}

export async function allStoredTasks(): Promise<StoredTask[]> {
  const directory = await downloadsRoot();
  const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  const entries = await Promise.all(names.map((name) => readTask(name.slice(0, 32)).catch(() => null)));
  return entries.filter((entry): entry is StoredTask => !!entry).sort((a, b) => a.createdAt - b.createdAt);
}

/** A short cross-process lock protects API/worker read-modify-write operations. */
async function storeLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(await downloadsRoot(), `${name}.lock`), action);
}

export async function mutateTask(id: string, change: (task: StoredTask) => StoredTask | void): Promise<StoredTask> {
  taskId(id);
  return storeLock(id, async () => {
    const current = await readTask(id);
    const next = change(current) ?? current;
    next.updatedAt = Date.now();
    await atomicJson(path.join(await downloadsRoot(), `${id}.json`), next);
    return next;
  });
}

export function publicTask(task: StoredTask): BackgroundDownloadTask {
  const { id, url, mediaContext, title, format, metadata, status, finished, total, bytes, error, libraryItemId, createdAt, updatedAt } = task;
  return { id, url, mediaContext, title, format, metadata, status, finished, total, bytes, error, libraryItemId, createdAt, updatedAt };
}

export async function listDownloads(): Promise<BackgroundDownloadsResponse> {
  if (!downloadsEnabled()) return { enabled: false, workerOnline: false, tasks: [] };
  let workerOnline = false;
  try {
    const heartbeat = await fs.stat(path.join(await downloadsRoot(), 'worker-heartbeat'));
    workerOnline = Date.now() - heartbeat.mtimeMs < 30_000;
  } catch { /* Worker may be starting. Queue remains durable. */ }
  return { enabled: true, workerOnline, tasks: (await allStoredTasks()).reverse().map(publicTask) };
}

export async function enqueueDownload(body: unknown): Promise<{ task: BackgroundDownloadTask }> {
  const data = body as Record<string, unknown> | null;
  if (!data || typeof data.url !== 'string' || data.url.length > 8192) throw new LibraryError('缺少有效的视频地址');
  let mediaContext;
  try { mediaContext = parseMediaContext(data.mediaContext); } catch { throw new LibraryError('不支持的媒体来源上下文'); }
  if (data.headers !== undefined || data.cookie !== undefined || data.Cookie !== undefined) throw new LibraryError('下载任务不支持自定义请求头或 Cookie');
  let parsed: URL;
  try { parsed = new URL(data.url); } catch { throw new LibraryError('视频地址格式不正确'); }
  if (parsed.username || parsed.password) throw new LibraryError('视频地址不能包含登录凭据');
  const allowed = await checkUpstreamAllowed(data.url);
  if (!allowed.ok) throw new LibraryError('视频地址必须指向公网 HTTP/HTTPS 媒体');
  const metadata = validateLibraryMetadata(data.metadata ?? { title: data.title, kind: 'movie' });
  let key: string | undefined;
  if (data.idempotencyKey !== undefined) {
    if (typeof data.idempotencyKey !== 'string' || data.idempotencyKey.length > 200 || !data.idempotencyKey) throw new LibraryError('无效的请求编号');
    key = data.idempotencyKey;
  }
  return storeLock('queue', async () => {
    const existing = await allStoredTasks();
    const match = key ? existing.find((task) => task.idempotencyKey === key) : undefined;
    if (match) return { task: publicTask(match) };
    if (existing.length >= 200) throw new LibraryError('下载记录已满，请先清理已完成的记录', 409);
    const task: StoredTask = {
      version: 1, id: crypto.randomBytes(16).toString('hex'), url: parsed.href, ...(mediaContext ? { mediaContext } : {}), title: metadata.title, metadata, format: 'MP4',
      status: 'queued', finished: 0, total: 0, bytes: 0, createdAt: Date.now(), updatedAt: Date.now(), ...(key ? { idempotencyKey: key } : {}),
    };
    await atomicJson(path.join(await downloadsRoot(), `${task.id}.json`), task);
    return { task: publicTask(task) };
  });
}

export async function cancelDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status === 'completed' || entry.status === 'cancelled') return;
    entry.cancelRequested = true;
    // The worker owns cleanup. Leave running jobs active until its abort completes.
    if (entry.status === 'queued' || entry.status === 'failed') entry.status = 'cancelled';
  });
  return { task: publicTask(task) };
}

export async function retryDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status !== 'failed' && entry.status !== 'cancelled') throw new LibraryError('只能重试失败或已取消的任务', 409);
    entry.status = 'queued'; entry.cancelRequested = false; delete entry.error;
  });
  return { task: publicTask(task) };
}

export async function deleteDownload(id: string): Promise<{ deleted: true }> {
  taskId(id);
  return storeLock(id, async () => {
    const entry = await readTask(id);
    if (!TERMINAL.has(entry.status)) throw new LibraryError('请先取消正在进行的下载', 409);
    // Clean staging through the worker first; a committed video is never removed.
    if (entry.cancelRequested) throw new LibraryError('后台正在清理临时文件，请稍后重试', 409);
    await fs.rm(path.join(await downloadsRoot(), `${id}.json`));
    await fs.rm(path.join(await downloadsRoot(), 'work', id), { recursive: true, force: true });
    return { deleted: true };
  });
}
