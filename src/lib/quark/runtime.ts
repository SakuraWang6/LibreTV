import fsSync, { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { LibraryError } from '@/lib/local-library/server';

const TRUSTED_FILES: Record<string, string> = {
  'scripts/quark-drive.cjs': 'b19755822486bd812c76e15de31e9213bccfa2cc6ed1e639c43201e5cf2e07b5',
  'scripts/hash-worker.cjs': 'b0d886c4835af1cd426cf7519a267d7db7311d403984a965d07e2227de7a40a2',
  'isolate.cjs': '5427cdd2686568a3b6ae8977396e1336d7a29dcad55ee8e29eea5468cd389e6b',
};
const MAX_JSON = 2 * 1024 * 1024;
const BUSY = '夸克正在执行其他任务，请稍后重试';
const AUTH_CODE_FAILED = '授权码无效或已过期，请重新登录';
const AUTH_WAIT_FAILED = '授权未完成或已超时，请重新点击登录夸克';
const HOST = os.hostname();
type JsonObject = Record<string, unknown>;
export interface QuarkStatus { enabled: boolean; connected: boolean; pending: boolean; accountLabel?: string; error?: string }
export interface QuarkCommandResult { data: JsonObject; code: number; msg: string; records?: JsonObject[] }
export interface QuarkCommandOptions {
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => Promise<void> | void;
  timeoutMs?: number;
}
export interface QuarkDownloadRecord { recordId: string; fid: string; fileName: string; fileSize: number; state: string }
interface Owner { pid: number; hostname: string; token: string; childPid?: number }
interface Lease { directory: string; owner: Owner; release(): Promise<void> }
interface CachedStatus { version: 1; connected: boolean; pending: boolean; accountLabel?: string; error?: string; updatedAt: string }

function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value); }
function accountHash(userId: string): string { return crypto.createHash('sha256').update(`libretv-quark-account:${userId}`).digest('hex'); }

export function quarkPrivateRoot(): string {
  const root = process.env.QUARK_RUNTIME_DIR;
  if (!root || !path.isAbsolute(root) || root.includes('\0')) throw new LibraryError('夸克组件未配置', 503);
  return path.resolve(root);
}

function trusted(root: string): boolean {
  const rootStat = fsSync.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  const scriptsStat = fsSync.lstatSync(path.join(root, 'scripts'));
  if (!scriptsStat.isDirectory() || scriptsStat.isSymbolicLink()) return false;
  for (const [relative, digest] of Object.entries(TRUSTED_FILES)) {
    const target = path.join(root, relative);
    const stat = fsSync.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON) return false;
    if (crypto.createHash('sha256').update(fsSync.readFileSync(target)).digest('hex') !== digest) return false;
  }
  return true;
}

export function quarkConfigured(): boolean {
  try { return trusted(quarkPrivateRoot()); } catch { return false; }
}

async function directory(root: string, relative = ''): Promise<string> {
  const target = path.join(root, relative);
  let current = root;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('夸克私密目录不可用', 503);
    await fs.chmod(current, 0o700);
  }
  return target;
}

async function readJson(target: string, maximum = MAX_JSON): Promise<JsonObject | undefined> {
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new LibraryError('夸克私密记录不可用', 503);
    await handle.chmod(0o600);
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    return object(value) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error instanceof LibraryError ? error : new LibraryError('夸克私密记录不可用', 503);
  } finally { await handle?.close(); }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${crypto.randomBytes(12).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.rename(temporary, target);
  } finally { await handle?.close(); await fs.rm(temporary, { force: true }); }
}

function safeMessage(value: unknown): string {
  if (typeof value !== 'string') return '夸克请求未完成，请稍后重试';
  if (/download\s+file\s+size\s+limit\[/i.test(value)) {
    const matched = /download\s+file\s+size\s+limit\[(\d{1,16})\]/i.exec(value);
    const bytes = matched ? Number(matched[1]) : 0;
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 1024 ** 4) {
      const limit = bytes >= 1024 ** 2 ? `${Number((bytes / 1024 ** 2).toFixed(2))} MiB` : `${bytes} 字节`;
      return `夸克当前下载接口限制单个文件不超过 ${limit}`;
    }
    return '夸克当前下载接口限制单个文件大小';
  }
  if (/capacity\s*limit|空间不足|32003/i.test(value)) return '夸克网盘可用空间不足，无法转存所选视频';
  if (/access.?token|refresh.?token|client.?token|share_fid_token|stoken|authorization|cookie|agent_auth_code|signature|\b(?:token|secret|password)\b/i.test(value)) return '夸克授权已失效，请重新连接账号';
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[链接]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s，。；：,;"'<>]+/g, '[路径]')
    .replace(/[A-Za-z0-9+/_=-]{24,}/g, '[已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180).trim() || '夸克请求未完成，请稍后重试';
}

async function cache(root: string, value: Omit<CachedStatus, 'version' | 'updatedAt'>): Promise<void> {
  await writeJson(path.join(root, 'status.json'), { version: 1, ...value, updatedAt: new Date().toISOString() });
}

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

async function lockOwner(lockDirectory: string): Promise<Owner | undefined> {
  const stat = await fs.lstat(lockDirectory).catch(() => undefined);
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('夸克任务锁不可用', 503);
  const value = await readJson(path.join(lockDirectory, 'owner.json'), 4096);
  if (!value || typeof value.token !== 'string' || !/^[a-f0-9]{48}$/.test(value.token) || typeof value.hostname !== 'string' || !value.hostname || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1) return undefined;
  if (value.childPid !== undefined && (!Number.isSafeInteger(value.childPid) || (value.childPid as number) < 1)) return undefined;
  return value as unknown as Owner;
}

function dead(owner: Owner | undefined): boolean {
  return !!owner && owner.hostname === HOST && !alive(owner.pid) && !alive(owner.childPid);
}

async function acquire(root: string): Promise<Lease> {
  const lockDirectory = path.join(root, '.command-lock');
  const owner: Owner = { pid: process.pid, hostname: HOST, token: crypto.randomBytes(24).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      try { await writeJson(path.join(lockDirectory, 'owner.json'), owner); }
      catch (error) { await fs.rm(lockDirectory, { recursive: true, force: true }); throw error; }
      return {
        directory: lockDirectory, owner,
        async release() {
          if ((await lockOwner(lockDirectory))?.token === owner.token) await fs.rm(lockDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!dead(await lockOwner(lockDirectory))) throw new LibraryError(BUSY, 409);
      // A separate, short recovery guard prevents two contenders from moving
      // a fresh owner's directory after reading the same dead owner.
      const recovery = path.join(root, '.command-recovery');
      try { await fs.mkdir(recovery, { mode: 0o700 }); }
      catch { throw new LibraryError(BUSY, 409); }
      try {
        if (!dead(await lockOwner(lockDirectory))) throw new LibraryError(BUSY, 409);
        const quarantine = path.join(root, `.command-dead-${owner.token}`);
        await fs.rename(lockDirectory, quarantine);
        await fs.rm(quarantine, { recursive: true, force: true });
      } finally { await fs.rm(recovery, { recursive: true, force: true }); }
    }
  }
  throw new LibraryError(BUSY, 409);
}

export async function quarkStatus(): Promise<QuarkStatus> {
  if (!quarkConfigured()) return { enabled: false, connected: false, pending: false };
  const root = quarkPrivateRoot();
  try {
    const stored = await readJson(path.join(root, 'status.json'), 8192);
    const owner = stored?.pending ? await lockOwner(path.join(root, '.command-lock')) : undefined;
    const pending = stored?.pending === true && !!owner && (alive(owner.pid) || alive(owner.childPid));
    return {
      enabled: true, connected: stored?.connected === true, pending,
      ...(typeof stored?.accountLabel === 'string' ? { accountLabel: safeMessage(stored.accountLabel).slice(0, 48) } : {}),
      ...(typeof stored?.error === 'string' ? { error: safeMessage(stored.error) } : stored?.pending && !pending ? { error: '上次授权未完成，请重新连接' } : {}),
    };
  } catch { return { enabled: true, connected: false, pending: false, error: '夸克状态暂时不可用' }; }
}

export async function quarkAccountKey(): Promise<string> {
  if (!quarkConfigured()) throw new LibraryError('夸克组件未就绪', 503);
  await directory(quarkPrivateRoot(), 'codex');
  const config = await readJson(path.join(quarkPrivateRoot(), 'codex/config.json'));
  const auth = object(config?.agent_auth) && object(config.agent_auth.codex) ? config.agent_auth.codex : undefined;
  const userId = auth?.userId;
  if (typeof userId !== 'string' || !userId || userId.length > 512) throw new LibraryError('请先连接夸克账号', 401);
  return accountHash(userId);
}

function downloadAccount(storage: JsonObject, accountKey: string): string | undefined {
  if (!/^[a-f0-9]{64}$/.test(accountKey)) throw new LibraryError('夸克下载账号记录无效', 409);
  const prefix = 'qkop_qkop_download_index_';
  // Locate exactly the queued account's local index. Authorization/config may
  // already have been removed; cleanup must never need another login.
  const candidates = Object.keys(storage).filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length))
    .filter((userId) => userId && userId.length <= 512 && accountHash(userId) === accountKey);
  if (candidates.length > 1) throw new LibraryError('夸克下载账号记录不唯一，未修改', 409);
  return candidates[0];
}

function parseStored(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 8 * 1024 * 1024) throw new LibraryError('夸克续传记录不可用', 409);
  try { return JSON.parse(value); } catch { throw new LibraryError('夸克续传记录不可用', 409); }
}

function downloadIndex(storage: JsonObject, indexKey: string): QuarkDownloadRecord[] {
  if (storage[indexKey] === undefined) return [];
  const index = parseStored(storage[indexKey]);
  if (!Array.isArray(index) || index.length > 500) throw new LibraryError('夸克续传记录不可用', 409);
  return index.map((value: unknown) => {
    if (!object(value) || typeof value.recordId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.recordId)
      || typeof value.fid !== 'string' || !value.fid || value.fid.length > 2048
      || typeof value.fileName !== 'string' || value.fileName.length > 512
      || typeof value.fileSize !== 'number' || !Number.isSafeInteger(value.fileSize) || value.fileSize < 0
      || typeof value.state !== 'string' || !['pending', 'downloading', 'paused', 'failed', 'completed', 'cancelled'].includes(value.state)) {
      throw new LibraryError('夸克续传记录不可用', 409);
    }
    return { recordId: value.recordId, fid: value.fid, fileName: value.fileName, fileSize: value.fileSize, state: value.state };
  });
}

async function localDownloads<T>(accountKey: string, action: (root: string, storage: JsonObject, userId?: string) => Promise<T>): Promise<T> {
  const root = await prepare();
  const lease = await acquire(root);
  try {
    await directory(root, 'codex/download');
    const storage = await readJson(path.join(root, 'codex/download/storage.json'), 8 * 1024 * 1024) ?? {};
    return await action(root, storage, downloadAccount(storage, accountKey));
  } finally { await lease.release(); }
}

/** Read only local pause records, even when the provider is offline. */
export async function listQuarkDownloadRecords(accountKey: string): Promise<QuarkDownloadRecord[]> {
  return localDownloads(accountKey, async (_root, storage, userId) => {
    if (!userId) return [];
    // The SDK's qkop_download_* keys are prefixed again by NodeStorageAdapter.
    return downloadIndex(storage, `qkop_qkop_download_index_${userId}`);
  });
}

/** Remove one local checkpoint only; never contacts or deletes cloud files. */
export async function deleteQuarkDownloadRecord(accountKey: string, recordId: string, savedFileId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordId) || !savedFileId || savedFileId.length > 2048 || /[\u0000-\u001f]/.test(savedFileId)) throw new LibraryError('夸克续传任务编号无效', 409);
  return localDownloads(accountKey, async (root, storage, userId) => {
    if (!userId) return;
    const target = path.join(root, 'codex/download/storage.json');
    const indexKey = `qkop_qkop_download_index_${userId}`;
    const checkpointKey = `qkop_qkop_download_checkpoint_${userId}_${recordId}`;
    const index = downloadIndex(storage, indexKey);
    const matching = index.filter((record) => record.recordId === recordId);
    if (matching.length > 1 || matching.some((record) => record.fid !== savedFileId)) throw new LibraryError('夸克续传记录与影片不匹配，未删除', 409);
    const rawCheckpoint = storage[checkpointKey];
    if (rawCheckpoint !== undefined) {
      const checkpoint = parseStored(rawCheckpoint);
      if (!object(checkpoint) || checkpoint.fid !== savedFileId) throw new LibraryError('夸克续传记录与影片不匹配，未删除', 409);
    }
    if (!matching.length && rawCheckpoint === undefined) return;
    const updated = { ...storage };
    // Preserve the original index objects, including SDK timestamps and fields
    // unused by LibreTV. Other users and unrelated records remain untouched.
    const original = storage[indexKey] === undefined ? [] : parseStored(storage[indexKey]) as JsonObject[];
    updated[indexKey] = JSON.stringify(original.filter((record) => record.recordId !== recordId));
    delete updated[checkpointKey];
    await writeJson(target, updated);
  });
}

async function prepare(): Promise<string> {
  if (!quarkConfigured()) throw new LibraryError('夸克组件未就绪', 503);
  const root = quarkPrivateRoot();
  for (const relative of ['', 'scripts', 'private-home', 'cwd', 'tmp', 'codex']) await directory(root, relative);
  return root;
}

function validateArgs(args: string[]): void {
  const commands = new Set(['login', 'get-user-info', 'share-detail', 'share-search', 'create-folder', 'saveas', 'browse', 'download']);
  if (!args.length || !commands.has(args[0]) || args.length > 30 || args.some((value) => typeof value !== 'string' || value.length > 8192 || value.includes('\0')) || args.some((value) => /^--(?:session-input|raw-query|token|verbose)(?:=|$)/.test(value))) {
    throw new LibraryError('不支持的夸克操作', 400);
  }
}

async function execute(root: string, lease: Lease, args: string[], options: QuarkCommandOptions, authCode?: string): Promise<QuarkCommandResult> {
  options.signal?.throwIfAborted();
  if (authCode !== undefined && (args.length !== 1 || args[0] !== 'login' || !/^AAC-[a-f0-9]{32}$/i.test(authCode))) throw new LibraryError(AUTH_CODE_FAILED, 400);
  if (!trusted(root)) throw new LibraryError('夸克组件校验失败', 503);
  const isDownload = args[0] === 'download' && !['list', 'delete'].includes(args[1]);
  const timeout = options.timeoutMs ?? (isDownload ? 24 * 60 * 60_000 : args[0] === 'saveas' ? 16 * 60_000 : 90_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 24 * 60 * 60_000) throw new LibraryError('夸克任务超时配置无效', 500);
  return new Promise<QuarkCommandResult>((resolve, reject) => {
    let child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
    try {
      child = spawn(process.execPath, ['--require', path.join(root, 'isolate.cjs'), path.join(root, 'scripts/quark-drive.cjs'), ...args], {
        cwd: path.join(root, 'cwd'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: {
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          NODE_ENV: 'production', LANG: 'zh_CN.UTF-8', AI_AGENT: 'codex', TMPDIR: path.join(root, 'tmp'),
          LIBRETV_QUARK_PRIVATE_HOME: path.join(root, 'private-home'),
          LIBRETV_QUARK_LOCK_DIR: lease.directory, LIBRETV_QUARK_LOCK_TOKEN: lease.owner.token,
          ...(authCode ? { LIBRETV_QUARK_AUTH_STDIN: '1' } : {}),
        },
      });
      child.once('error', () => undefined);
      child.stdin.on('error', () => undefined);
      if (!child.pid) throw new Error('spawn failed');
      lease.owner.childPid = child.pid;
      // Register before the preload lets official code start. A surviving
      // child remains an owner even if its web/worker parent has exited.
      const temporary = path.join(lease.directory, `owner-${lease.owner.token}.tmp`);
      fsSync.writeFileSync(temporary, JSON.stringify(lease.owner), { mode: 0o600, flag: 'wx' });
      fsSync.renameSync(temporary, path.join(lease.directory, 'owner.json'));
      child.stdin.end(authCode ?? '');
    } catch {
      child?.kill('SIGKILL');
      reject(new LibraryError('无法启动夸克任务', 503)); return;
    }
    const processChild = child;
    let buffer = '', result: JsonObject | undefined, failure: Error | undefined;
    const decoder = new StringDecoder('utf8');
    const records: JsonObject[] = [];
    let progress = Promise.resolve();
    let hardStop: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      processChild.kill('SIGINT');
      hardStop = setTimeout(() => processChild.kill('SIGKILL'), 5000);
      hardStop.unref();
    };
    const aborted = () => stop(new DOMException('夸克任务已停止', 'AbortError'));
    const timer = setTimeout(() => stop(new LibraryError('夸克任务等待超时，请重试', 504)), timeout);
    timer.unref();
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) aborted();
    const consume = (line: string) => {
      if (!line.trim()) return;
      let value: unknown;
      try { value = JSON.parse(line); } catch { stop(new LibraryError('夸克返回了无效结果', 502)); return; }
      if (!object(value)) { stop(new LibraryError('夸克返回了无效结果', 502)); return; }
      if (value.type === 'result') result = value;
      if (value.type === 'list' && object(value.data)) {
        if (records.length >= 500) { stop(new LibraryError('夸克任务记录过多', 502)); return; }
        records.push(value.data);
      }
      if (value.type === 'progress' && object(value.data)) {
        const { current, total } = value.data;
        if (typeof current === 'number' && typeof total === 'number' && Number.isSafeInteger(current) && Number.isSafeInteger(total) && current >= 0 && total >= current) {
          progress = progress.then(() => options.onProgress?.(current, total)).catch((error: unknown) => stop(error instanceof Error ? error : new LibraryError('无法保存夸克下载进度', 503)));
        }
      }
    };
    processChild.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_JSON) { stop(new LibraryError('夸克返回结果过大', 502)); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    // Official diagnostic output may contain account or signed URL details.
    processChild.stderr.resume();
    processChild.once('error', () => stop(new LibraryError('夸克任务启动失败', 503)));
    processChild.once('close', (exitCode) => {
      clearTimeout(timer); if (hardStop) clearTimeout(hardStop);
      options.signal?.removeEventListener('abort', aborted);
      buffer += decoder.end();
      if (buffer.trim()) consume(buffer);
      if (hardStop) clearTimeout(hardStop);
      void progress.then(async () => {
        if (failure) { reject(failure); return; }
        const code = result?.code;
        if (exitCode !== 0 || typeof code !== 'number' || code !== 0) {
          const message = authCode ? AUTH_CODE_FAILED : args[0] === 'login' ? AUTH_WAIT_FAILED : safeMessage(result?.msg);
          const status = /授权|登录|认证/.test(message) ? 401 : 502;
          if (status === 401) await cache(root, { connected: false, pending: false, error: message });
          reject(new LibraryError(message, status)); return;
        }
        const data = object(result?.data) ? result.data : {};
        if (args[0] === 'get-user-info') {
          const nickname = object(data.userInfo) && typeof data.userInfo.nickname === 'string' ? safeMessage(data.userInfo.nickname).slice(0, 48) : '夸克账号';
          await cache(root, { connected: true, pending: false, accountLabel: nickname });
        }
        resolve({ data, code, msg: safeMessage(result?.msg), ...(records.length ? { records } : {}) });
      }).catch(() => reject(new LibraryError('无法保存夸克任务结果', 503)));
    });
  });
}

export async function runQuarkCommand(args: string[], options: QuarkCommandOptions = {}): Promise<QuarkCommandResult> {
  validateArgs(args);
  const root = await prepare();
  const lease = await acquire(root);
  try { return await execute(root, lease, args, options); }
  finally { await lease.release(); }
}

export async function startQuarkLogin(): Promise<QuarkStatus> {
  if (process.platform !== 'darwin') throw new LibraryError('请在 Mac 本机连接夸克账号', 403);
  const root = await prepare();
  const current = await quarkStatus();
  if (current.pending || current.connected) return current;
  const lease = await acquire(root);
  try { await cache(root, { connected: false, pending: true }); }
  catch { await lease.release(); throw new LibraryError('无法保存夸克授权状态', 503); }
  void execute(root, lease, ['login'], { timeoutMs: 90_000 }).then(async () => {
    await cache(root, { connected: true, pending: false, accountLabel: '夸克账号' });
  }).catch(async () => {
    await cache(root, { connected: false, pending: false, error: AUTH_WAIT_FAILED });
  }).finally(() => lease.release()).catch(() => undefined);
  return { enabled: true, connected: false, pending: true };
}

/** Complete the same official browser grant after its short CLI poll expired. */
export async function completeQuarkLogin(code: string): Promise<QuarkStatus> {
  if (typeof code !== 'string' || !/^AAC-[a-f0-9]{32}$/i.test(code)) throw new LibraryError(AUTH_CODE_FAILED, 400);
  if (process.platform !== 'darwin') throw new LibraryError('请在 Mac 本机连接夸克账号', 403);
  const root = await prepare();
  const lease = await acquire(root);
  try {
    await execute(root, lease, ['login'], { timeoutMs: 90_000 }, code);
    await cache(root, { connected: true, pending: false, accountLabel: '夸克账号' });
    return { enabled: true, connected: true, pending: false, accountLabel: '夸克账号' };
  } catch {
    await cache(root, { connected: false, pending: false, error: AUTH_CODE_FAILED }).catch(() => undefined);
    throw new LibraryError(AUTH_CODE_FAILED, 401);
  } finally { await lease.release(); }
}
