import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_RANGE = 4 * 1024 * 1024;
const ERROR_ALLOWANCE = 4096;
const MAX_HEADERS = 64 * 1024;
class CurlError extends Error {}

function quote(value: string): string { return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function cancelled(signal?: AbortSignal): Error {
  return signal?.reason?.name === 'TimeoutError'
    ? new DOMException('连接服务器超时，请检查网络后重试', 'TimeoutError')
    : new DOMException('缓存任务已取消', 'AbortError');
}

function requestOf(value: string, input: HeadersInit): { url: string; range: string; start: number; end: number; expected: number; cookie: string | null } {
  let url: URL;
  try { url = new URL(value); } catch { throw new CurlError('无效的云端媒体地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/api\/library\/[a-f0-9]{32}\/media$/.test(url.pathname)) throw new CurlError('只允许固定的 HTTPS 云端媒体地址');
  let headers: Headers;
  try { headers = new Headers(input); } catch { throw new CurlError('无效的云端请求头'); }
  const range = headers.get('range');
  const match = range?.match(/^bytes=(\d+)-(\d+)$/);
  if (!match) throw new CurlError('原生下载需要单个有界的视频范围');
  const start = Number(match[1]); const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start + 1 > MAX_RANGE) throw new CurlError('视频范围必须小于或等于 4 MiB');
  const cookie = headers.get('cookie');
  if (cookie && /[\r\n\0]/.test(cookie)) throw new CurlError('无效的云端登录会话');
  return { url: url.href, range: range!, start, end, expected: end - start + 1, cookie };
}

async function responseHeaders(file: string): Promise<{ status: number; headers: Headers }> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    if ((await handle.stat()).size > MAX_HEADERS) throw new CurlError('服务器响应头过大');
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const blocks = text.trim().split(/\r?\n\r?\n/);
  const block = blocks.filter((section) => /^HTTP\/\S+\s+[1-5]\d\d(?:\s|$)/.test(section)).at(-1);
  if (!block) throw new CurlError('服务器没有返回有效的视频响应');
  const [first, ...lines] = block.split(/\r?\n/);
  const status = Number(first.match(/^HTTP\/\S+\s+([1-5]\d\d)/)![1]);
  const headers = new Headers();
  try {
    for (const line of lines) {
      const match = /^([^:\s]+):\s*(.*)$/.exec(line);
      if (!match) throw new Error('Invalid header');
      headers.append(match[1], match[2]);
    }
  } catch { throw new CurlError('服务器返回的响应头格式不正确'); }
  return { status, headers };
}

/** Native macOS HTTPS range reader. Credentials are sent on stdin, never argv. */
export async function curlRangeResponse(url: string, headers: HeadersInit, signal?: AbortSignal): Promise<Response> {
  const request = requestOf(url, headers);
  if (signal?.aborted) throw cancelled(signal);
  let temporary: string;
  try { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-curl-')); }
  catch { throw new CurlError('无法创建原生下载临时目录'); }
  const headerFile = path.join(temporary, 'headers');
  const maximum = request.expected + ERROR_ALLOWANCE;
  const config = [
    `url = ${quote(request.url)}`, 'request = "GET"', 'silent',
    'noproxy = "*"', 'proto = "=https"', 'max-time = 60', 'connect-timeout = 15',
    `max-filesize = ${maximum}`, `dump-header = ${quote(headerFile)}`,
    `header = ${quote(`Range: ${request.range}`)}`,
    ...(request.cookie ? [`header = ${quote(`Cookie: ${request.cookie}`)}`] : []),
  ].join('\n') + '\n';
  try {
    const body = await new Promise<Buffer>((resolve, reject) => {
      // -q must be first: neither ~/.curlrc nor inherited proxy variables may
      // change this trusted, non-redirecting request into a different transport.
      const child = spawn(process.platform === 'darwin' ? '/usr/bin/curl' : 'curl', ['-q', '--config', '-'], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const stop = (error: Error) => {
        if (failure || closed) return;
        failure = error;
        child.kill('SIGTERM');
        forceKill = setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000);
        forceKill.unref();
      };
      const abort = () => stop(cancelled(signal));
      const timeout = setTimeout(() => stop(new DOMException('连接服务器超时，请检查网络后重试', 'TimeoutError')), 60_000);
      timeout.unref();
      const cleanup = () => { closed = true; clearTimeout(timeout); clearTimeout(forceKill); signal?.removeEventListener('abort', abort); };
      child.stdout!.on('data', (value: Buffer) => {
        if (failure) return;
        bytes += value.byteLength;
        if (bytes > maximum) { stop(new CurlError('服务器返回的视频片段超过预期大小')); return; }
        chunks.push(value);
      });
      child.stdin!.on('error', () => stop(new CurlError('原生下载请求无法发送')));
      child.once('error', () => { cleanup(); reject(new CurlError('无法启动系统 curl 下载程序')); });
      child.once('close', (code) => {
        cleanup();
        if (failure) { reject(failure); return; }
        if (code !== 0) {
          reject(code === 28 ? new DOMException('连接服务器超时，请检查网络后重试', 'TimeoutError')
            : new CurlError(code === 60 ? '服务器证书验证失败，请检查 HTTPS 配置' : code === 63 ? '服务器返回的视频片段超过预期大小' : '连接服务器失败，请检查网络后重试'));
          return;
        }
        resolve(Buffer.concat(chunks, bytes));
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      if (!failure) child.stdin!.end(config);
    });
    const response = await responseHeaders(headerFile);
    if (response.status === 206) {
      const contentRange = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      if (!contentRange || Number(contentRange[1]) !== request.start || Number(contentRange[2]) !== request.end || !Number.isSafeInteger(Number(contentRange[3])) || Number(contentRange[3]) <= request.end) throw new CurlError('服务器返回的视频范围不正确');
      if (body.byteLength !== request.expected) throw new CurlError('服务器返回的视频片段不完整');
    }
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(body), { status: response.status, headers: response.headers });
  } catch (error) {
    if (error instanceof CurlError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))) throw error;
    throw new CurlError('原生下载暂时无法完成，请检查网络后重试');
  } finally { await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined); }
}
