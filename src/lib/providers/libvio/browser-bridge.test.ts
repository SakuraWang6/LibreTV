import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserBridgeConfigured, browserPageRequest, getLibvioBrowserStatus, openLibvioBrowser, readLibvioBrowserPage } from './browser-client';
import { createBridgeServer, privateDirectory } from '../../../../scripts/libvio-browser/service.cjs';
import { allowedPage, officialUrl, requestSpec } from '../../../../scripts/libvio-browser/protocol.cjs';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (cleanup.length) await cleanup.pop()!();
});
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ltv-bridge-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, socket: path.join(directory, 'bridge.sock') };
}
async function raw(socketPath: string, value: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(value));
    socket.on('data', (part: string) => { response += part; });
    socket.once('end', () => resolve(JSON.parse(response)));
    socket.once('error', reject);
  });
}

describe('restricted browser request protocol', () => {
  it('constructs official search/detail/watch paths from bounded typed fields only', () => {
    expect(requestSpec({ op: 'watch', id: '653', line: 1, episode: 2 })).toEqual({ op: 'page', url: 'https://libvio.host/w/653-1-2.html' });
    const search = requestSpec({ op: 'search', host: 'www.libvio.to', term: '片名 & 年份' });
    expect(new URL(search.url!).searchParams.get('wd')).toBe('片名 & 年份');
    for (const value of [
      { op: 'eval', script: 'x' }, { op: 'detail', id: '../x' },
      { op: 'detail', id: '653', host: '127.0.0.1' },
      { op: 'detail', id: '653', headers: { Cookie: 'x' } },
      { op: 'search', term: 'x'.repeat(101) }, { op: 'watch', id: '653', line: 0, episode: 1 },
    ]) expect(() => requestSpec(value)).toThrow();
  });
  it('denies foreign hosts, credentials, HTTP, custom ports, parser pages and cloud drives', () => {
    for (const url of ['http://libvio.host/', 'https://user@libvio.host/', 'https://libvio.host:9000/', 'https://libvio.host.evil.test/', 'https://127.0.0.1/']) expect(officialUrl(url)).toBeNull();
    expect(allowedPage('https://libvio.host/w/653-1-1.html')).toBe(true);
    expect(allowedPage('https://libvio.host/vid/plyr/vr2.php?url=https://cdn.test/a.mp4')).toBe(false);
    expect(allowedPage('https://pan.quark.cn/s/id')).toBe(false);
    expect(browserPageRequest('https://libvio.host/detail/653.html')).toEqual({ op: 'detail', host: 'libvio.host', id: '653' });
    expect(() => browserPageRequest('https://libvio.host/vid/plyr/vr2.php')).toThrow();
  });
  it('requires profile owner-only permissions and rejects a profile symlink', async () => {
    const { directory } = await temporary();
    const profile = path.join(directory, 'profile');
    await privateDirectory(profile, true);
    expect((await fs.stat(profile)).mode & 0o777).toBe(0o700);
    await fs.chmod(profile, 0o755);
    await expect(privateDirectory(profile, true)).rejects.toThrow();
    const link = path.join(directory, 'linked');
    await fs.symlink(profile, link);
    await expect(privateDirectory(link, true)).rejects.toThrow();
  });
});

describe('private Unix socket browser bridge', () => {
  it('binds mode0600 and rejects malformed or oversized requests before a browser call', async () => {
    const { socket } = await temporary();
    const handler = vi.fn(async () => ({ ok: true }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    expect((await fs.stat(socket)).mode & 0o777).toBe(0o600);
    expect(await raw(socket, '{bad}\n')).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(await raw(socket, 'x'.repeat(4097))).toMatchObject({ ok: false, code: 'invalid-request' });
    expect(handler).not.toHaveBeenCalled();
    await expect(createBridgeServer(socket, handler)).rejects.toThrow('已运行');
  });
  it('does not enable a browser implicitly or on a non-Mac platform', () => {
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', '');
    expect(browserBridgeConfigured()).toBe(false);
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', '/tmp/bridge.sock');
    expect(browserBridgeConfigured()).toBe(process.platform === 'darwin');
  });
  it.runIf(process.platform === 'darwin')('reads bounded DOM without cookie/header arguments and detects mismatched replies', async () => {
    const { socket } = await temporary();
    const handler = vi.fn(async (spec: { url: string }) => ({ ok: true, html: '<h1>片名</h1>', url: spec.url }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    expect(await readLibvioBrowserPage('https://libvio.host/detail/653.html')).toBe('<h1>片名</h1>');
    expect(handler).toHaveBeenCalledWith({ op: 'page', url: 'https://libvio.host/detail/653.html' });
    handler.mockResolvedValueOnce({ ok: true, html: '<h1>另一页</h1>', url: 'https://libvio.host/detail/655.html' });
    await expect(readLibvioBrowserPage('https://libvio.host/detail/654.html')).rejects.toThrow('其他网页');
    await fs.chmod(socket, 0o666);
    await expect(readLibvioBrowserPage('https://libvio.host/detail/656.html')).rejects.toThrow('专用 Chrome');
  });
  it.runIf(process.platform === 'darwin')('reports validation as required and cancels pending reads', async () => {
    const { socket } = await temporary();
    const handler = vi.fn(async () => ({ ok: false, code: 'browser-required' }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    await expect(readLibvioBrowserPage('https://libvio.host/detail/653.html')).rejects.toThrow('专用 Chrome');
    const controller = new AbortController();
    controller.abort();
    await expect(readLibvioBrowserPage('https://libvio.host/detail/653.html', controller.signal)).rejects.toThrow();
  });
  it.runIf(process.platform === 'darwin')('serializes concurrent page reads instead of racing one browser tab', async () => {
    const { socket } = await temporary();
    let active = 0, peak = 0;
    const server = await createBridgeServer(socket, async (spec: { url: string }) => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { ok: true, html: '<h1>片名</h1>', url: spec.url };
    });
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    expect(await Promise.all(['653', '654', '655'].map((id) => readLibvioBrowserPage(`https://libvio.host/detail/${id}.html`)))).toHaveLength(3);
    expect(peak).toBe(1);
  });
  it.runIf(process.platform === 'darwin')('returns only bounded status fields and uses a fixed official open operation', async () => {
    const { socket } = await temporary();
    const handler = vi.fn(async () => ({ ok: true, browserOpen: true, verified: true, busy: false, title: 'LIBVIO', url: 'https://libvio.host/', html: '<secret>', cookies: ['must never export'] }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    expect(await getLibvioBrowserStatus()).toEqual({ ok: true, browserOpen: true, verified: true, busy: false, title: 'LIBVIO', url: 'https://libvio.host/' });
    expect((await openLibvioBrowser()).verified).toBe(true);
    expect(handler).toHaveBeenLastCalledWith({ op: 'open', url: 'https://libvio.host/' });
  });
  it.runIf(process.platform === 'darwin')('caches successful page reads for 60 seconds without mixing IDs or playback lines', async () => {
    const { socket } = await temporary();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const handler = vi.fn(async (spec: { url: string }) => ({ ok: true, html: `<h1>${spec.url}</h1>`, url: spec.url }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    const detail = 'https://libvio.host/detail/653.html';
    expect(await readLibvioBrowserPage(detail)).toBe(await readLibvioBrowserPage(detail));
    expect(handler).toHaveBeenCalledTimes(1);
    await readLibvioBrowserPage('https://libvio.host/detail/654.html');
    await readLibvioBrowserPage('https://libvio.host/w/653-1-1.html');
    await readLibvioBrowserPage('https://libvio.host/w/653-2-1.html');
    expect(handler).toHaveBeenCalledTimes(4);
    clock.mockReturnValue(70_001);
    await readLibvioBrowserPage(detail);
    expect(handler).toHaveBeenCalledTimes(5);
  });
  it.runIf(process.platform === 'darwin')('never caches validation pages and bounds the page cache entry count', async () => {
    const { socket } = await temporary();
    let challenge = true;
    const handler = vi.fn(async (spec: { url: string }) => ({ ok: true, html: challenge ? '<title>正在验证</title>' : '<h1>片名</h1>', url: spec.url }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    for (let i = 0; i < 2; i++) await expect(readLibvioBrowserPage('https://libvio.host/detail/653.html')).rejects.toThrow('专用 Chrome');
    expect(handler).toHaveBeenCalledTimes(2);
    challenge = false;
    for (let i = 1; i <= 33; i++) await readLibvioBrowserPage(`https://libvio.host/detail/${i}.html`);
    expect(handler).toHaveBeenCalledTimes(35);
    await readLibvioBrowserPage('https://libvio.host/detail/1.html');
    expect(handler).toHaveBeenCalledTimes(36);
  });
  it.runIf(process.platform === 'darwin')('does not retain an incomplete watch DOM when the service marks it uncacheable', async () => {
    const { socket } = await temporary();
    const handler = vi.fn(async (spec: { url: string }) => ({ ok: true, html: '<h1>加载中</h1>', url: spec.url, cacheable: false }));
    const server = await createBridgeServer(socket, handler);
    cleanup.push(() => server.close());
    vi.stubEnv('LIBVIO_BROWSER_SOCKET', socket);
    for (let i = 0; i < 2; i++) await readLibvioBrowserPage('https://libvio.host/w/653-1-1.html');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
