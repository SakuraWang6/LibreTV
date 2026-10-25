import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LibraryError, validateLibraryMetadata } from '@/lib/local-library/server';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { withFileLock } from '@/lib/local-library/file-lock';
import { parseMediaContext } from '@/lib/media-context';
import type { BackgroundDownloadTask, BackgroundDownloadsResponse } from './types';
import type { LibraryMetadata } from '@/lib/local-library/types';
import type { QuarkFileReference } from '@/lib/quark/types';

export interface StoredTask extends BackgroundDownloadTask { version: 1; idempotencyKey?: string; uploadId?: string; cancelRequested?: boolean; pauseRequested?: boolean; quark?: QuarkFileReference }
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
    if (task.provider !== undefined && task.provider !== 'quark') throw new LibraryError('下载记录的提供方不可用', 409);
    if (task.provider === 'quark' || task.quark !== undefined) {
      if (task.provider !== 'quark' || task.mediaContext !== undefined) throw new LibraryError('下载记录的夸克引用不可用', 409);
      const reference = quarkReference(task.quark);
      if (task.url !== publicQuarkUrl(reference.shareUrl)) throw new LibraryError('下载记录的夸克地址不匹配', 409);
      task.quark = reference;
    }
    return task;
  } finally { await handle.close(); }
}

async function readAllStoredTasks(): Promise<StoredTask[]> {
  const directory = await downloadsRoot();
  const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  const entries = await Promise.all(names.map((name) => readTask(name.slice(0, 32)).catch(() => null)));
  return entries.filter((entry): entry is StoredTask => !!entry).sort((a, b) => a.createdAt - b.createdAt);
}

export async function allStoredTasks(): Promise<StoredTask[]> {
  return storeLock('queue', readAllStoredTasks);
}

/** A short cross-process lock protects API/worker read-modify-write operations. */
async function storeLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(await downloadsRoot(), `${name}.lock`), action);
}

export async function mutateTask(id: string, change: (task: StoredTask) => StoredTask | void | Promise<StoredTask | void>): Promise<StoredTask> {
  taskId(id);
  return storeLock(id, async () => {
    const current = await readTask(id);
    const next = (await change(current)) ?? current;
    next.updatedAt = Date.now();
    await atomicJson(path.join(await downloadsRoot(), `${id}.json`), next);
    return next;
  });
}

export function publicTask(task: StoredTask): BackgroundDownloadTask {
  const { id, url, provider, mediaContext, title, format, metadata, status, finished, total, bytes, error, libraryItemId, createdAt, updatedAt } = task;
  return { id, url, provider, mediaContext, title, format, metadata, status, finished, total, bytes, error, libraryItemId, createdAt, updatedAt };
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
  if (data.provider !== undefined || data.quark !== undefined) throw new LibraryError('网盘下载必须通过专用导入接口创建');
  let mediaContext;
  try { mediaContext = parseMediaContext(data.mediaContext); } catch { throw new LibraryError('不支持的媒体来源上下文'); }
  if (data.headers !== undefined || data.cookie !== undefined || data.Cookie !== undefined) throw new LibraryError('下载任务不支持自定义请求头或 Cookie');
  let parsed: URL;
  try { parsed = new URL(data.url); } catch { throw new LibraryError('视频地址格式不正确'); }
  if (parsed.username || parsed.password) throw new LibraryError('视频地址不能包含登录凭据');
  const allowed = await checkUpstreamAllowed(data.url);
  if (!allowed.ok) throw new LibraryError('视频地址必须指向公网 HTTP/HTTPS 媒体');
  const metadata = validateLibraryMetadata(data.metadata ?? { title: data.title, kind: 'movie' });
  return storeDownload({ url: parsed.href, metadata, ...(mediaContext ? { mediaContext } : {}) }, data.idempotencyKey);
}

function publicQuarkUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new LibraryError('夸克分享地址格式不正确'); }
  if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || url.port || url.username || url.password || !/^\/s\/[a-zA-Z0-9_-]{1,128}\/?$/.test(url.pathname)) {
    throw new LibraryError('仅支持夸克网盘分享地址');
  }
  return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
}

function quarkReference(value: unknown): QuarkFileReference {
  const input = value as Partial<QuarkFileReference> | null;
  if (!input || typeof input.shareUrl !== 'string' || input.shareUrl.length > 8192
    || Object.keys(input).some((key) => !['shareUrl', 'fileId', 'name', 'size', 'accountKey'].includes(key))
    || typeof input.fileId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(input.fileId)
    || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 1024 || /[\x00-\x1f\x7f]/.test(input.name)
    || typeof input.accountKey !== 'string' || !/^[a-f0-9]{64}$/.test(input.accountKey)
    || typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new LibraryError('夸克文件引用不可用');
  }
  publicQuarkUrl(input.shareUrl);
  return { shareUrl: input.shareUrl, fileId: input.fileId, name: input.name, size: input.size, accountKey: input.accountKey };
}

/** Trusted server-only entry: caller resolves a real file before enqueueing. */
export async function enqueueQuarkDownload(input: { reference: QuarkFileReference; metadata: LibraryMetadata; idempotencyKey?: string }): Promise<{ task: BackgroundDownloadTask }> {
  const { tasks } = await enqueueQuarkDownloads([input]);
  return { task: tasks[0] };
}

export async function enqueueQuarkDownloads(inputs: Parameters<typeof enqueueQuarkDownload>[0][]): Promise<{ tasks: BackgroundDownloadTask[] }> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw new LibraryError('请选择 1–100 个视频文件');
  // Validate every selected file before acquiring or writing to the queue.
  const entries = inputs.map((input) => {
    const reference = quarkReference(input.reference);
    return {
      url: publicQuarkUrl(reference.shareUrl), provider: 'quark' as const, quark: reference,
      metadata: validateLibraryMetadata(input.metadata), key: validIdempotencyKey(input.idempotencyKey),
    };
  });
  return storeLock('queue', async () => {
    const existing = await readAllStoredTasks();
    const byKey = new Map(existing.filter((task) => task.idempotencyKey !== undefined).map((task) => [task.idempotencyKey!, task]));
    const created: StoredTask[] = [];
    const tasks = entries.map(({ key, ...entry }) => {
      const match = key ? byKey.get(key) : undefined;
      if (match) return match;
      const task: StoredTask = {
        version: 1, id: crypto.randomBytes(16).toString('hex'), ...entry, title: entry.metadata.title, format: 'MP4',
        status: 'queued', finished: 0, total: 0, bytes: 0, createdAt: Date.now(), updatedAt: Date.now(), ...(key ? { idempotencyKey: key } : {}),
      };
      created.push(task);
      if (key) byKey.set(key, task);
      return task;
    });
    if (existing.length + created.length > 200) throw new LibraryError('下载记录已满，请先清理已完成的记录', 409);
    const root = await downloadsRoot();
    try {
      for (const task of created) await atomicJson(path.join(root, `${task.id}.json`), task);
    } catch (error) {
      // Queue readers share this lock, so none can observe or start a partial
      // batch before a write failure has rolled its new records back.
      await Promise.all(created.map((task) => fs.rm(path.join(root, `${task.id}.json`), { force: true })));
      throw error;
    }
    return { tasks: tasks.map(publicTask) };
  });
}

function validIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200 || !value) throw new LibraryError('无效的请求编号');
  return value;
}

async function storeDownload(input: Pick<StoredTask, 'url' | 'metadata' | 'mediaContext' | 'provider' | 'quark'>, idempotencyKey: unknown): Promise<{ task: BackgroundDownloadTask }> {
  const key = validIdempotencyKey(idempotencyKey);
  return storeLock('queue', async () => {
    const existing = await readAllStoredTasks();
    const match = key ? existing.find((task) => task.idempotencyKey === key) : undefined;
    if (match) return { task: publicTask(match) };
    if (existing.length >= 200) throw new LibraryError('下载记录已满，请先清理已完成的记录', 409);
    const task: StoredTask = {
      version: 1, id: crypto.randomBytes(16).toString('hex'), ...input, title: input.metadata.title, format: 'MP4',
      status: 'queued', finished: 0, total: 0, bytes: 0, createdAt: Date.now(), updatedAt: Date.now(), ...(key ? { idempotencyKey: key } : {}),
    };
    await atomicJson(path.join(await downloadsRoot(), `${task.id}.json`), task);
    return { task: publicTask(task) };
  });
}

export async function cancelDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status === 'completed' || entry.status === 'cancelled') return;
    entry.cancelRequested = true; entry.pauseRequested = false;
    // The worker owns cleanup. Leave running jobs active until its abort completes.
    if (entry.status === 'queued' || entry.status === 'failed' || entry.status === 'paused') entry.status = 'cancelled';
  });
  return { task: publicTask(task) };
}

export async function pauseDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status === 'completed' || entry.status === 'paused') return;
    if (entry.cancelRequested || entry.status === 'cancelled' || entry.status === 'failed') throw new LibraryError('该任务当前不能暂停', 409);
    entry.pauseRequested = true;
    entry.status = 'paused';
  });
  return { task: publicTask(task) };
}

export async function resumeDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status === 'completed') return;
    if (entry.cancelRequested || entry.status === 'cancelled' || entry.status === 'failed') throw new LibraryError('请重试失败或已取消的任务', 409);
    if (entry.status !== 'paused') return;
    entry.status = 'queued'; entry.pauseRequested = false;
  });
  return { task: publicTask(task) };
}

export async function retryDownload(id: string): Promise<{ task: BackgroundDownloadTask }> {
  const task = await mutateTask(id, (entry) => {
    if (entry.status !== 'failed' && entry.status !== 'cancelled') throw new LibraryError('只能重试失败或已取消的任务', 409);
    entry.status = 'queued'; entry.cancelRequested = false; entry.pauseRequested = false; delete entry.error;
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
