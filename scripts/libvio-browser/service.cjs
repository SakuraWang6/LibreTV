#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { MAX_HTML_BYTES, MAX_REQUEST_BYTES, MESSAGE, officialUrl, allowedPage, requestSpec, isChallenge, watchDomReady, failureDiagnostic } = require('./protocol.cjs');
const root = path.resolve(__dirname, '../..');

async function privateDirectory(directory, profile = false) {
  if (!path.isAbsolute(directory)) throw new Error('浏览器桥目录必须是绝对路径');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)
    || (profile && (stat.mode & 0o077))) throw new Error('浏览器桥目录权限不安全');
}

async function createBrowserController(profile) {
  await privateDirectory(profile, true);
  // Separate persistent profile: never attach to a user's existing browser,
  // export cookies/storageState, disable browser security, or spoof fingerprints.
  const { chromium } = require('playwright-core');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, acceptDownloads: false,
    viewport: null, serviceWorkers: 'block',
  });
  await context.clearPermissions();
  let active = context.pages()[0] || await context.newPage();
  let verified = false;
  let busy = false;
  let closed = false;
  context.on('close', () => { closed = true; verified = false; });
  context.on('page', (page) => { if (page !== active) void page.close().catch(() => undefined); });
  context.on('response', (response) => {
    const request = response.request();
    if (request.resourceType() !== 'script' || !officialUrl(request.url()) || response.status() < 400) return;
    console.error('[LIBVIO bridge] ' + JSON.stringify(failureDiagnostic({ name: 'ScriptRequest', code: `HTTP_${response.status()}` }, request.url(), 'resource')));
  });
  context.on('requestfailed', (request) => {
    if (request.resourceType() !== 'script' || !officialUrl(request.url())) return;
    console.error('[LIBVIO bridge] ' + JSON.stringify(failureDiagnostic({ name: 'ScriptRequest', message: request.failure()?.errorText || '' }, request.url(), 'resource')));
  });
  await context.route('**/*', (route) => {
    const request = route.request();
    if (!officialUrl(request.url())) return route.abort('blockedbyclient');
    if (request.isNavigationRequest()) {
      // The bridge needs document HTML, not embedded players, cloud drives or ads.
      if (request.frame() !== active.mainFrame() || !allowedPage(request.url())) return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  // Playwright routing normally disables the HTTP cache. Keep the routing
  // boundary and restore ordinary Chrome caching through this private pipe.
  // This never opens a debugging TCP port or changes verification/fingerprints.
  const cacheSession = await context.newCDPSession(active);
  await cacheSession.send('Network.enable');
  await cacheSession.send('Network.setCacheDisabled', { cacheDisabled: false });
  let cacheHits = 0;
  cacheSession.on('Network.requestServedFromCache', () => { cacheHits++; });
  const read = async (url, foreground) => {
    if (closed || active.isClosed()) return { ok: false, code: 'browser-required', message: MESSAGE };
    if (busy) return { ok: false, code: 'busy', message: 'LIBVIO 浏览器正在读取另一页，请稍后重试。' };
    busy = true;
    let phase = 'navigate';
    try {
      if (foreground) await active.bringToFront();
      const response = await active.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      if (!allowedPage(active.url())) throw new Error('unapproved-navigation');
      phase = 'render';
      // Player iframe attributes may be inserted after DOMContentLoaded. Read
      // only the page DOM; never navigate/execute an embedded player ourselves.
      let cacheable = true;
      if (new URL(url).pathname.startsWith('/w/')) {
        cacheable = await active.waitForFunction(watchDomReady, undefined, { polling: 100, timeout: 2500 }).then(() => true).catch(() => false);
      } else {
        await active.waitForFunction(() => !!document.querySelector('.stui-vodlist, .stui-content, h1'), undefined, { timeout: 1800 }).catch(() => undefined);
      }
      phase = 'snapshot';
      // Read only bounded DOM text. Browser session credentials remain in Chrome.
      const html = await active.evaluate((limit) => {
        const value = document.documentElement?.outerHTML || '';
        return value.length > limit ? null : value;
      }, MAX_HTML_BYTES);
      if (html === null || Buffer.byteLength(html) > MAX_HTML_BYTES) return { ok: false, code: 'too-large', message: 'LIBVIO 网页超过读取上限。' };
      if ([401, 403, 429].includes(response?.status()) || isChallenge(html)) {
        verified = false;
        console.error('[LIBVIO bridge] ' + JSON.stringify(failureDiagnostic({ name: 'BrowserRequired', code: isChallenge(html) ? 'CHALLENGE_PAGE' : `HTTP_${response.status()}` }, url, 'verification')));
        return { ok: false, code: 'browser-required', message: MESSAGE };
      }
      if (response && !response.ok()) return { ok: false, code: 'unavailable', message: `LIBVIO 网页暂不可用（HTTP ${response.status()}）` };
      verified = true;
      return { ok: true, html, url: active.url(), cacheable };
    } catch (error) {
      console.error('[LIBVIO bridge] ' + JSON.stringify(failureDiagnostic(error, url, phase)));
      return { ok: false, code: 'browser-required', message: MESSAGE };
    } finally { busy = false; }
  };
  const status = async () => {
    if (closed || active.isClosed()) return { ok: true, browserOpen: false, verified: false, busy, title: '', url: '' };
    const url = allowedPage(active.url()) ? active.url() : '';
    let title = '';
    try {
      title = (await active.title()).slice(0, 200);
      const dom = await active.evaluate(() => ({
        visible: (document.body?.innerText || '').slice(0, 8192),
        site: !!document.querySelector('.stui-header, .stui-vodlist, .stui-content'),
      }));
      verified = !!url && dom.site && !isChallenge(`<title>${title}</title>${dom.visible}`);
    } catch { verified = false; }
    return { ok: true, browserOpen: true, verified, busy, title, url, cacheHits };
  };
  return {
    async request(spec) {
      if (spec.op === 'status') return status();
      const result = await read(spec.url, spec.op === 'open');
      if (spec.op !== 'open') return result;
      return { ...await status(), ...(!result.ok && { message: result.message }) };
    },
    close: () => context.close(),
  };
}

async function removeStaleSocket(socketPath) {
  const stat = await fs.lstat(socketPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return;
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('浏览器桥 socket 路径不安全');
  const alive = await new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', (error) => resolve(error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT'));
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  });
  if (alive) throw new Error('LIBVIO 浏览器桥已运行');
  const current = await fs.lstat(socketPath).catch(() => null);
  if (current?.ino !== stat.ino) throw new Error('浏览器桥 socket 已改变');
  await fs.unlink(socketPath);
}

async function createBridgeServer(socketPath, handler) {
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 100) throw new Error('浏览器桥 socket 路径过长或不是绝对路径');
  await privateDirectory(path.dirname(socketPath));
  await removeStaleSocket(socketPath);
  const connections = new Set();
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    socket.setTimeout(20_000, () => socket.destroy());
    let received = 0, frame = '', handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      received += Buffer.byteLength(chunk);
      if (received > MAX_REQUEST_BYTES) { handled = true; socket.end(JSON.stringify({ ok: false, code: 'invalid-request' }) + '\n'); return; }
      frame += chunk.toString('utf8');
      if (!frame.includes('\n')) return;
      handled = true;
      let spec;
      try { spec = requestSpec(JSON.parse(frame.slice(0, frame.indexOf('\n')))); }
      catch { socket.end(JSON.stringify({ ok: false, code: 'invalid-request' }) + '\n'); return; }
      Promise.resolve().then(() => handler(spec)).then((result) => {
        const output = JSON.stringify(result);
        socket.end((Buffer.byteLength(output) <= MAX_HTML_BYTES * 2 ? output : JSON.stringify({ ok: false, code: 'too-large' })) + '\n');
      }).catch(() => socket.end(JSON.stringify({ ok: false, code: 'browser-required', message: MESSAGE }) + '\n'));
    });
  });
  server.maxConnections = 4;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const owner = await fs.lstat(socketPath);
  return {
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      const stat = await fs.lstat(socketPath).catch(() => null);
      if (stat?.ino === owner.ino) await fs.unlink(socketPath);
    },
  };
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('浏览器会话桥仅支持 macOS，云端继续使用普通 HTTP provider。');
  process.umask(0o077);
  const socketPath = process.env.LIBVIO_BROWSER_SOCKET || path.join(root, '.local/libvio-browser.sock');
  const profile = process.env.LIBVIO_BROWSER_PROFILE || path.join(root, '.local/libvio-browser-profile');
  let controller;
  let starting;
  const start = () => starting ||= createBrowserController(profile).then((value) => (controller = value)).catch(() => { starting = null; throw new Error(MESSAGE); });
  const service = await createBridgeServer(socketPath, async (spec) => {
    if (spec.op === 'status' && !controller) return { ok: true, browserOpen: false, verified: false, starting: !!starting };
    if (spec.op === 'open' && controller && !(await controller.request({ op: 'status' })).browserOpen) {
      await controller.close().catch(() => undefined);
      controller = undefined;
      starting = null;
    }
    await start();
    return controller.request(spec);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    await controller?.close().catch(() => undefined);
    // A launch already in progress must close too once its context is available.
    if (!controller && starting) await starting.then((value) => value.close()).catch(() => undefined);
  };
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  console.log('LIBVIO 专用浏览器桥已启动（本地 Unix socket；不导出 Cookie）。');
  void start().then(() => controller.request({ op: 'open', url: 'https://libvio.host/' })).catch(() => console.error(MESSAGE));
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { createBrowserController, createBridgeServer, privateDirectory, main };
