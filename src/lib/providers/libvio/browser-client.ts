import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { libvioPageUrl } from './source';
import { isLibvioChallenge } from './parse';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const MESSAGE = '请启动 LibreTV 专用 Chrome，并在该窗口完成 LIBVIO 网页验证后重试。';
const PAGE_CACHE_TTL = 60_000;
const PAGE_CACHE_LIMIT = 8 * 1024 * 1024;
const pageCache = new Map<string, { html: string; expires: number; bytes: number }>();
let pageCacheBytes = 0;

function forgetPage(key: string) {
  const entry = pageCache.get(key);
  if (entry) pageCacheBytes -= entry.bytes;
  pageCache.delete(key);
}
function cachedPage(key: string): string | undefined {
  const entry = pageCache.get(key);
  if (!entry) return;
  if (entry.expires <= Date.now()) { forgetPage(key); return; }
  pageCache.delete(key); pageCache.set(key, entry);
  return entry.html;
}
function cachePage(key: string, html: string) {
  forgetPage(key);
  const bytes = Math.max(Buffer.byteLength(html), html.length * 2);
  for (const [existing, entry] of pageCache) if (entry.expires <= Date.now()) forgetPage(existing);
  while (pageCache.size && (pageCache.size >= 32 || pageCacheBytes + bytes > PAGE_CACHE_LIMIT)) forgetPage(pageCache.keys().next().value!);
  pageCache.set(key, { html, bytes, expires: Date.now() + PAGE_CACHE_TTL });
  pageCacheBytes += bytes;
}

export class LibvioBrowserRequired extends Error {}

export function browserBridgeConfigured(): boolean {
  return process.platform === 'darwin' && !!process.env.LIBVIO_BROWSER_SOCKET?.trim();
}

export type LibvioBrowserRequest = { op: 'search'; host: string; term: string }
  | { op: 'detail'; host: string; id: string }
  | { op: 'watch'; host: string; id: string; line: number; episode: number };

/** Convert a provider-created URL to a fixed operation, never an arbitrary browser URL. */
export function browserPageRequest(raw: string): LibvioBrowserRequest {
  const permitted = libvioPageUrl(raw, 'https://libvio.host');
  if (!permitted) throw new LibvioBrowserRequired('LIBVIO 浏览器只允许官方网页。');
  const url = new URL(permitted);
  if (url.pathname === '/search/-------------.html') {
    const term = url.searchParams.get('wd') || '';
    if (!term.trim() || term.length > 100) throw new LibvioBrowserRequired('LIBVIO 搜索词无效。');
    return { op: 'search', host: url.hostname, term };
  }
  const detail = url.pathname.match(/^\/detail\/(\d{1,18})\.html$/);
  if (detail) return { op: 'detail', host: url.hostname, id: detail[1] };
  const watch = url.pathname.match(/^\/w\/(\d{1,18})-(\d{1,4})-(\d{1,5})\.html$/);
  if (watch && Number(watch[2]) > 0 && Number(watch[3]) > 0) {
    return { op: 'watch', host: url.hostname, id: watch[1], line: Number(watch[2]), episode: Number(watch[3]) };
  }
  throw new LibvioBrowserRequired('LIBVIO 浏览器网页路径不在允许范围。');
}

type RpcRequest = LibvioBrowserRequest | { op: 'status' | 'open' };
interface RpcResponse { ok?: boolean; code?: string; html?: unknown; url?: unknown; title?: unknown; browserOpen?: unknown; verified?: unknown; busy?: unknown; message?: unknown; cacheable?: boolean }
export interface LibvioBrowserStatus { ok: boolean; browserOpen: boolean; verified: boolean; busy: boolean; title: string; url: string; message?: string }

let rpcTail: Promise<unknown> = Promise.resolve();
let pending = 0;
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  if (pending >= 16) return Promise.reject(new LibvioBrowserRequired('LIBVIO 浏览器读取队列已满，请稍后重试。'));
  pending++;
  const result = rpcTail.then(operation).finally(() => { pending--; });
  rpcTail = result.catch(() => undefined);
  return result;
}

/** Private, same-user Unix socket. No cookies, browser commands or public HTTP endpoint. */
async function rpc(spec: RpcRequest, signal?: AbortSignal): Promise<RpcResponse> {
  if (!browserBridgeConfigured()) throw new LibvioBrowserRequired(MESSAGE);
  const socketPath = process.env.LIBVIO_BROWSER_SOCKET!.trim();
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new LibvioBrowserRequired(MESSAGE);
  const stat = await fs.lstat(socketPath).catch(() => null);
  if (!stat?.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new LibvioBrowserRequired(MESSAGE);
  signal?.throwIfAborted();
  return new Promise<RpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let size = 0, frame = '', settled = false;
    const finish = (error?: Error, result?: RpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new LibvioBrowserRequired('LIBVIO 浏览器读取已取消或超时，请重试。'));
    const timer = setTimeout(() => finish(new LibvioBrowserRequired(MESSAGE)), 22_000);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => socket.write(JSON.stringify(spec) + '\n'));
    socket.on('error', () => finish(new LibvioBrowserRequired(MESSAGE)));
    socket.once('end', () => { if (!settled) finish(new LibvioBrowserRequired(MESSAGE)); });
    socket.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_RESPONSE_BYTES) { finish(new LibvioBrowserRequired('LIBVIO 浏览器返回内容超过上限。')); return; }
      frame += chunk;
      const newline = frame.indexOf('\n');
      if (newline < 0) return;
      try {
        const result = JSON.parse(frame.slice(0, newline)) as RpcResponse;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid-response');
        finish(undefined, result);
      } catch { finish(new LibvioBrowserRequired(MESSAGE)); }
    });
  });
}

export function readLibvioBrowserPage(raw: string, signal?: AbortSignal): Promise<string> {
  const spec = browserPageRequest(raw);
  const key = `${process.env.LIBVIO_BROWSER_SOCKET || ''}\n${JSON.stringify(spec)}`;
  return serialize(async () => {
    signal?.throwIfAborted();
    const cached = cachedPage(key);
    if (cached !== undefined) return cached;
    const result = await rpc(spec, signal);
    if (!result.ok || typeof result.html !== 'string' || Buffer.byteLength(result.html) > MAX_HTML_BYTES
      || typeof result.url !== 'string' || !libvioPageUrl(result.url, raw)) throw new LibvioBrowserRequired(MESSAGE);
    // Confirm the browser returned the requested provider page, including host.
    if (JSON.stringify(browserPageRequest(result.url)) !== JSON.stringify(spec)) {
      throw new LibvioBrowserRequired('LIBVIO 浏览器跳转到了其他网页，请在专用窗口检查。');
    }
    if (isLibvioChallenge(result.html)) throw new LibvioBrowserRequired(MESSAGE);
    if (result.cacheable !== false) cachePage(key, result.html);
    return result.html;
  });
}

function statusSummary(result: RpcResponse): LibvioBrowserStatus {
  return {
    ok: result.ok === true, browserOpen: result.browserOpen === true, verified: result.verified === true, busy: result.busy === true,
    title: typeof result.title === 'string' ? result.title.slice(0, 200) : '',
    url: typeof result.url === 'string' && libvioPageUrl(result.url, 'https://libvio.host') ? result.url.slice(0, 4096) : '',
    ...(typeof result.message === 'string' && { message: result.message.slice(0, 300) }),
  };
}

/** Status is independent of the page queue, so the UI can show ongoing verification. */
export async function getLibvioBrowserStatus(signal?: AbortSignal): Promise<LibvioBrowserStatus> {
  return statusSummary(await rpc({ op: 'status' }, signal));
}

export function openLibvioBrowser(signal?: AbortSignal): Promise<LibvioBrowserStatus> {
  return serialize(async () => statusSummary(await rpc({ op: 'open' }, signal)));
}
