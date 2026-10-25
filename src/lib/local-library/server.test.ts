import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { NodeNextRequest } from 'next/dist/server/base-http/node';
import { NextRequestAdapter } from 'next/dist/server/web/spec-extension/adapters/next-request';
import { addRequestMeta } from 'next/dist/server/request-meta';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession, SESSION_COOKIE } from '@/lib/auth';
import { GET as list } from '@/app/api/library/route';
import { POST as create } from '@/app/api/library/uploads/route';
import { PUT as append, DELETE as cancel } from '@/app/api/library/uploads/[id]/route';
import { POST as complete } from '@/app/api/library/uploads/[id]/complete/route';
import { PATCH as progress } from '@/app/api/library/[id]/route';
import { PATCH as metadata } from '@/app/api/library/[id]/metadata/route';
import { GET as media, HEAD as mediaHead } from '@/app/api/library/[id]/media/route';
import { GET as poster } from '@/app/api/library/[id]/poster/route';
import type { LibraryEntry, LibraryMetadata } from './types';

const BASE = 'http://127.0.0.1:8899';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=', 'base64');
let directory: string;
let cookie: string;
const context = (id: string) => ({ params: Promise.resolve({ id }) });

function request(url: string, method = 'GET', body?: BodyInit, headers: HeadersInit = {}): Request {
  return new Request(`${BASE}${url}`, { method, body, headers: { cookie, ...headers } });
}

function adaptedRequest(internalOrigin: string, headers: Record<string, string>): Request {
  // Match production NextServer's internal initURL and retained public Host.
  const incoming = new IncomingMessage(new Socket());
  incoming.method = 'POST';
  incoming.url = '/api/library/uploads';
  incoming.headers = { cookie, ...headers };
  incoming.push(JSON.stringify({ metadata: { title: 'Next production request', kind: 'movie' }, format: 'MP4' }));
  incoming.push(null);
  const nodeRequest = new NodeNextRequest(incoming);
  addRequestMeta(nodeRequest, 'initURL', `${internalOrigin}/api/library/uploads`);
  return NextRequestAdapter.fromNodeNextRequest(nodeRequest, new AbortController().signal);
}

async function begin(metadata: LibraryMetadata = { title: '测试电影', kind: 'movie', year: '2026' }, format = 'MP4'): Promise<string> {
  const response = await create(request('/api/library/uploads', 'POST', JSON.stringify({ metadata, format })));
  expect(response.status).toBe(200);
  const value = await response.json();
  expect(value.offset).toBe(0);
  return value.id;
}

async function put(id: string, value: string, offset = 0) {
  return append(request(`/api/library/uploads/${id}?offset=${offset}`, 'PUT', value), context(id));
}

async function finish(id: string): Promise<LibraryEntry> {
  const response = await complete(request(`/api/library/uploads/${id}/complete`, 'POST'), context(id));
  expect(response.status).toBe(200);
  return (await response.json()).item;
}

async function add(metadata?: LibraryMetadata, value = '0123456789') {
  const id = await begin(metadata);
  expect((await put(id, value)).status).toBe(200);
  return finish(id);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-library-test-'));
  vi.stubEnv('LOCAL_LIBRARY_DIR', directory);
  vi.stubEnv('PASSWORD', 'library-test-password');
  vi.stubEnv('PROXY_SECRET', 'library-test-secret');
  vi.stubEnv('PUBLIC_ORIGIN', '');
  cookie = `${SESSION_COOKIE}=${signSession().token}`;
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Tests must not make network requests'))));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local library authenticated disk API', () => {
  it('is optional and guards every endpoint before reading or modifying the disk', async () => {
    vi.stubEnv('LOCAL_LIBRARY_DIR', '');
    const disabled = await list(request('/api/library'));
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ enabled: false, items: [] });
    const id = 'a'.repeat(32);
    const unauthenticated = (method: string) => new Request(`${BASE}/api/library`, { method });
    const calls = [
      list(unauthenticated('GET')), create(unauthenticated('POST')),
      append(unauthenticated('PUT'), context(id)), cancel(unauthenticated('DELETE'), context(id)),
      complete(unauthenticated('POST'), context(id)), progress(unauthenticated('PATCH'), context(id)), metadata(unauthenticated('PATCH'), context(id)),
      media(unauthenticated('GET'), context(id)), mediaHead(unauthenticated('HEAD'), context(id)), poster(unauthenticated('GET'), context(id)),
    ];
    expect((await Promise.all(calls)).map((response) => response.status)).toEqual(Array(10).fill(401));
    vi.stubEnv('PASSWORD', '');
    expect((await list(request('/api/library'))).status).toBe(503);
  });

  it('rejects cross-origin writes, mismatched Host and cross-site requests while allowing native CLI writes', async () => {
    const hostileHeaders: Record<string, string>[] = [{ origin: 'https://attacker.test' }, { origin: 'null' }, { host: 'attacker.test' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of hostileHeaders) {
      const response = await create(request('/api/library/uploads', 'POST', '{}', headers));
      expect(response.status).toBe(403);
      expect((await metadata(request(`/api/library/${'a'.repeat(32)}/metadata`, 'PATCH', '{}', headers), context('a'.repeat(32)))).status).toBe(403);
    }
    const id = await begin(); // no Origin: authenticated local CLI
    const response = await put(id, 'data');
    expect(response.status).toBe(200);
    const sameOrigin = await complete(request(`/api/library/uploads/${id}/complete`, 'POST', undefined, { origin: BASE, host: '127.0.0.1:8899' }), context(id));
    expect(sameOrigin.status).toBe(200);
  });

  it('accepts actual Next request adaptation when the listen hostname differs from the browser Host', async () => {
    // Production NextServer sets initURL with fetchHostname, then this adapter
    // turns that internal URL into Request.url while preserving public Host.
    const adapted = (listenHost: string, origin?: string, host = '127.0.0.1:8899') => adaptedRequest(`http://${listenHost}:8899`, { host, ...(origin ? { origin } : {}) });
    for (const listenHost of ['localhost', '0.0.0.0', '[::]']) {
      const browserRequest = adapted(listenHost, BASE);
      expect(new URL(browserRequest.url).hostname).toBe(listenHost);
      expect((await create(browserRequest)).status).toBe(200);
      expect((await create(adapted(listenHost))).status).toBe(200); // local CLI has no Origin
    }
    expect((await create(adapted('localhost', 'http://localhost:8899'))).status).toBe(403);
    expect((await create(adapted('localhost', 'https://attacker.test'))).status).toBe(403);
    expect((await create(adapted('localhost', undefined, 'attacker.test:8899'))).status).toBe(403);
    expect((await create(adapted('localhost', undefined, '127.0.0.1:9999'))).status).toBe(403);
  });

  it('accepts an explicitly configured public origin through a real HTTPS-terminating reverse proxy', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://media.example.test/');
    const internalOrigin = 'http://localhost:8899';
    const cases: Record<string, string>[] = [
      { host: 'media.example.test', origin: 'https://media.example.test' },
      { host: 'media.example.test:443', origin: 'https://media.example.test' },
      { host: 'media.example.test' }, // Authenticated native clients omit Origin.
      { host: 'media.example.test', origin: 'https://media.example.test', 'x-forwarded-host': 'attacker.test', 'x-forwarded-proto': 'http' },
    ];
    for (const headers of cases) {
      const incoming = adaptedRequest(internalOrigin, headers);
      expect(new URL(incoming.url).origin).toBe(internalOrigin);
      expect((await create(incoming)).status).toBe(200);
    }
  });

  it('rejects forged public origins, actual Hosts and forwarding headers', async () => {
    vi.stubEnv('PUBLIC_ORIGIN', 'https://media.example.test');
    const cases: Record<string, string>[] = [
      { host: 'media.example.test', origin: 'https://attacker.test' },
      { host: 'media.example.test', origin: 'http://media.example.test' },
      { host: 'media.example.test', origin: 'https://media.example.test:444' },
      { host: 'media.example.test', origin: 'null' },
      { host: 'media.example.test', origin: 'https://media.example.test', 'sec-fetch-site': 'cross-site' },
      { host: 'attacker.test', origin: 'https://media.example.test' },
      { host: 'media.example.test:444', origin: 'https://media.example.test' },
      { host: 'media.example.test@attacker.test', origin: 'https://media.example.test' },
      { host: '127.0.0.1:8899', origin: 'https://media.example.test', 'x-forwarded-host': 'media.example.test', 'x-forwarded-proto': 'https' },
      { origin: 'https://media.example.test', 'x-forwarded-host': 'media.example.test', 'x-forwarded-proto': 'https' },
    ];
    for (const headers of cases) {
      expect((await create(adaptedRequest('http://127.0.0.1:8899', headers))).status).toBe(403);
    }
  });

  it('fails closed for invalid configured public origins', async () => {
    for (const configuredOrigin of ['invalid', 'ftp://media.example.test', 'https://media.example.test/library', 'https://user:password@media.example.test', 'https://media.example.test?redirect=1', 'https://media.example.test#fragment']) {
      vi.stubEnv('PUBLIC_ORIGIN', configuredOrigin);
      expect((await create(adaptedRequest('http://127.0.0.1:8899', { host: 'media.example.test', origin: 'https://media.example.test' }))).status).toBe(403);
    }
  });

  it('validates classification, format, season and JSON without leaking internal paths', async () => {
    for (const data of [
      { metadata: { title: 'Missing classification' }, format: 'MP4' },
      { metadata: { title: 'Movie', kind: 'movie' }, format: 'AVI' },
      { metadata: { title: 'Series', kind: 'tv', seasonNumber: -1 }, format: 'MP4' },
    ]) expect((await create(request('/api/library/uploads', 'POST', JSON.stringify(data)))).status).toBe(400);
    expect((await create(request('/api/library/uploads', 'POST', 'broken'))).status).toBe(400);
    const missing = await media(request('/api/library/invalid/media'), context('../../etc/passwd'));
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(directory);
  });

  it('keeps partial uploads invisible, commits to a readable movie folder and completes idempotently', async () => {
    const id = await begin({ title: '../影片/标题', kind: 'movie', year: '2025' });
    expect((await (await list(request('/api/library'))).json()).items).toEqual([]);
    await put(id, '01234');
    expect((await (await list(request('/api/library'))).json()).items).toEqual([]);
    await put(id, '56789', 5);
    const item = await finish(id);
    expect(item).toMatchObject({ id, bytes: 10, title: '../影片/标题', kind: 'movie', mediaUrl: `/api/library/${id}/media`, posterUrl: `/api/library/${id}/poster` });
    expect(await finish(id)).toEqual(item);
    const files = await fs.readdir(path.join(directory, '电影', '_影片_标题 (2025)'));
    expect(files).toEqual([`_影片_标题 [${id}].mp4`]);
    const result = await (await list(request('/api/library'))).json();
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain('mediaPath');
    expect(await fs.readdir(path.join(directory, '.libretv', 'uploads'))).toEqual([]);
  });

  it('accepts identical chunk retries and rejects changed, out-of-order or oversized chunks', async () => {
    const id = await begin();
    expect(await (await put(id, 'abc')).json()).toEqual({ offset: 3 });
    expect(await (await put(id, 'abc')).json()).toEqual({ offset: 3 });
    expect((await put(id, 'abd')).status).toBe(409);
    expect((await put(id, 'future', 20)).status).toBe(409);
    expect(await (await put(id, 'def', 3)).json()).toEqual({ offset: 6 });
    expect(await (await put(id, 'abc')).json()).toEqual({ offset: 6 });
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);
    expect((await append(request(`/api/library/uploads/${id}?offset=6`, 'PUT', oversized), context(id))).status).toBe(413);
    expect((await finish(id)).bytes).toBe(6);
  });

  it('serializes simultaneous retries and publishes concurrent uploads without losing records or overwriting files', async () => {
    const id = await begin();
    const responses = await Promise.all([put(id, 'abcdefgh'), put(id, 'abcdefgh')]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ offset: 8 }, { offset: 8 }]);
    const second = await begin();
    await put(second, 'different');
    await Promise.all([finish(id), finish(second)]);
    expect((await (await list(request('/api/library'))).json()).items).toHaveLength(2);
    const files = await fs.readdir(path.join(directory, '电影', '测试电影 (2026)'));
    expect(files).toHaveLength(2);
    expect((await Promise.all(files.map((file) => fs.readFile(path.join(directory, '电影', '测试电影 (2026)', file), 'utf8')))).sort()).toEqual(['abcdefgh', 'different']);
  });

  it('organizes series by season and episode, defaulting unprovided season/episode to one', async () => {
    const first = await add({ title: '测试剧集', kind: 'tv' });
    const second = await add({ title: '测试剧集', kind: 'tv', seasonNumber: 2, episodeNumber: 12, episodeTitle: '最后一集' });
    expect(first).toMatchObject({ seasonNumber: 1, episodeNumber: 1 });
    expect(first.groupId).toBe(second.groupId);
    expect(await fs.readdir(path.join(directory, '电视剧', '测试剧集', '第01季'))).toEqual([`第01集 [${first.id}].mp4`]);
    expect(await fs.readdir(path.join(directory, '电视剧', '测试剧集', '第02季'))).toEqual([`第12集-最后一集 [${second.id}].mp4`]);
  });

  it('streams complete and ranged media, supports HEAD, and returns correct unsatisfied ranges', async () => {
    const item = await add();
    const full = await media(request(item.mediaUrl), context(item.id));
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(await full.text()).toBe('0123456789');
    for (const [range, content, expected] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10'],
    ]) {
      const response = await media(request(item.mediaUrl, 'GET', undefined, { range }), context(item.id));
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(expected);
      expect(response.headers.get('content-length')).toBe(String(content.length));
      expect(await response.text()).toBe(content);
    }
    for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=0-1,4-5', 'invalid']) {
      const response = await media(request(item.mediaUrl, 'GET', undefined, { range }), context(item.id));
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */10');
    }
    const head = await mediaHead(request(item.mediaUrl, 'HEAD', undefined, { range: 'bytes=3-6' }), context(item.id));
    expect(head.status).toBe(206);
    expect(head.headers.get('content-length')).toBe('4');
    expect(await head.text()).toBe('');
  });

  it('closes real file handles on request abort and reader cancellation and removes abort listeners', async () => {
    // A file much larger than the bridge buffer ensures cancellation happens
    // while a read stream owns an open descriptor, rather than after EOF.
    const item = await add(undefined, 'x'.repeat(2 * 1024 * 1024));
    const originalOpen = fs.open.bind(fs);
    const handles: FileHandle[] = [];
    const openSpy = vi.spyOn(fs, 'open').mockImplementation(async (...arguments_) => {
      const handle = await originalOpen(...arguments_);
      if (String(arguments_[0]).endsWith('.mp4')) handles.push(handle);
      return handle;
    });
    try {
      for (const mode of ['request-abort', 'reader-cancel', 'already-aborted'] as const) {
        const controller = new AbortController();
        const incoming = new Request(`${BASE}${item.mediaUrl}`, { headers: { cookie, range: 'bytes=0-' }, signal: controller.signal });
        const remove = vi.spyOn(incoming.signal, 'removeEventListener');
        if (mode === 'already-aborted') controller.abort();
        const response = await media(incoming, context(item.id));
        expect(response.status).toBe(206);
        const handle = handles.at(-1)!;
        const reader = response.body!.getReader();
        if (mode === 'already-aborted') {
          await reader.read().catch(() => undefined);
        } else {
          expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
          expect(handle.fd).toBeGreaterThanOrEqual(0);
          if (mode === 'request-abort') controller.abort();
          else await reader.cancel();
        }
        await vi.waitFor(() => {
          expect(handle.fd).toBe(-1);
          expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
        });
        await reader.cancel().catch(() => undefined);
        remove.mockRestore();
      }
    } finally { openSpy.mockRestore(); }
  });

  it('caches validated raster posters at commit and makes list/poster/media fully independent of network', async () => {
    const fetchSpy = vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const item = await add({ title: '离线海报电影', kind: 'movie', coverUrl: 'https://93.184.216.34/poster.png' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline'); }));
    const response = await poster(request(item.posterUrl), context(item.id));
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect((await (await list(request('/api/library'))).json()).items).toHaveLength(1);
    expect(await (await media(request(item.mediaUrl), context(item.id))).text()).toBe('0123456789');
    expect(fetch).not.toHaveBeenCalled();
    const manifest = await fs.readFile(path.join(directory, '.libretv', 'items', `${item.id}.json`), 'utf8');
    expect(manifest).not.toContain('93.184.216.34');
  });

  it('rejects private poster targets and redirects and safely escapes generated SVG text', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    vi.stubGlobal('fetch', fetchSpy);
    const privateItem = await add({ title: '<script>alert(1)</script>', kind: 'movie', coverUrl: 'http://127.0.0.1/private' });
    expect(fetchSpy).not.toHaveBeenCalled();
    const response = await poster(request(privateItem.posterUrl), context(privateItem.id));
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const svg = await response.text();
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    await add({ title: 'Redirect test', kind: 'movie', coverUrl: 'https://93.184.216.34/poster.png' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not trust SVG, HTML or oversized cover responses and still completes media import', async () => {
    for (const [content, type, size] of [
      ['<svg onload="alert(1)"/>', 'image/svg+xml', '20'],
      ['<html>unsafe</html>', 'image/png', '20'],
      ['abc', 'image/png', String(5 * 1024 * 1024 + 1)],
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(content, { headers: { 'content-type': type, 'content-length': size } })));
      const item = await add({ title: `海报测试-${type}-${size}`, kind: 'movie', coverUrl: 'https://93.184.216.34/poster' });
      const response = await poster(request(item.posterUrl), context(item.id));
      expect(response.headers.get('content-type')).toContain('image/svg+xml');
      expect(await response.text()).not.toContain('onload');
    }
  });

  it('updates descriptive metadata and grouping without moving media or changing progress', async () => {
    const item = await add({ title: '原片名', kind: 'movie', year: '1972' });
    expect(item.hasPoster).toBe(false);
    const manifestFile = path.join(directory, '.libretv', 'items', `${item.id}.json`);
    const before = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const savedProgress = await (await progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: 123, duration: 3600 })), context(item.id))).json();
    const response = await metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: {
      title: '规范剧名', kind: 'tv', year: '1974', description: '影片简介', sourceName: '资料来源', seasonNumber: 2, episodeNumber: 3,
      // These are not editable metadata and cannot redirect the manifest.
      id: 'b'.repeat(32), mediaPath: '/etc/passwd', position: 0, bytes: 1,
    } })), context(item.id));
    expect(response.status).toBe(200);
    const updated = (await response.json()).item as LibraryEntry;
    expect(updated).toMatchObject({
      id: item.id, title: '规范剧名', kind: 'tv', year: '1974', description: '影片简介', sourceName: '资料来源', seasonNumber: 2, episodeNumber: 3,
      bytes: item.bytes, format: item.format, createdAt: item.createdAt,
      position: 123, duration: 3600, lastPlayedAt: savedProgress.item.lastPlayedAt, hasPoster: false,
    });
    expect(updated.groupId).not.toBe(item.groupId);
    expect(updated.posterUrl).toMatch(new RegExp(`^/api/library/${item.id}/poster\\?v=[a-f0-9]{24}$`));
    expect(updated.mediaUrl).toBe(item.mediaUrl);
    const after = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    expect(after.mediaPath).toBe(before.mediaPath);
    expect(await fs.readFile(path.join(directory, after.mediaPath), 'utf8')).toBe('0123456789');
    expect(await fs.readdir(path.join(directory, '电影', '原片名 (1972)'))).toEqual([`原片名 [${item.id}].mp4`]);
    expect((await fs.readdir(directory))).not.toContain('电视剧');
    expect((await (await list(request('/api/library'))).json()).items[0].posterUrl).toBe(updated.posterUrl);
    expect(await (await poster(request(updated.posterUrl), context(item.id))).text()).toContain('规范剧名');
    const backToMovie = await metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: { title: '规范电影', kind: 'movie' } })), context(item.id));
    const movie = (await backToMovie.json()).item;
    expect(movie.kind).toBe('movie');
    expect(movie).not.toHaveProperty('seasonNumber');
    expect(movie).not.toHaveProperty('episodeNumber');
  });

  it('replaces only the item-owned poster and changes its URL immediately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const item = await add({ title: '海报更新', kind: 'movie', coverUrl: 'https://93.184.216.34/first.png' });
    expect(item.hasPoster).toBe(true);
    const manifestFile = path.join(directory, '.libretv', 'items', `${item.id}.json`);
    const before = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const unrelated = path.join(directory, path.dirname(before.mediaPath), '自己的封面.png');
    await fs.writeFile(unrelated, 'user poster');
    const replacement = Buffer.from(PNG); replacement[replacement.length - 1] ^= 1;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(replacement, { headers: { 'Content-Type': 'image/png' } })));
    const response = await metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: {
      title: item.title, kind: 'movie', description: '补全简介', coverUrl: 'https://93.184.216.34/second.png',
    } })), context(item.id));
    expect(response.status).toBe(200);
    const updated = (await response.json()).item;
    expect(updated.hasPoster).toBe(true);
    expect(updated.posterUrl).not.toBe(item.posterUrl);
    const after = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    expect(after.mediaPath).toBe(before.mediaPath);
    expect(after.posterPath).not.toBe(before.posterPath);
    await expect(fs.stat(path.join(directory, before.posterPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(unrelated, 'utf8')).toBe('user poster');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline'); }));
    expect(Buffer.from(await (await poster(request(updated.posterUrl), context(item.id))).arrayBuffer())).toEqual(replacement);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the existing metadata and poster when a new cover is unsafe or invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const item = await add({ title: '原资料', kind: 'tv', seasonNumber: 2, episodeNumber: 9, coverUrl: 'https://93.184.216.34/first.png' });
    const manifestFile = path.join(directory, '.libretv', 'items', `${item.id}.json`);
    const before = await fs.readFile(manifestFile, 'utf8');
    for (const [url, response] of [
      ['http://127.0.0.1/private', new Response(PNG, { headers: { 'Content-Type': 'image/png' } })],
      ['https://93.184.216.34/redirect', new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })],
      ['https://93.184.216.34/html', new Response('<html>not a poster</html>', { headers: { 'Content-Type': 'image/png' } })],
      ['https://93.184.216.34/large', new Response('oversized', { headers: { 'Content-Type': 'image/png', 'Content-Length': String(5 * 1024 * 1024 + 1) } })],
    ] as const) {
      const fetchSpy = vi.fn(async () => response); vi.stubGlobal('fetch', fetchSpy);
      const result = await metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: { title: '不得写入', kind: 'movie', coverUrl: url } })), context(item.id));
      expect(result.status).toBe(502);
      expect((await result.json()).error).toBe('无法下载有效海报，请更换资料来源后重试');
      expect(await fs.readFile(manifestFile, 'utf8')).toBe(before);
      if (url.includes('127.0.0.1')) expect(fetchSpy).not.toHaveBeenCalled();
    }
    const manifest = JSON.parse(before);
    expect(await fs.readdir(path.join(directory, path.dirname(manifest.mediaPath)))).toEqual([path.basename(manifest.mediaPath), path.basename(manifest.posterPath)].sort());
  });

  it('allows progress to save while poster lookup waits and preserves its latest version', async () => {
    const item = await add();
    let release!: (response: Response) => void;
    const fetchSpy = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetchSpy);
    const updating = metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: {
      title: '资料已更新', kind: 'movie', coverUrl: 'https://93.184.216.34/poster.png',
    } })), context(item.id));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    let saved: { item: LibraryEntry } | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: 777, duration: 1800 })), context(item.id)),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Poster lookup blocked progress')), 1000); }),
      ]);
      expect(response.status).toBe(200);
      saved = await response.json();
    } finally {
      if (timeout) clearTimeout(timeout);
      release(new Response(PNG, { headers: { 'Content-Type': 'image/png' } }));
      await updating;
    }
    const response = await updating;
    expect(response.status).toBe(200);
    expect((await response.json()).item).toMatchObject({ title: '资料已更新', position: 777, duration: 1800, lastPlayedAt: saved!.item.lastPlayedAt });
  });

  it('removes only the newly written poster when metadata commit fails', async () => {
    const item = await add();
    const manifestFile = path.join(directory, '.libretv', 'items', `${item.id}.json`);
    const before = await fs.readFile(manifestFile, 'utf8');
    const manifest = JSON.parse(before);
    const mediaDirectory = path.join(directory, path.dirname(manifest.mediaPath));
    const files = await fs.readdir(mediaDirectory);
    const realManifestFile = await fs.realpath(manifestFile);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const originalRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (args[1] === realManifestFile) throw new Error('Disk failure before commit');
      return originalRename(...args);
    });
    try {
      const response = await metadata(request(`/api/library/${item.id}/metadata`, 'PATCH', JSON.stringify({ metadata: { title: '不能提交', kind: 'movie', coverUrl: 'https://93.184.216.34/poster.png' } })), context(item.id));
      expect(response.status).toBe(500);
      expect(await fs.readFile(manifestFile, 'utf8')).toBe(before);
      expect(await fs.readdir(mediaDirectory)).toEqual(files);
      expect(await fs.readFile(path.join(directory, manifest.mediaPath), 'utf8')).toBe('0123456789');
    } finally { rename.mockRestore(); }
  });

  it('cancels only unfinished staging, refuses empty completion, and preserves committed media', async () => {
    const pending = await begin();
    expect((await complete(request(`/api/library/uploads/${pending}/complete`, 'POST'), context(pending))).status).toBe(409);
    const cancelled = await cancel(request(`/api/library/uploads/${pending}`, 'DELETE'), context(pending));
    expect(await cancelled.json()).toEqual({ cancelled: true });
    expect(await fs.readdir(path.join(directory, '.libretv', 'uploads'))).toEqual([]);
    const item = await add();
    expect((await cancel(request(`/api/library/uploads/${item.id}`, 'DELETE'), context(item.id))).status).toBe(409);
    expect(await (await media(request(item.mediaUrl), context(item.id))).text()).toBe('0123456789');
  });

  it('stores viewing progress atomically and reads it from disk with the next library request', async () => {
    const item = await add();
    const response = await progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: 123.5, duration: 1800 })), context(item.id));
    expect(response.status).toBe(200);
    const saved = (await (await list(request('/api/library'))).json()).items[0];
    expect(saved).toMatchObject({ position: 123.5, duration: 1800 });
    expect(Number.isFinite(Date.parse(saved.lastPlayedAt))).toBe(true);
    expect((await progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: -1 })), context(item.id))).status).toBe(400);
  });

  it('atomically rejects stale progress versions and keeps versions distinct for immediate writes', async () => {
    const item = await add();
    const first = await progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: 100, expectedLastPlayedAt: null })), context(item.id));
    const version = (await first.json()).item.lastPlayedAt;
    expect((await progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position: 1, expectedLastPlayedAt: null })), context(item.id))).status).toBe(409);
    const simultaneous = await Promise.all([101, 102].map((position) => progress(request(`/api/library/${item.id}`, 'PATCH', JSON.stringify({ position, expectedLastPlayedAt: version })), context(item.id))));
    expect(simultaneous.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = (await (await list(request('/api/library'))).json()).items[0];
    expect(saved.lastPlayedAt).not.toBe(version);
    expect([101, 102]).toContain(saved.position);
  });

  it('offers a same-origin attachment download with a safe UTF-8 filename and unchanged Range support', async () => {
    const item = await add({ title: '测试影片 "标题"', kind: 'movie' });
    const response = await media(request(`${item.mediaUrl}?download=1`, 'GET', undefined, { range: 'bytes=2-5' }), context(item.id));
    expect(response.status).toBe(206);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(await response.text()).toBe('2345');
  });

  it('refuses manipulated manifest paths and symlinks instead of exposing arbitrary local files', async () => {
    const item = await add();
    const manifestFile = path.join(directory, '.libretv', 'items', `${item.id}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    const privateFile = path.join(directory, 'private-test.txt');
    await fs.writeFile(privateFile, 'private local data');
    await fs.symlink(privateFile, path.join(directory, 'linked-media.mp4'));
    for (const mediaPath of ['/etc/passwd', '../private-test.txt', 'linked-media.mp4']) {
      await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, mediaPath }));
      const response = await media(request(item.mediaUrl), context(item.id));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('private local data');
      expect((await (await list(request('/api/library'))).json()).items).toEqual([]);
    }
  });
});
