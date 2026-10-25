import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import { fetchDownloadResource } from './safe-fetch';

const MAX_MANIFEST = 2 * 1024 * 1024;
const MAX_RESOURCES = 30_000;
const RESERVE_BYTES = 512 * 1024 * 1024;
interface Resource { url: string; name: string; key?: boolean; mediaFile?: boolean }
interface Piece { name: string; keyName?: string; iv?: string }
export interface MediaPlan { version: 1; input: string; pieces?: Piece[]; resources: Resource[] }

function urlOf(value: string, base: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('清单包含不支持的视频地址');
  return url.href;
}

function attributes(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  const source = line.slice(line.indexOf(':') + 1);
  for (const match of source.matchAll(/([A-Z0-9-]+)=("[^"\r\n]*"|[^,\r\n]*)/g)) result[match[1]] = match[2].replace(/^"|"$/g, '');
  return result;
}

async function manifestBody(response: Response): Promise<string> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_MANIFEST) throw new Error('视频清单过大或为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_MANIFEST) { await reader.cancel(); throw new Error('视频清单超过 2 MiB 限制'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8').replace(/^\uFEFF/, '');
}

/** Only vetted HTTP resources enter this plan; ffmpeg will only see generated local names. */
export function parseMediaPlaylist(text: string, base: string): MediaPlan {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('不是有效的 HLS 视频清单');
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('直播或尚未结束的播放列表不能加入离线影视库');
  const resources: Resource[] = [];
  const names = new Map<string, string>();
  let resourceUrlBytes = 0;
  const resource = (value: string, key = false): string => {
    const url = urlOf(value, base);
    const identity = `${key ? 'key' : 'media'}:${url}`;
    const existing = names.get(identity);
    if (existing) return existing;
    if (resources.length >= MAX_RESOURCES) throw new Error('视频分片过多');
    resourceUrlBytes += Buffer.byteLength(url);
    if (url.length > 8192 || resourceUrlBytes > 8 * 1024 * 1024) throw new Error('视频清单中的地址过长或过多');
    const name = `r${String(resources.length).padStart(6, '0')}.${key ? 'key' : 'bin'}`;
    resources.push({ url, name, ...(key ? { key: true } : {}) });
    names.set(identity, name);
    return name;
  };
  const pieces: Piece[] = [];
  let keyName: string | undefined;
  let keyIv: string | undefined;
  let sequence = 0n;
  let mapName: string | undefined;
  let mediaCount = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith('#')) {
      pieces.push({ name: resource(line), ...(keyName ? { keyName, iv: keyIv ?? sequence.toString(16).padStart(32, '0') } : {}) });
      mediaCount++; sequence++; continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = attributes(line);
      if (attrs.METHOD === 'NONE') { keyName = undefined; keyIv = undefined; continue; }
      if (attrs.METHOD !== 'AES-128' || (attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity') || !attrs.URI) throw new Error('仅支持未加密或标准 AES-128 视频，不能下载 DRM 视频');
      if (attrs.IV && !/^0x[0-9a-f]{1,32}$/i.test(attrs.IV)) throw new Error('视频加密参数不正确');
      keyName = resource(attrs.URI, true); keyIv = attrs.IV?.slice(2).padStart(32, '0');
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line);
      if (!attrs.URI || attrs.BYTERANGE) throw new Error('暂不支持按字节范围划分的 HLS 视频，请更换来源');
      const name = resource(attrs.URI);
      if (mapName && mapName !== name) throw new Error('该来源中途切换视频初始化片段，请更换来源');
      if (!mapName) {
        if (mediaCount) throw new Error('视频初始化片段位置无效');
        if (keyName && !keyIv) throw new Error('加密初始化片段缺少 IV');
        pieces.push({ name, ...(keyName ? { keyName, iv: keyIv } : {}) }); mapName = name;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE') || line === '#EXT-X-GAP') throw new Error('该 HLS 使用不支持的分片方式或缺少分片，请更换来源');
    if (/^#EXT-X-MEDIA-SEQUENCE:\d+$/.test(line)) sequence = BigInt(line.slice(line.indexOf(':') + 1));
  }
  if (!mediaCount) throw new Error('播放列表没有视频分片');
  return { version: 1, input: 'assembled.bin', pieces, resources };
}

export async function createMediaPlan(url: string, signal: AbortSignal, depth = 0): Promise<MediaPlan> {
  if (depth > 4) throw new Error('播放列表嵌套过多');
  const { res, finalUrl } = await fetchDownloadResource(url, { signal, timeoutMs: 30_000 });
  if (!res.ok) { await res.body?.cancel(); throw new Error(`来源请求失败（HTTP ${res.status}）`); }
  const type = res.headers.get('content-type') ?? '';
  const playlist = /mpegurl|m3u/i.test(type) || /\.m3u8(?:$|[?#])/i.test(finalUrl);
  if (!playlist) {
    await res.body?.cancel();
    if (!/^video\//i.test(type) && !/\.(?:mp4|m4v|mov|webm|ts)(?:$|[?#])/i.test(finalUrl)) throw new Error('来源未返回 HLS 清单或支持的视频文件');
    const mediaFile = /\bvideo\/mp4\b/i.test(type) || /\.(?:mp4|m4v|mov)(?:$|[?#])/i.test(finalUrl);
    return { version: 1, input: 'r000000.bin', resources: [{ url: finalUrl, name: 'r000000.bin', ...(mediaFile ? { mediaFile: true } : {}) }] };
  }
  const text = await manifestBody(res);
  if (text.includes('#EXT-X-STREAM-INF:')) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const variants: Array<{ url: string; bandwidth: number; externalAudio: boolean }> = [];
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = attributes(lines[index]);
      const next = lines[index + 1];
      if (!next || next.startsWith('#')) throw new Error('主播放列表缺少视频地址');
      const externalAudio = !!attrs.AUDIO && lines.some((line) => line.startsWith('#EXT-X-MEDIA:') && attributes(line)['GROUP-ID'] === attrs.AUDIO && !!attributes(line).URI);
      variants.push({ url: urlOf(next, finalUrl), bandwidth: Number(attrs.BANDWIDTH) || 0, externalAudio });
    }
    const variant = variants.filter((entry) => !entry.externalAudio).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!variant) throw new Error('该来源音画分离，暂不支持后台保存，请更换来源');
    return createMediaPlan(variant.url, signal, depth + 1);
  }
  return parseMediaPlaylist(text, finalUrl);
}

export function maxJobBytes(): number {
  const configured = Number(process.env.BACKGROUND_DOWNLOAD_MAX_GB ?? '20');
  return (Number.isFinite(configured) ? Math.max(0.1, Math.min(configured, 200)) : 20) * 1024 ** 3;
}

export async function requireFreeSpace(directory: string, required = 0): Promise<void> {
  const stat = await fs.statfs(directory);
  if (Number(stat.bavail) * Number(stat.bsize) < RESERVE_BYTES + required) throw new Error('磁盘空间不足，后台下载已停止以保留 512 MiB 可用空间');
}

export async function downloadResource(resource: Resource, directory: string, signal: AbortSignal, priorBytes: number): Promise<number> {
  const destination = path.join(directory, resource.name);
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || (resource.key && stat.size !== 16)) throw new Error('暂存文件不可用');
    return stat.size;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const maximum = resource.key ? 16 : maxJobBytes() - priorBytes;
  if (maximum <= 0) throw new Error('该视频超过单个任务的空间限制');
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${destination}.part`;
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      signal.throwIfAborted(); await requireFreeSpace(directory);
      const streamingFile = resource.mediaFile === true && !resource.key;
      const { res } = await fetchDownloadResource(resource.url, { signal, timeoutMs: streamingFile ? 15_000 : 90_000, ...(streamingFile ? { idleTimeoutMs: 30_000 } : {}) });
      if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error(`来源分片请求失败（HTTP ${res.status}）`); }
      if (Number(res.headers.get('content-length')) > maximum) { await res.body.cancel(); throw new Error('视频文件超过空间限制'); }
      await fs.rm(temporary, { force: true });
      handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const reader = res.body.getReader();
      let bytes = 0;
      let checked = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > maximum) throw new Error('视频文件超过空间限制');
          if (bytes - checked > 8 * 1024 * 1024) { await requireFreeSpace(directory, next.value.length); checked = bytes; }
          let offset = 0;
          while (offset < next.value.length) {
            const written = await handle.write(next.value, offset, next.value.length - offset);
            if (!written.bytesWritten) throw new Error('磁盘写入未完成');
            offset += written.bytesWritten;
          }
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!bytes || (resource.key && bytes !== 16)) throw new Error('来源返回了空视频或无效的加密密钥');
      await handle.sync(); await handle.close(); handle = undefined;
      await fs.rename(temporary, destination);
      return bytes;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      if (signal.aborted || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw new Error('视频分片下载失败');
}

export async function remuxLocal(plan: MediaPlan, directory: string, signal: AbortSignal): Promise<string> {
  await requireFreeSpace(directory);
  const output = path.join(directory, 'result.mp4');
  await fs.rm(output, { force: true });
  if (plan.pieces) {
    const assembled = path.join(directory, plan.input);
    const assembledHandle = await fs.open(assembled, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    const sink = assembledHandle.createWriteStream({ autoClose: true });
    sink.on('error', () => undefined); // Each write's callback/pipeline reports the same error.
    let written = 0;
    try {
      for (const piece of plan.pieces) {
        signal.throwIfAborted();
        const source = createReadStream(path.join(directory, piece.name));
        const append = new Writable({ write(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > maxJobBytes()) { callback(new Error('视频超过单个任务的空间限制')); return; }
          sink.write(chunk, callback);
        } });
        if (piece.keyName) {
          const decipher = createDecipheriv('aes-128-cbc', await fs.readFile(path.join(directory, piece.keyName)), Buffer.from(piece.iv!, 'hex'));
          await pipeline(source, decipher, append, { signal });
        } else await pipeline(source, append, { signal });
        await requireFreeSpace(directory);
      }
      await new Promise<void>((resolve, reject) => { sink.once('error', reject); sink.end(resolve); });
    } catch (error) { sink.destroy(); throw error; }
  }
  // Force a media demuxer after checking magic. Never let an upstream response
  // auto-select hls/concat, which could interpret embedded URLs or local paths.
  const input = path.join(directory, plan.input);
  const handle = await fs.open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  const magic = Buffer.alloc(600);
  try { await handle.read(magic, 0, magic.length, 0); } finally { await handle.close(); }
  let demuxer: string;
  if (magic.subarray(4, 8).toString('ascii') === 'ftyp' || magic.subarray(4, 8).toString('ascii') === 'styp') demuxer = 'mov';
  else if (magic[0] === 0x47 && (magic[188] === 0x47 || magic[376] === 0x47)) demuxer = 'mpegts';
  else if (magic.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) demuxer = 'matroska';
  else throw new Error('来源文件不是支持的 MP4、TS 或 WebM 视频');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,crypto,data',
    '-f', demuxer, ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-i', input, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let killed = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (killed) return;
      killed = true; child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(abort, 30 * 60_000);
    // ffmpeg can temporarily duplicate data while placing the MP4 index at the front.
    const diskTimer = setInterval(() => { void requireFreeSpace(directory).catch(abort); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
    child.once('error', (error) => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error('后台下载需要安装 ffmpeg，请检查服务配置') : error));
    child.once('close', (code) => {
      clearTimeout(timer); clearTimeout(forceKill); clearInterval(diskTimer); signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason ?? new Error('下载已取消'));
      else if (killed) reject(new Error('整理视频超时或磁盘空间不足'));
      else if (code !== 0) reject(new Error(`视频整理失败，来源可能缺少分片或格式不受支持${stderr.includes('No space left') ? '（磁盘空间不足）' : ''}`));
      else resolve();
    });
  });
  const stat = await fs.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxJobBytes()) throw new Error('整理后的视频为空或超出空间限制');
  return output;
}
