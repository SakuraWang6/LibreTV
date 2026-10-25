import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { LibraryError } from '@/lib/local-library/server';
import { atomicJson } from '@/lib/background-downloads/store';
import { maxJobBytes, requireFreeSpace, type MediaPlan } from '@/lib/background-downloads/media';
import { quarkAccountKey, runQuarkCommand, listQuarkDownloadRecords, deleteQuarkDownloadRecord } from './runtime';
import type { QuarkFileReference } from './types';

interface TransferState {
  version: 1;
  accountKey: string;
  fileId: string;
  name?: string;
  size?: number;
  folderId?: string;
  savedFileId?: string;
  priorRecordIds?: string[];
  recordId?: string;
}
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const STATE_NAME = 'quark-transfer.json';
const INPUT_NAME = 'r000000.bin';
const plan = (): MediaPlan => ({ version: 1, input: INPUT_NAME, resources: [] });

/** Saved SDK FIDs are opaque tokens, unlike share and checkpoint identifiers. */
function sdkId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

async function readState(directory: string): Promise<TransferState | undefined> {
  try {
    const handle = await fs.open(path.join(directory, STATE_NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > 128 * 1024) throw new Error('夸克断点记录过大');
      const state = JSON.parse(await handle.readFile('utf8')) as TransferState;
      if (state.version !== 1 || !ID.test(state.fileId) || !/^[a-f0-9]{64}$/.test(state.accountKey)
        || [state.folderId, state.savedFileId].some((id) => id !== undefined && !sdkId(id))
        || (state.recordId !== undefined && !ID.test(state.recordId))) throw new Error('夸克断点记录不可用');
      return state;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function privateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('夸克暂存目录不安全');
  return directory;
}

async function matchingSavedFiles(folderId: string, directory: string, reference: QuarkFileReference, signal: AbortSignal): Promise<string[]> {
  const taskDirectory = await privateDirectory(path.join(directory, 'quark-browse'));
  const result = await runQuarkCommand(['browse', '--parent-fid', folderId, '--all', '--task-dir', taskDirectory], { signal, timeoutMs: 40_000 });
  if (typeof result.data.file_path !== 'string') throw new Error('夸克没有返回转存文件目录');
  const file = path.resolve(result.data.file_path);
  if (!file.startsWith(taskDirectory + path.sep) || !file.endsWith('.jsonl')) throw new Error('夸克文件目录路径无效');
  const real = await fs.realpath(file);
  if (!real.startsWith(await fs.realpath(taskDirectory) + path.sep)) throw new Error('夸克文件目录不安全');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > 1024 * 1024) throw new Error('夸克转存目录过大');
    const matches: string[] = [];
    for (const line of (await handle.readFile('utf8')).split('\n').filter(Boolean)) {
      const raw = JSON.parse(line) as Record<string, unknown>;
      // Browse's file_type is a string; share-detail uses a different enum.
      if (raw.filename === reference.name && Number(raw.size) === reference.size && raw.category !== 0 && raw.file_type !== '0'
        && sdkId(raw.fid)) matches.push(raw.fid);
    }
    return [...new Set(matches)];
  } finally { await handle.close(); await fs.rm(file, { force: true }); }
}

async function discoverRecord(state: TransferState, reference: QuarkFileReference): Promise<string | undefined> {
  const candidates = (await listQuarkDownloadRecords(state.accountKey)).filter((row) => ID.test(row.recordId)
    && row.fid === state.savedFileId && row.fileName === reference.name && row.fileSize === reference.size
    && !state.priorRecordIds?.includes(row.recordId));
  if (candidates.length > 1) throw new Error('夸克断点不唯一，请取消任务后重新下载');
  return candidates[0]?.recordId as string | undefined;
}

/** Official CLI owns authentication, expiring download URLs and chunk checkpoints.
 * Only a local verified media file enters the existing remux/import transaction. */
export async function downloadQuarkMedia(reference: QuarkFileReference, directory: string, signal: AbortSignal,
  onProgress?: (current: number, total: number) => Promise<void> | void): Promise<MediaPlan> {
  if (reference.size <= 0 || reference.size > maxJobBytes()) throw new Error('夸克视频超过单个任务的空间限制');
  const requireAccount = async () => {
    signal.throwIfAborted();
    if (await quarkAccountKey() !== reference.accountKey) throw new LibraryError('夸克账号已变更，请使用创建任务时的账号登录', 409);
  };
  await requireAccount();
  const destination = path.join(directory, INPUT_NAME);
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.size) throw new Error('夸克视频暂存大小不一致');
    await onProgress?.(stat.size, reference.size);
    return plan();
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Input, remuxed MP4 and library staging can coexist before commit.
  await requireFreeSpace(directory, reference.size * 3);
  let state = await readState(directory);
  if (state && (state.accountKey !== reference.accountKey || state.fileId !== reference.fileId)) throw new Error('夸克断点与当前文件不一致');
  state ??= { version: 1, accountKey: reference.accountKey, fileId: reference.fileId };
  state.name = reference.name; state.size = reference.size;
  const save = () => atomicJson(path.join(directory, STATE_NAME), state);
  if (!state.folderId) {
    const result = await runQuarkCommand(['create-folder', '--dir-path', `LibreTV/${path.basename(directory)}`], { signal, timeoutMs: 40_000 });
    if (!sdkId(result.data.fid)) throw new Error('无法建立夸克下载目录');
    state.folderId = result.data.fid;
    await save();
  }
  if (!state.savedFileId) {
    await requireAccount();
    let matches = await matchingSavedFiles(state.folderId, directory, reference, signal);
    if (matches.length > 1) throw new Error('转存目录中存在多个同名视频，无法确认文件');
    if (!matches.length) {
      // A single selected FID is explicit: never use the CLI's default save-all.
      await runQuarkCommand(['saveas', '--url', reference.shareUrl, '--fid-list', reference.fileId, '--to-pdir-fid', state.folderId], { signal, timeoutMs: 15 * 60_000 });
      matches = await matchingSavedFiles(state.folderId, directory, reference, signal);
    }
    if (matches.length !== 1) throw new Error('未能确认转存后的视频名称和大小，请检查分享是否更新');
    state.savedFileId = matches[0]; await save();
  }
  await requireAccount();
  if (!state.priorRecordIds) {
    state.priorRecordIds = (await listQuarkDownloadRecords(state.accountKey)).map((row) => row.recordId);
    await save();
  } else if (!state.recordId) {
    state.recordId = await discoverRecord(state, reference); await save();
  }
  const outputDirectory = path.join(directory, 'quark-media');
  if (!state.recordId) {
    // Without an official checkpoint a partial copy cannot be safely resumed.
    // This directory belongs exclusively to this job, never to the user's files.
    const old = await fs.lstat(outputDirectory).catch(() => undefined);
    if (old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error('夸克暂存目录不安全');
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
  await privateDirectory(outputDirectory);
  const controller = new AbortController();
  const activeSignal = AbortSignal.any([signal, controller.signal]);
  const diskTimer = setInterval(() => { void requireFreeSpace(directory).catch((error) => controller.abort(error)); }, 1000);
  try {
    const args = state.recordId ? ['download', 'resume', '--record-id', state.recordId] : ['download', '--fid', state.savedFileId];
    const result = await runQuarkCommand([...args, '--output-dir', outputDirectory], { signal: activeSignal, timeoutMs: 24 * 60 * 60_000,
      onProgress: async (current, total) => {
        if (!Number.isSafeInteger(current) || current < 0 || current > reference.size || total !== reference.size) throw new Error('夸克文件大小已变化，不能继续下载');
        await onProgress?.(current, total);
      } });
    await requireAccount();
    if (typeof result.data.filePath !== 'string') throw new Error('夸克没有返回已完成的视频');
    const file = path.resolve(result.data.filePath);
    if (path.dirname(file) !== outputDirectory || path.dirname(await fs.realpath(file)) !== await fs.realpath(outputDirectory)) throw new Error('夸克下载文件路径不安全');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== reference.size) throw new Error('夸克视频未完整下载');
    await fs.rename(file, destination);
    await onProgress?.(reference.size, reference.size);
    return plan();
  } catch (error) {
    // The runtime waits for SIGINT checkpoint persistence before it rejects.
    // Use an independent short request after abort to capture this job's record.
    if (!state.recordId) {
      try { state.recordId = await discoverRecord(state, reference); await save(); }
      catch { /* Original error remains authoritative; do not guess a record. */ }
    }
    if (controller.signal.aborted && !signal.aborted) throw controller.signal.reason;
    throw error;
  } finally { clearInterval(diskTimer); }
}

export async function cleanupQuarkDownload(directory: string): Promise<void> {
  const state = await readState(directory);
  if (!state?.savedFileId) return;
  // Local, account-bound SDK records are cleared without a network request or
  // renewed authorization. An absent completed record is an idempotent success.
  let recordId = state.recordId;
  if (!recordId) {
    const matches = (await listQuarkDownloadRecords(state.accountKey)).filter((row) => row.fid === state.savedFileId
      && row.fileName === state.name && row.fileSize === state.size && !state.priorRecordIds?.includes(row.recordId));
    if (matches.length > 1) throw new Error('无法唯一确认夸克本地断点，暂存文件已保留');
    recordId = matches[0]?.recordId;
  }
  // Cancel clears only this local transfer record. The user's cloud copy stays.
  if (recordId) await deleteQuarkDownloadRecord(state.accountKey, recordId, state.savedFileId);
}
