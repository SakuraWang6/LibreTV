import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { LibraryError, validateLibraryMetadata } from '@/lib/local-library/server';
import type { LibraryMetadata } from '@/lib/local-library/types';
import { withFileLock } from '@/lib/local-library/file-lock';
import { atomicJson, enqueueQuarkDownloads } from '@/lib/background-downloads/store';
import { maxJobBytes } from '@/lib/background-downloads/media';
import { quarkAccountKey, quarkPrivateRoot, runQuarkCommand } from './runtime';
import type { QuarkShareFile } from './types';

const MAX_FILES = 400;
const CACHE_TTL = 12 * 60 * 60_000;
const VIDEO = /\.(?:mp4|m4v|mkv|mov|webm|ts)$/i;
interface CachedShare { version: 1; accountKey: string; updatedAt: number; files: Record<string, QuarkShareFile>; folders: string[] }

export function quarkShareUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new LibraryError('夸克分享链接无效');
  let url: URL;
  try { url = new URL(value); } catch { throw new LibraryError('夸克分享链接无效'); }
  if (url.protocol !== 'https:' || url.hostname !== 'pan.quark.cn' || url.port || url.username || url.password
    || !/^\/s\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)) throw new LibraryError('只支持夸克官方分享链接');
  const password = url.searchParams.get('pwd');
  if (password && !/^[A-Za-z0-9]{1,32}$/.test(password)) throw new LibraryError('夸克提取码无效');
  url.pathname = url.pathname.replace(/\/$/, ''); url.search = ''; url.hash = '';
  if (password) url.searchParams.set('pwd', password);
  return url.href;
}

export function quarkFileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw new LibraryError('夸克文件编号无效');
  return value;
}

function safeName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\/\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') throw new LibraryError('夸克文件名不受支持');
  return value;
}

/** Only a small, credential-free projection ever leaves the backend. */
export function projectQuarkFile(raw: Record<string, unknown>): QuarkShareFile {
  const id = quarkFileId(raw.fid);
  const name = safeName(raw.filename ?? raw.file_name ?? raw.name);
  // Fixed official CLI 1.0.25 projects both share and browse enums as strings.
  const isDirectory = raw.file_type === '0' || raw.category === 0;
  const size = Number(raw.size ?? raw.file_size ?? 0);
  if (!Number.isSafeInteger(size) || size < 0) throw new LibraryError('夸克文件大小无效');
  return { id, name, size, isDirectory, downloadable: !isDirectory && VIDEO.test(name) && size > 0 && size <= maxJobBytes() };
}

async function cacheLocation(url: string) {
  const root = quarkPrivateRoot();
  const directory = path.join(root, 'shares');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('夸克分享缓存不可用', 503);
  return path.join(directory, crypto.createHash('sha256').update(url).digest('hex') + '.json');
}

async function cached(url: string, accountKey: string): Promise<CachedShare> {
  const empty: CachedShare = { version: 1, accountKey, updatedAt: Date.now(), files: {}, folders: ['0'] };
  const file = await cacheLocation(url);
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > 4 * 1024 * 1024) throw new LibraryError('分享目录过大，请重新打开分享');
      const data = JSON.parse(await handle.readFile('utf8')) as CachedShare;
      if (data.version !== 1 || data.accountKey !== accountKey || Date.now() - data.updatedAt > CACHE_TTL) return empty;
      return data;
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty; throw error; }
}

export async function listQuarkShare(body: unknown, signal?: AbortSignal) {
  const input = body as Record<string, unknown> | null;
  const url = quarkShareUrl(input?.url);
  const folderId = input?.folderId === undefined ? '0' : quarkFileId(input.folderId);
  const accountKey = await quarkAccountKey();
  const previous = await cached(url, accountKey);
  if (!previous.folders.includes(folderId)) throw new LibraryError('请从分享根目录打开文件夹');
  const entries: QuarkShareFile[] = [];
  let hasMore = false, shareTitle = '';
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_FILES / 100; page++) {
    const result = await runQuarkCommand(['share-detail', '--url', url, '--pdir-fid', folderId, '--page', String(page), '--size', '100'], { signal, timeoutMs: 40_000 });
    if (await quarkAccountKey() !== accountKey) throw new LibraryError('夸克账号已变更，请重新打开分享', 409);
    const files = result.data.files;
    if (!Array.isArray(files)) throw new LibraryError('夸克未返回有效的分享目录', 502);
    const info = result.data.share_info as Record<string, unknown> | undefined;
    if (typeof info?.title === 'string') shareTitle = info.title.slice(0, 200);
    else if (typeof info?.share_title === 'string') shareTitle = info.share_title.slice(0, 200);
    let newCount = 0;
    for (const raw of files) {
      const file = projectQuarkFile(raw as Record<string, unknown>);
      if (!seen.has(file.id)) { seen.add(file.id); entries.push(file); newCount++; }
    }
    hasMore = files.length >= 100;
    if (!hasMore || !newCount) break;
  }
  const file = await cacheLocation(url);
  await withFileLock(file + '.lock', async () => {
    const current = await cached(url, accountKey);
    for (const entry of entries) {
      current.files[entry.id] = entry;
      if (entry.isDirectory && !current.folders.includes(entry.id)) current.folders.push(entry.id);
    }
    if (Object.keys(current.files).length > 10000) throw new LibraryError('分享目录缓存已满，请减少打开的文件夹');
    current.updatedAt = Date.now();
    await atomicJson(file, current);
  }, signal);
  return { entries, folderId, ...(shareTitle ? { shareTitle } : {}), hasMore };
}

export function metadataForQuarkFile(base: LibraryMetadata, file: QuarkShareFile, count: number): LibraryMetadata {
  const stem = file.name.replace(VIDEO, '');
  if (base.kind === 'tv') {
    const se = stem.match(/(?:^|[^A-Za-z])S(\d{1,2})[ ._-]*E(\d{1,3})(?:[^\d]|$)/i);
    const episode = count === 1 && base.episodeNumber ? base.episodeNumber
      : se ? Number(se[2]) : Number(stem.match(/第\s*(\d{1,3})\s*[集话]|(?:^|[^A-Za-z])EP?\s*0*(\d{1,3})(?:[^\d]|$)|^\s*0*(\d{1,3})(?:[ ._\-\]\[（(]|$)/i)?.slice(1).find(Boolean));
    if (!Number.isInteger(episode) || episode < 1 || episode > 9999) throw new LibraryError(`无法确认「${file.name}」的集数，请单独选择并填写集数`);
    return validateLibraryMetadata({ ...base, seasonNumber: se ? Number(se[1]) : base.seasonNumber || 1, episodeNumber: episode, episodeTitle: stem, sourceName: 'LIBVIO · 夸克' });
  }
  if (count === 1 && !/合集|[1一]\s*[-–至]\s*[3三]/.test(base.title)) return validateLibraryMetadata({ ...base, sourceName: 'LIBVIO · 夸克' });
  const year = stem.match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/)?.[1];
  const title = stem.replace(/(?:19|20)\d{2}.*$/, '').replace(/[._]/g, ' ').replace(/\b(?:2160p|1080p|720p|BluRay|WEB[- ]?DL|HEVC|H[ .]?26[45]|x26[45])\b.*$/i, '').replace(/[\s\-\[(（]+$/, '').trim() || stem;
  return validateLibraryMetadata({ title, kind: 'movie', ...(year ? { year } : {}), sourceName: 'LIBVIO · 夸克' });
}

export async function enqueueQuarkFiles(body: unknown) {
  const data = body as Record<string, unknown> | null;
  const url = quarkShareUrl(data?.url);
  if (!Array.isArray(data?.fileIds) || !data.fileIds.length || data.fileIds.length > 100) throw new LibraryError('请选择 1–100 个视频文件');
  const ids = [...new Set(data.fileIds.map(quarkFileId))];
  const base = validateLibraryMetadata(data.metadata);
  // Library validation defaults an omitted episode to 1. A share selection
  // instead needs to infer the actual file, unless the user entered a number.
  const rawMetadata = data.metadata as Record<string, unknown> | undefined;
  if (base.kind === 'tv' && rawMetadata?.episodeNumber === undefined) delete base.episodeNumber;
  const key = data.idempotencyKey;
  if (typeof key !== 'string' || !key || key.length > 120) throw new LibraryError('缺少有效的下载请求编号');
  const accountKey = await quarkAccountKey();
  const cache = await cached(url, accountKey);
  // Validate the entire selection before creating the first durable job.
  const selected = ids.map((id) => {
    const file = cache.files[id];
    if (!file?.downloadable || file.isDirectory) throw new LibraryError('分享目录已过期或所选文件不能下载，请重新读取分享');
    return { file, metadata: metadataForQuarkFile(base, file, ids.length) };
  });
  return enqueueQuarkDownloads(selected.map(({ file, metadata }) => ({
    reference: { shareUrl: url, fileId: file.id, name: file.name, size: file.size, accountKey }, metadata,
    idempotencyKey: `quark:${key}:${crypto.createHash('sha256').update(file.id).digest('hex').slice(0, 24)}`,
  })));
}
