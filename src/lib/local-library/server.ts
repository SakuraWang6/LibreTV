import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpstreamWithMeta } from '@/lib/fetch-utils';
import type { LibraryEntry, LibraryMetadata, LibraryResponse } from './types';

const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_POSTER = 5 * 1024 * 1024;
const ID_PATTERN = /^[a-f0-9]{32}$/;
const FORMATS = { MP4: ['mp4', 'video/mp4'], TS: ['ts', 'video/mp2t'], WEBM: ['webm', 'video/webm'], MOV: ['mov', 'video/quicktime'] } as const;
type Format = keyof typeof FORMATS;
interface Upload { version: 1; id: string; metadata: LibraryMetadata; format: Format; createdAt: string }
interface Manifest { version: 1; item: LibraryEntry; mediaPath: string; posterPath?: string }

export class LibraryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Requests for one upload/item serialize; unrelated downloads can continue concurrently.
const locks = new Map<string, Promise<void>>();
async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => next);
  locks.set(key, queued);
  await previous;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === queued) locks.delete(key); }
}

function checkId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new LibraryError('无效的影视库编号', 404);
}

/** Only the configured directory is a filesystem capability; clients never supply paths. */
async function rootDirectory(): Promise<string> {
  const configured = process.env.LOCAL_LIBRARY_DIR?.trim();
  if (!configured) throw new LibraryError('本地影视库未开启', 503);
  if (!path.isAbsolute(configured)) throw new LibraryError('本地影视库目录必须使用绝对路径', 503);
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  return fs.realpath(configured);
}

async function safeDirectory(root: string, relative: string): Promise<string> {
  const parts = relative.split(path.sep);
  let current = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new LibraryError('无效的影视库路径', 500);
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('影视库目录包含不安全的链接', 409);
  }
  return current;
}

async function safeFile(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    throw new LibraryError('无效的影视库路径', 404);
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new LibraryError('无效的影视库路径', 404);
  let current = root;
  const parts = path.relative(root, target).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) || (index === parts.length - 1 && !stat.isFile())) {
      throw new LibraryError('影视库文件不可用', 404);
    }
  }
  return target;
}

async function storage(root: string): Promise<{ uploads: string; items: string }> {
  return {
    uploads: await safeDirectory(root, path.join('.libretv', 'uploads')),
    items: await safeDirectory(root, path.join('.libretv', 'items')),
  };
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}

async function readJson<T>(root: string, relative: string): Promise<T> {
  const file = await safeFile(root, relative);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > 128 * 1024) throw new LibraryError('影视库元数据过大', 409);
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally { await handle.close(); }
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max) throw new LibraryError('影视信息格式不正确');
  return value.trim() || undefined;
}

function metadataOf(value: unknown): LibraryMetadata {
  if (!value || typeof value !== 'object') throw new LibraryError('缺少影视信息');
  const data = value as Record<string, unknown>;
  const title = optionalText(data.title, 300);
  if (!title || (data.kind !== 'movie' && data.kind !== 'tv')) throw new LibraryError('请填写片名并选择电影或电视剧');
  const number = (value: unknown): number => {
    if (value === undefined) return 1;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10000) throw new LibraryError('季数和集数必须是正整数');
    return value;
  };
  const result: LibraryMetadata = {
    title, kind: data.kind,
    year: optionalText(data.year, 20),
    description: optionalText(data.description, 12000),
    coverUrl: optionalText(data.coverUrl, 4096),
    sourceName: optionalText(data.sourceName, 300),
  };
  if (data.kind === 'tv') {
    result.seasonNumber = number(data.seasonNumber);
    result.episodeNumber = number(data.episodeNumber);
    result.episodeTitle = optionalText(data.episodeTitle, 300);
  }
  return result;
}

function filename(value: string): string {
  const result = value.normalize('NFKC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  let safe = '';
  for (const character of Array.from(result || '未命名').slice(0, 70)) {
    if (Buffer.byteLength(safe + character, 'utf8') > 160) break;
    safe += character;
  }
  return safe;
}

function manifestPath(id: string): string { checkId(id); return path.join('.libretv', 'items', `${id}.json`); }
function uploadPath(id: string): string { checkId(id); return path.join('.libretv', 'uploads', `${id}.json`); }
function partPath(id: string): string { checkId(id); return path.join('.libretv', 'uploads', `${id}.part`); }

async function readManifest(root: string, id: string): Promise<Manifest> {
  const manifest = await readJson<Manifest>(root, manifestPath(id));
  if (manifest.version !== 1 || manifest.item?.id !== id || !Object.hasOwn(FORMATS, manifest.item.format)) throw new LibraryError('影视库记录不可用', 404);
  return manifest;
}

function publicItem(manifest: Manifest): LibraryEntry {
  // Explicitly select public fields, even if a locally edited manifest contains extra keys.
  const { title, kind, year, description, seasonNumber, episodeNumber, episodeTitle, sourceName } = manifest.item;
  return {
    id: manifest.item.id, groupId: manifest.item.groupId, title, kind, year, description, seasonNumber, episodeNumber, episodeTitle, sourceName,
    bytes: manifest.item.bytes, format: manifest.item.format, createdAt: manifest.item.createdAt,
    mediaUrl: `/api/library/${manifest.item.id}/media`, posterUrl: `/api/library/${manifest.item.id}/poster`,
    position: manifest.item.position, duration: manifest.item.duration, lastPlayedAt: manifest.item.lastPlayedAt,
  };
}

export async function listLibrary(): Promise<LibraryResponse> {
  if (!process.env.LOCAL_LIBRARY_DIR?.trim()) return { enabled: false, items: [] };
  const root = await rootDirectory();
  const { items: directory } = await storage(root);
  const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
  const results = await Promise.all(names.map(async (name) => {
    try {
      const manifest = await readManifest(root, name.slice(0, 32));
      await safeFile(root, manifest.mediaPath);
      return publicItem(manifest);
    } catch { return null; }
  }));
  return { enabled: true, items: results.filter((item): item is LibraryEntry => item !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

export async function createUpload(body: unknown): Promise<{ id: string; offset: number }> {
  const root = await rootDirectory();
  const { uploads } = await storage(root);
  const data = body as Record<string, unknown> | null;
  if (!data || typeof data.format !== 'string' || !Object.hasOwn(FORMATS, data.format)) throw new LibraryError('不支持的视频格式');
  const metadata = metadataOf(data.metadata);
  const id = crypto.randomBytes(16).toString('hex');
  await fs.writeFile(path.join(uploads, `${id}.part`), '', { flag: 'wx', mode: 0o600 });
  try {
    await atomicJson(path.join(uploads, `${id}.json`), { version: 1, id, metadata, format: data.format as Format, createdAt: new Date().toISOString() } satisfies Upload);
  } catch (error) { await fs.rm(path.join(uploads, `${id}.part`), { force: true }); throw error; }
  return { id, offset: 0 };
}

async function boundedBody(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > max) { await reader.cancel(); throw new LibraryError('上传分块过大', 413); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}

export async function readLibraryJson(request: Request): Promise<unknown> {
  try { return JSON.parse((await boundedBody(request.body, 64 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof LibraryError) throw error; throw new LibraryError('请求内容必须是 JSON'); }
}

export async function appendUpload(id: string, offset: number, request: Request): Promise<{ offset: number }> {
  checkId(id);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new LibraryError('无效的上传偏移');
  if (Number(request.headers.get('content-length')) > MAX_CHUNK) throw new LibraryError('上传分块过大', 413);
  const data = await boundedBody(request.body, MAX_CHUNK);
  if (data.length === 0) throw new LibraryError('上传分块不能为空');
  const root = await rootDirectory();
  return locked(`${root}:${id}`, async () => {
    await readJson<Upload>(root, uploadPath(id));
    const part = await safeFile(root, partPath(id));
    const handle = await fs.open(part, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size;
      if (offset < size && offset + data.length <= size) {
        const existing = Buffer.alloc(data.length);
        const read = await handle.read(existing, 0, existing.length, offset);
        if (read.bytesRead === data.length && existing.equals(data)) return { offset: size };
        throw new LibraryError('重试分块与已保存内容不一致', 409);
      }
      if (offset !== size) throw new LibraryError('上传偏移不匹配，请按顺序重试', 409);
      let written = 0;
      try {
        while (written < data.length) {
          const result = await handle.write(data, written, data.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('Incomplete write');
          written += result.bytesWritten;
        }
        await handle.sync();
      } catch (error) { await handle.truncate(size); throw error; }
      return { offset: offset + data.length };
    } finally { await handle.close(); }
  });
}

function imageFormat(bytes: Buffer): { extension: string; type: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: 'png', type: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', type: 'image/jpeg' };
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return { extension: 'gif', type: 'image/gif' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { extension: 'webp', type: 'image/webp' };
  return null;
}

async function cachePoster(url: string | undefined, directory: string, id: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    // This helper checks DNS and every redirect; private targets are never enabled here.
    const { res } = await fetchUpstreamWithMeta(url, { timeoutMs: 7000, retries: 0, safeRedirects: true, allowPrivate: false, headers: { Accept: 'image/jpeg,image/png,image/webp,image/gif' } });
    if (!res.ok || !/^image\/(jpeg|png|webp|gif)(?:;|$)/i.test(res.headers.get('content-type') ?? '') || Number(res.headers.get('content-length')) > MAX_POSTER) {
      await res.body?.cancel(); return undefined;
    }
    const bytes = await boundedBody(res.body, MAX_POSTER);
    const format = imageFormat(bytes);
    if (!format) return undefined;
    const file = path.join(directory, `海报-${id}.${format.extension}`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
  } catch { return undefined; }
}

export async function completeUpload(id: string): Promise<{ item: LibraryEntry }> {
  checkId(id);
  const root = await rootDirectory();
  return locked(`${root}:${id}`, async () => {
    try { return { item: publicItem(await readManifest(root, id)) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const upload = await readJson<Upload>(root, uploadPath(id));
    if (upload.version !== 1 || upload.id !== id || !Object.hasOwn(FORMATS, upload.format)) throw new LibraryError('上传记录不可用', 409);
    const metadata = metadataOf(upload.metadata);
    const part = await safeFile(root, partPath(id));
    const bytes = (await fs.stat(part)).size;
    if (bytes <= 0) throw new LibraryError('视频尚未上传完成', 409);
    const baseTitle = filename(metadata.title);
    const directory = metadata.kind === 'movie'
      ? path.join('电影', `${baseTitle}${metadata.year ? ` (${filename(metadata.year)})` : ''}`)
      : path.join('电视剧', baseTitle, `第${String(metadata.seasonNumber).padStart(2, '0')}季`);
    const destination = await safeDirectory(root, directory);
    const stem = metadata.kind === 'movie' ? baseTitle : `第${String(metadata.episodeNumber).padStart(2, '0')}集${metadata.episodeTitle ? `-${filename(metadata.episodeTitle)}` : ''}`;
    const media = path.join(destination, `${stem} [${id}].${FORMATS[upload.format][0]}`);
    // link is exclusive and atomic: never overwrite a user's file, even after a crash/retry.
    try { await fs.link(part, media); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await fs.lstat(media);
      const original = await fs.stat(part);
      if (!existing.isFile() || existing.ino !== original.ino || existing.dev !== original.dev) throw new LibraryError('目标视频已存在，未覆盖原文件', 409);
    }
    let poster: string | undefined;
    try {
      poster = await cachePoster(metadata.coverUrl, destination, id);
      const offlineMetadata = { ...metadata };
      delete offlineMetadata.coverUrl;
      const groupId = crypto.createHash('sha256').update(`${metadata.kind}\0${metadata.title.normalize('NFKC').toLowerCase()}\0${metadata.year ?? ''}`).digest('hex').slice(0, 24);
      const item: LibraryEntry = {
        ...offlineMetadata, id, groupId, bytes, format: upload.format, createdAt: upload.createdAt,
        mediaUrl: `/api/library/${id}/media`, posterUrl: `/api/library/${id}/poster`,
      };
      const manifest: Manifest = { version: 1, item, mediaPath: path.relative(root, media), ...(poster ? { posterPath: path.relative(root, poster) } : {}) };
      await atomicJson(path.join(root, manifestPath(id)), manifest);
      // The manifest is the commit point; cleanup failures must not make a committed upload fail.
      await Promise.all([fs.rm(part, { force: true }), fs.rm(path.join(root, uploadPath(id)), { force: true })]).catch(() => undefined);
      return { item: publicItem(manifest) };
    } catch (error) {
      await fs.rm(media, { force: true }).catch(() => undefined);
      if (poster) await fs.rm(poster, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

export async function cancelUpload(id: string): Promise<{ cancelled: true }> {
  checkId(id);
  const root = await rootDirectory();
  return locked(`${root}:${id}`, async () => {
    // DELETE only cancels staging. Completed library entries are never deletable here.
    try { await readManifest(root, id); throw new LibraryError('该视频已入库，不能作为临时上传删除', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await readJson<Upload>(root, uploadPath(id));
    await fs.rm(await safeFile(root, partPath(id)), { force: true });
    await fs.rm(path.join(root, uploadPath(id)), { force: true });
    return { cancelled: true };
  });
}

export async function updateProgress(id: string, body: unknown): Promise<{ item: LibraryEntry }> {
  checkId(id);
  const data = body as Record<string, unknown> | null;
  if (!data || typeof data.position !== 'number' || !Number.isFinite(data.position) || data.position < 0 || (data.duration !== undefined && (typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration < 0))) {
    throw new LibraryError('无效的播放进度');
  }
  const root = await rootDirectory();
  return locked(`${root}:${id}`, async () => {
    const manifest = await readManifest(root, id);
    manifest.item.position = data.position as number;
    if (typeof data.duration === 'number') manifest.item.duration = data.duration;
    manifest.item.lastPlayedAt = new Date().toISOString();
    await atomicJson(path.join(root, manifestPath(id)), manifest);
    return { item: publicItem(manifest) };
  });
}

function byteRange(header: string | null, size: number): [number, number] | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) throw new LibraryError('无效的视频字节范围', 416);
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new LibraryError('无效的视频字节范围', 416);
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new LibraryError('无效的视频字节范围', 416);
    end = Math.min(end, size - 1);
  }
  return [start, end];
}

export async function mediaResponse(id: string, request: Request): Promise<Response> {
  const root = await rootDirectory();
  const manifest = await readManifest(root, id);
  const media = await safeFile(root, manifest.mediaPath);
  const handle = await fs.open(media, constants.O_RDONLY | constants.O_NOFOLLOW);
  let streaming = false;
  try {
    const { size } = await handle.stat();
    const headers = new Headers({ 'Content-Type': FORMATS[manifest.item.format][1], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
    let range: [number, number] | null;
    try { range = byteRange(request.headers.get('range'), size); }
    catch (error) {
      if (error instanceof LibraryError && error.status === 416) { headers.set('Content-Range', `bytes */${size}`); return new Response(null, { status: 416, headers }); }
      throw error;
    }
    const start = range?.[0] ?? 0;
    const end = range?.[1] ?? size - 1;
    headers.set('Content-Length', String(end - start + 1));
    if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    if (request.method === 'HEAD' || size === 0) return new Response(null, { status: range ? 206 : 200, headers });
    const stream = handle.createReadStream({ start, end, autoClose: true });
    const closeHandle = () => {
      request.signal.removeEventListener('abort', abortStream);
      // autoClose normally owns this, but an HTTP disconnect can leave the web
      // response unconsumed. Explicit close is idempotent and avoids relying on GC.
      void handle.close().catch(() => undefined);
    };
    const abortStream = () => { stream.destroy(); closeHandle(); };
    stream.once('close', closeHandle);
    const body = Readable.toWeb(stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
    request.signal.addEventListener('abort', abortStream, { once: true });
    if (request.signal.aborted) abortStream();
    streaming = true;
    return new Response(body, { status: range ? 206 : 200, headers });
  } finally { if (!streaming) await handle.close(); }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

export async function posterResponse(id: string): Promise<Response> {
  const root = await rootDirectory();
  const manifest = await readManifest(root, id);
  if (manifest.posterPath) {
    try {
      const file = await safeFile(root, manifest.posterPath);
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        if ((await handle.stat()).size > MAX_POSTER) throw new LibraryError('海报过大', 409);
        bytes = await handle.readFile();
      } finally { await handle.close(); }
      const format = imageFormat(bytes);
      if (format) return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': format.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
    } catch { /* An offline, generated poster remains available if a cached file is missing. */ }
  }
  const label = escapeXml(Array.from(manifest.item.title).slice(0, 16).join(''));
  const kind = manifest.item.kind === 'tv' ? '电视剧' : '电影';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><rect width="400" height="600" fill="#1c2432"/><rect x="28" y="28" width="344" height="544" rx="16" fill="#273549"/><text x="200" y="274" text-anchor="middle" font-family="sans-serif" font-size="23" fill="#f3f4f6">${label}</text><text x="200" y="324" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#a7b7cc">${kind} · 离线影视库</text></svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, max-age=3600', 'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff' } });
}

function mutationAllowed(request: Request): boolean {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  let publicUrl = url;
  if (host) {
    // Next builds Request.url from its listening hostname, which may be
    // localhost/0.0.0.0 while the browser accesses 127.0.0.1. The actual Host
    // remains the browser's origin authority; never compare Origin to Next's
    // internal alias or trust forwarded host headers here.
    if (/[\s/\\@?#]/.test(host)) return false;
    try { publicUrl = new URL(`${url.protocol}//${host}`); }
    catch { return false; }
    const localAliases = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]']);
    const localAlias = localAliases.has(url.hostname.toLowerCase())
      && localAliases.has(publicUrl.hostname.toLowerCase()) && url.port === publicUrl.port;
    if (publicUrl.host !== url.host && !localAlias) return false;
  }
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true; // Native local clients/CLI do not send Origin.
  try { return new URL(origin).origin === publicUrl.origin; }
  catch { return false; }
}

/** Consistent authentication, CSRF and non-sensitive error handling for every library API. */
export async function libraryRoute(request: Request, mutating: boolean, action: () => Promise<Response | unknown>): Promise<Response> {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (mutating && !mutationAllowed(request)) return Response.json({ error: '请求来源不匹配' }, { status: 403 });
  try {
    const result = await action();
    return result instanceof Response ? result : Response.json(result);
  } catch (error) {
    if (error instanceof LibraryError) return Response.json({ error: error.message }, { status: error.status });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Response.json({ error: '找不到本地影视库记录或视频' }, { status: 404 });
    if (code === 'ENOSPC') return Response.json({ error: '本地磁盘空间不足' }, { status: 507 });
    return Response.json({ error: '本地影视库暂时不可用，请检查目录权限和磁盘空间' }, { status: 500 });
  }
}
