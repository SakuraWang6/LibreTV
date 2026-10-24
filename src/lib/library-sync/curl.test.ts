import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { curlRangeResponse } from './curl';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original(), spawn: mocks.spawn }));

const URL = `https://media.example.test/api/library/${'a'.repeat(32)}/media`;
const COOKIE = 'ltv_session=private-test-session';
const HEADERS = 'HTTP/2 206\r\nContent-Type: video/mp4\r\nContent-Length: 4\r\nContent-Range: bytes 2-5/10\r\n\r\n';
interface Plan { headers?: string; body?: Buffer; exitCode?: number; wait?: boolean; missingHeaders?: boolean }
interface Recorded { config?: string; headerFile?: string; privateMode?: number; child: ChildProcess }

function fakeCurl(plan: Plan = {}): Recorded {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const recorded = { child: emitter as ChildProcess } as Recorded;
  let config = '';
  const stdin = new Writable({
    write(chunk, _encoding, callback) { config += chunk.toString(); callback(); },
    final(callback) {
      void (async () => {
        recorded.config = config;
        const headerFile = JSON.parse(config.match(/^dump-header = (".*")$/m)![1]) as string;
        recorded.headerFile = headerFile;
        recorded.privateMode = (await fs.stat(path.dirname(headerFile))).mode & 0o777;
        if (!plan.missingHeaders) await fs.writeFile(headerFile, plan.headers ?? HEADERS);
        callback();
        if (plan.wait) return;
        stdout.end(plan.body ?? Buffer.from('2345'));
        emitter.emit('close', plan.exitCode ?? 0, null);
      })().catch(callback);
    },
  });
  Object.assign(emitter, {
    stdin, stdout, stderr: null,
    kill: vi.fn((signal: string) => { setImmediate(() => emitter.emit('close', null, signal)); return true; }),
  });
  mocks.spawn.mockReturnValue(emitter);
  return recorded;
}

describe('bounded native curl media transport', () => {
  afterEach(() => { mocks.spawn.mockReset(); vi.restoreAllMocks(); });

  it('keeps URL and credentials off argv, disables curlrc/proxies/redirects, and cleans private headers', async () => {
    const record = fakeCurl();
    const response = await curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5', Host: 'attacker.test' });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    const [binary, arguments_, options] = mocks.spawn.mock.calls[0];
    expect(binary).toBe(process.platform === 'darwin' ? '/usr/bin/curl' : 'curl');
    expect(arguments_).toEqual(['-q', '--config', '-']);
    expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(JSON.stringify(arguments_)).not.toContain(COOKIE);
    expect(JSON.stringify(arguments_)).not.toContain(URL);
    expect(record.config).toContain(`header = "Cookie: ${COOKIE}"`);
    expect(record.config).toContain('noproxy = "*"');
    expect(record.config).toContain('proto = "=https"');
    expect(record.config).not.toMatch(/location|insecure|attacker/);
    expect(record.privateMode! & 0o077).toBe(0);
    await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a small 401 JSON body for the normal remote session renewal logic', async () => {
    const record = fakeCurl({ headers: 'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n', body: Buffer.from('{"error":"login"}') });
    const response = await curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=0-0' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'login' });
    await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns redirects without following them or exposing the session to another server', async () => {
    fakeCurl({ headers: 'HTTP/2 302\r\nLocation: https://attacker.test/\r\n\r\n', body: Buffer.alloc(0) });
    const response = await curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' });
    expect(response.status).toBe(302);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('parses only the final response header block', async () => {
    fakeCurl({ headers: `HTTP/1.1 100 Continue\r\n\r\n${HEADERS}` });
    expect((await curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' })).status).toBe(206);
  });

  it('rejects unsafe URLs and unbounded/oversized/multiple ranges before spawning', async () => {
    for (const value of [URL.replace('https:', 'http:'), URL.replace('media.example.test', 'user:password@media.example.test'), `${URL}?next=1`, `${URL}#fragment`, URL.replace(/\/media$/, '/poster')]) {
      await expect(curlRangeResponse(value, { Cookie: COOKIE, Range: 'bytes=0-3' })).rejects.toThrow();
    }
    for (const Range of ['bytes=0-', 'bytes=-3', 'bytes=0-1,3-4', 'bytes=0-4194304', 'bytes=5-4', 'bytes=9007199254740992-9007199254740993']) {
      await expect(curlRangeResponse(URL, { Cookie: COOKIE, Range })).rejects.toThrow();
    }
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('kills a response that exceeds the strict range plus small error allowance', async () => {
    const record = fakeCurl({ body: Buffer.alloc(4 + 4096 + 1) });
    await expect(curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' })).rejects.toThrow('超过预期大小');
    expect(record.child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a pending child promptly and removes its private directory', async () => {
    const record = fakeCurl({ wait: true });
    const controller = new AbortController();
    const pending = curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' }, controller.signal);
    await vi.waitFor(() => expect(record.headerFile).toBeDefined());
    controller.abort(new Error('private URL or session must not escape'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: '缓存任务已取消' });
    expect(record.child.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not launch an already cancelled request', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects wrong ranges, incomplete media and excessive headers, always cleaning up', async () => {
    for (const plan of [{ headers: HEADERS.replace('2-5/10', '3-6/10') }, { body: Buffer.from('23') }, { headers: HEADERS + 'x'.repeat(65536) }]) {
      const record = fakeCurl(plan);
      await expect(curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' })).rejects.toThrow();
      await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('maps timeout, certificate and filesystem errors to safe messages', async () => {
    for (const [plan, expected] of [[{ exitCode: 28 }, '连接服务器超时'], [{ exitCode: 60 }, '服务器证书验证失败'], [{ missingHeaders: true }, '原生下载暂时无法完成']] as const) {
      const record = fakeCurl(plan);
      const error = await curlRangeResponse(URL, { Cookie: COOKIE, Range: 'bytes=2-5' }).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(expected);
      expect((error as Error).message).not.toMatch(/private-test-session|https:\/\/|libretv-curl-/);
      await expect(fs.stat(path.dirname(record.headerFile!))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

it.skipIf(process.env.LIBRARY_CURL_INTEGRATION !== '1')('reads an authenticated local HTTPS range with a trusted test CA and rejects an untrusted certificate', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  mocks.spawn.mockImplementation(actual.spawn);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-curl-tls-test-'));
  const certificate = path.join(directory, 'ca.pem'); const key = path.join(directory, 'key.pem');
  let server: https.Server | undefined;
  const originalCA = process.env.CURL_CA_BUNDLE;
  try {
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost']);
    server = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, (request, response) => {
      if (request.headers.cookie !== COOKIE) { response.writeHead(401); response.end('{}'); return; }
      expect(request.headers.range).toBe('bytes=2-5');
      response.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10', 'Content-Length': '4' }); response.end('2345');
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as { port: number };
    const url = `https://127.0.0.1:${address.port}/api/library/${'a'.repeat(32)}/media`;
    process.env.CURL_CA_BUNDLE = certificate;
    expect(await (await curlRangeResponse(url, { Cookie: COOKIE, Range: 'bytes=2-5' })).text()).toBe('2345');
    delete process.env.CURL_CA_BUNDLE;
    await expect(curlRangeResponse(url, { Cookie: COOKIE, Range: 'bytes=2-5' })).rejects.toThrow('服务器证书验证失败');
  } finally {
    if (originalCA === undefined) delete process.env.CURL_CA_BUNDLE; else process.env.CURL_CA_BUNDLE = originalCA;
    await new Promise<void>((resolve) => { if (server?.listening) server.close(() => resolve()); else resolve(); });
    await fs.rm(directory, { recursive: true, force: true });
    mocks.spawn.mockReset();
  }
}, 20_000);
