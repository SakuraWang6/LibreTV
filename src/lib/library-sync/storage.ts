import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LibraryError } from '@/lib/local-library/server';
import type { LibraryEntry } from '@/lib/local-library/types';
import type { SyncCacheTask, SyncProgressConflict } from './types';
import { withFileLock } from '@/lib/local-library/file-lock';

export interface SyncConfig { origin: string; password: string; libraryDirectory: string }
export interface Catalog { version: 1; items: LibraryEntry[]; online: boolean; checkedAt: number; error?: string }
export interface CacheTask extends SyncCacheTask { version: 1; item: LibraryEntry; uploadId: string; createdAt: number; updatedAt: number }
export interface Mapping {
  version: 1; remoteOrigin: string; remoteId: string; localId: string;
  localVersion: string | null; serverVersion: string | null;
  conflict?: SyncProgressConflict;
}

export function syncConfig(): SyncConfig | null {
  const configured = process.env.LIBRARY_SERVER_URL?.trim();
  const password = process.env.LIBRARY_SERVER_PASSWORD;
  const libraryDirectory = process.env.LOCAL_LIBRARY_DIR?.trim();
  if (!configured || !password || !libraryDirectory) return null;
  let url: URL;
  try { url = new URL(configured); } catch { throw new LibraryError('云端影视库地址配置无效', 503); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new LibraryError('云端影视库需要使用不含密码或路径的 HTTPS 地址', 503);
  }
  if (!path.isAbsolute(libraryDirectory)) throw new LibraryError('本地影视库目录必须使用绝对路径', 503);
  return { origin: url.origin, password, libraryDirectory };
}

export function itemId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new LibraryError('无效的云端影视编号', 400);
  return value;
}

export async function syncRoot(config: SyncConfig): Promise<string> {
  await fs.mkdir(config.libraryDirectory, { recursive: true, mode: 0o700 });
  let directory = await fs.realpath(config.libraryDirectory);
  for (const part of ['.libretv', 'sync', crypto.createHash('sha256').update(config.origin).digest('hex').slice(0, 24)]) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('云端缓存目录包含不安全的链接', 409);
  }
  return directory;
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if ((await handle.stat()).size > 16 * 1024 * 1024) throw new LibraryError('云端缓存记录过大', 409);
    return JSON.parse(await handle.readFile('utf8')) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  finally { await handle?.close(); }
}

/** API and daemon share these short, crash-recoverable filesystem locks. */
export async function withLock<T>(root: string, name: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withFileLock(path.join(root, `${name}.lock`), action, signal);
}

export const taskFile = (root: string, id: string) => path.join(root, `task-${itemId(id)}.json`);
export const mappingFile = (root: string, id: string) => path.join(root, `mapping-${itemId(id)}.json`);

export async function allTasks(root: string): Promise<CacheTask[]> {
  const names = (await fs.readdir(root)).filter((name) => /^task-[a-f0-9]{32}\.json$/.test(name));
  const tasks = await Promise.all(names.map((name) => readJson<CacheTask>(path.join(root, name))));
  return tasks.filter((task): task is CacheTask => !!task && task.version === 1).sort((a, b) => a.createdAt - b.createdAt);
}

export async function allMappings(root: string): Promise<Mapping[]> {
  const names = (await fs.readdir(root)).filter((name) => /^mapping-[a-f0-9]{32}\.json$/.test(name));
  const mappings = await Promise.all(names.map((name) => readJson<Mapping>(path.join(root, name))));
  return mappings.filter((mapping): mapping is Mapping => !!mapping && mapping.version === 1);
}

export function publicTask(task: CacheTask): SyncCacheTask {
  const { id, itemId: remoteId, status, progress, error } = task;
  return { id, itemId: remoteId, status, progress, ...(error ? { error } : {}) };
}
