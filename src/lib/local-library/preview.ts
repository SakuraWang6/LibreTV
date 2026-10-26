import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { LibraryError, openVerifiedLibraryMedia } from './server';
import { withFileLock } from './file-lock';
import type { LibraryEntry } from './types';

const MAX_FRAME = 512 * 1024;
const ITEM_BYTES = 16 * 1024 * 1024;
const TOTAL_BYTES = 64 * 1024 * 1024;
const ITEM_FILES = 512;
const TOTAL_FILES = 2048;
const CACHE_NAME = /^([a-f0-9]{32})-[a-f0-9]{32}-\d{1,6}\.jpg$/;
let running: { key: string; result: Promise<Buffer> } | undefined;

function frameTime(request: Request): number {
  const values = new URL(request.url).searchParams.getAll('time');
  const value = Number(values[0]);
  if (values.length !== 1 || !values[0].trim() || !Number.isFinite(value) || value < 0 || value > 7 * 86400) throw new LibraryError('无效的预览时间');
  return Math.floor(value / 5) * 5;
}

function identity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function cacheRoot(): Promise<string> {
  const configured = process.env.LOCAL_LIBRARY_DIR?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new LibraryError('影视库未开启', 503);
  let directory = await fs.realpath(configured);
  for (const part of ['.libretv', 'previews']) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LibraryError('预览缓存目录不可用', 503);
  }
  return directory;
}

function jpeg(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
}

async function cachedFrame(file: string): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new LibraryError('预览缓存暂不可用', 503);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FRAME) throw new LibraryError('预览缓存暂不可用', 503);
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new LibraryError('预览缓存暂不可用', 503);
    const bytes = buffer.subarray(0, length);
    if (!jpeg(bytes)) return undefined;
    const now = new Date(); await handle.utimes(now, now).catch(() => undefined);
    return bytes;
  } finally { await handle.close(); }
}

async function storeFrame(directory: string, name: string, bytes: Buffer): Promise<void> {
  try {
    await withFileLock(path.join(directory, 'cache.lock'), async () => {
      const names = await fs.readdir(directory);
      if (names.length > 8192) throw new Error('Cache is too large');
      const entries: Array<{ name: string; item: string; bytes: number; age: number }> = [];
      for (const candidate of names) {
        if (/^[a-f0-9]{32}-[a-f0-9]{32}-\d{1,6}\.jpg\.[a-f0-9]{16}\.tmp$/.test(candidate)) {
          await fs.unlink(path.join(directory, candidate)); continue;
        }
        const match = candidate.match(CACHE_NAME);
        if (!match) continue;
        const stat = await fs.lstat(path.join(directory, candidate));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe cache entry');
        if (candidate === name) { await fs.unlink(path.join(directory, candidate)); continue; }
        entries.push({ name: candidate, item: match[1], bytes: stat.size, age: stat.mtimeMs });
      }
      entries.sort((a, b) => a.age - b.age);
      const item = name.slice(0, 32);
      const remove = async (index: number) => {
        const [entry] = entries.splice(index, 1);
        await fs.unlink(path.join(directory, entry.name));
      };
      while (entries.filter((entry) => entry.item === item).reduce((sum, entry) => sum + entry.bytes, bytes.length) > ITEM_BYTES
        || entries.filter((entry) => entry.item === item).length >= ITEM_FILES) {
        await remove(entries.findIndex((entry) => entry.item === item));
      }
      while (entries.reduce((sum, entry) => sum + entry.bytes, bytes.length) > TOTAL_BYTES || entries.length >= TOTAL_FILES) await remove(0);
      const temporary = path.join(directory, `${name}.${crypto.randomBytes(8).toString('hex')}.tmp`);
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, path.join(directory, name));
      } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    }, AbortSignal.timeout(1000));
  } catch { throw new LibraryError('预览缓存暂不可用', 503); }
}

async function extractFrame(handle: FileHandle, format: LibraryEntry['format'], time: number): Promise<Buffer> {
  const demuxer = format === 'WEBM' ? 'matroska' : format === 'TS' ? 'mpegts' : 'mov';
  const magic = Buffer.alloc(600);
  await handle.read(magic, 0, magic.length, 0);
  const atom = magic.subarray(4, 8).toString('ascii');
  if (!(demuxer === 'mov' ? ['ftyp', 'styp', 'moov', 'mdat', 'wide'].includes(atom)
    : demuxer === 'matroska' ? magic.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : magic[0] === 0x47 && (magic[188] === 0x47 || magic[376] === 0x47))) throw new LibraryError('该视频暂不支持画面预览', 502);
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1',
    '-protocol_whitelist', 'file,pipe', '-f', demuxer, ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-ss', String(time), '-i', '/dev/fd/3', '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
    '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'mjpeg', '-q:v', '4', '-threads', '1', '-f', 'image2pipe', 'pipe:1'];
  return new Promise<Buffer>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', handle.fd], windowsHide: true }); }
    catch { reject(new LibraryError('预览服务暂不可用', 503)); return; }
    const chunks: Buffer[] = [];
    let length = 0, stderrBytes = 0, failed = false, failureStatus = 502;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(() => { failureStatus = 503; fail(); }, 5000);
    child.stdout!.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_FRAME) fail(); else chunks.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
    child.once('error', () => { clearTimeout(timer); reject(new LibraryError('预览服务暂不可用', 503)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      if (failed || code !== 0 || !jpeg(bytes)) reject(new LibraryError(failureStatus === 503 ? '预览服务暂不可用' : '该视频暂不支持画面预览', failureStatus));
      else resolve(bytes);
    });
  });
}

export async function libraryPreviewResponse(id: string, request: Request): Promise<Response> {
  const time = frameTime(request);
  const { handle, item } = await openVerifiedLibraryMedia(id, request);
  try {
    const before = identity(await handle.stat({ bigint: true }));
    const fingerprint = crypto.createHash('sha256').update(`${item.format}:${before}`).digest('hex').slice(0, 32);
    const directory = await cacheRoot();
    const name = `${item.id}-${fingerprint}-${time}.jpg`;
    const key = path.join(directory, name);
    let bytes = await cachedFrame(key);
    if (!bytes) {
      if (running && running.key !== key) throw new LibraryError('预览生成繁忙，请稍后重试', 503);
      if (running) bytes = await running.result;
      else {
        const result = (async () => {
          const frame = await extractFrame(handle, item.format, time);
          if (identity(await handle.stat({ bigint: true })) !== before) throw new LibraryError('视频文件已变更，请重试', 409);
          await storeFrame(directory, name, frame);
          return frame;
        })();
        running = { key, result };
        try { bytes = await result; }
        finally { if (running?.result === result) running = undefined; }
      }
    }
    if (identity(await handle.stat({ bigint: true })) !== before) throw new LibraryError('视频文件已变更，请重试', 409);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'X-Preview-Time': String(time) } });
  } finally { await handle.close(); }
}
