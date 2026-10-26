import fs from 'node:fs/promises';
import { constants, readSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { createUpload, appendUpload, completeUpload } from './server';
import { ExternalMediaError } from './external-media';
import { GET } from '@/app/api/library/[id]/preview/route';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), external: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('./external-media', async (original) => ({ ...await original<object>(), openExternalMedia: mocks.external }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const JPEG = Buffer.from([255, 216, 255, 224, 1, 2, 3, 255, 217]);
const BASE = 'http://127.0.0.1:8899';
let directory: string, cookie: string, id: string, mediaPath: string, manifestPath: string;
let behavior: (child: ReturnType<typeof fakeChild>) => void;
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  return child;
}
function request(time = '12.5', headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/library/${id}/preview?time=${encodeURIComponent(time)}`, { headers: { cookie, host: '127.0.0.1:8899', ...headers } });
}
function preview(time = '12.5', headers?: Record<string, string>) { return GET(request(time, headers), { params: Promise.resolve({ id }) }); }
async function cacheEntries() {
  const root = path.join(directory, '.libretv', 'previews');
  return (await fs.readdir(root)).filter((name) => name.endsWith('.jpg')).map((name) => path.join(root, name));
}
async function externalRecord() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  delete manifest.mediaPath;
  manifest.external = { version: 1, locationId: 'a'.repeat(32), relativePath: 'movie.mp4', bytes: manifest.item.bytes, ino: '1', mtimeMs: 1 };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  mocks.external.mockImplementation(() => fs.open(mediaPath, constants.O_RDONLY | constants.O_NOFOLLOW));
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-preview-'));
  vi.stubEnv('LOCAL_LIBRARY_DIR', directory); vi.stubEnv('PASSWORD', 'preview-test-password'); vi.stubEnv('PROXY_SECRET', 'preview-signing');
  vi.stubEnv('LOCAL_AUTH_BYPASS', 'false'); vi.stubEnv('PUBLIC_ORIGIN', '');
  cookie = `${SESSION_COOKIE}=${signSession().token}`;
  const upload = await createUpload({ metadata: { title: '预览测试', kind: 'movie' }, format: 'MP4' });
  await appendUpload(upload.id, 0, new Request('http://worker.invalid/', { method: 'PUT', body: Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftyp'), Buffer.alloc(48)]) }));
  id = (await completeUpload(upload.id)).item.id;
  manifestPath = path.join(directory, '.libretv', 'items', `${id}.json`);
  mediaPath = path.join(directory, JSON.parse(await fs.readFile(manifestPath, 'utf8')).mediaPath);
  mocks.spawn.mockReset(); mocks.external.mockReset();
  behavior = (child) => { child.stdout.emit('data', JPEG); child.emit('close', 0); };
  mocks.spawn.mockImplementation(() => { const child = fakeChild(); queueMicrotask(() => behavior(child)); return child; });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers(); vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('authenticated, bounded local library frame previews', () => {
  it('guards login and rejects invalid times before a media process starts', async () => {
    expect((await preview('0', { cookie: '' })).status).toBe(401);
    for (const time of ['', '-1', 'NaN', 'Infinity', '604801', '/etc/passwd']) expect((await preview(time)).status).toBe(400);
    const duplicate = new Request(`${BASE}/api/library/${id}/preview?time=0&time=5`, { headers: { cookie } });
    expect((await GET(duplicate, { params: Promise.resolve({ id }) })).status).toBe(400);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('extracts from an inherited read-only descriptor, quantizes cache keys and preserves original media and progress', async () => {
    const manifest = await fs.readFile(manifestPath, 'utf8');
    const original = await fs.readFile(mediaPath);
    let readOnly = false;
    mocks.spawn.mockImplementation((_command, _args, options) => {
      const fd = options.stdio[3];
      const magic = Buffer.alloc(8); readSync(fd, magic, 0, 8, 0);
      expect(magic.subarray(4).toString()).toBe('ftyp');
      try { writeSync(fd, Buffer.from('x'), 0, 1, 0); } catch { readOnly = true; }
      const child = fakeChild(); queueMicrotask(() => behavior(child)); return child;
    });
    const first = await preview('12.1');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/jpeg');
    expect(first.headers.get('x-preview-time')).toBe('10');
    expect(Buffer.from(await first.arrayBuffer())).toEqual(JPEG);
    expect(readOnly).toBe(true);
    const [, args, options] = mocks.spawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-ss', '10', '-i', '/dev/fd/3', '-threads', '1', '-filter_threads', '1']));
    expect(args.join(' ')).not.toContain(directory);
    expect(options.stdio[3]).toBeTypeOf('number');
    expect((await preview('14.9')).status).toBe(200);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(await cacheEntries()).toHaveLength(1);
    expect(await fs.readFile(mediaPath)).toEqual(original);
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(manifest);
  });

  it('invalidates cached frames after a same-size rewrite even if the source mtime is restored', async () => {
    expect((await preview()).status).toBe(200);
    const stat = await fs.stat(mediaPath);
    const bytes = await fs.readFile(mediaPath); bytes[bytes.length - 1] = 9;
    await fs.writeFile(mediaPath, bytes); await fs.utimes(mediaPath, stat.atime, stat.mtime);
    expect((await preview()).status).toBe(200);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('refuses external records on Linux and verifies a Mac disk before serving even a cached frame', async () => {
    await externalRecord();
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    vi.stubEnv('LOCAL_AUTH_BYPASS', 'true'); vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899');
    expect((await preview()).status).toBe(403);
    expect(mocks.external).not.toHaveBeenCalled();
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
    expect((await preview()).status).toBe(200);
    mocks.external.mockRejectedValueOnce(new ExternalMediaError('offline', 'offline'));
    const offline = await preview();
    expect(offline.status).toBe(503);
    expect(offline.headers.get('retry-after')).toBe('1');
    mocks.external.mockRejectedValueOnce(new ExternalMediaError('changed', 'changed'));
    expect((await preview()).status).toBe(409);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('shares one identical request, refuses a competing extraction and recovers after completion', async () => {
    let child!: ReturnType<typeof fakeChild>, opened!: () => void;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    behavior = (active) => { child = active; opened(); };
    const first = preview('10'); await started;
    const same = preview('11');
    const busy = await preview('15');
    expect(busy.status).toBe(503); expect(busy.headers.get('retry-after')).toBe('1');
    child.stdout.emit('data', JPEG); child.emit('close', 0);
    expect((await first).status).toBe(200); expect((await same).status).toBe(200);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    behavior = (active) => { active.stdout.emit('data', JPEG); active.emit('close', 0); };
    expect((await preview('15')).status).toBe(200);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('kills a stalled process after five seconds without logging or returning its private stderr', async () => {
    vi.useFakeTimers();
    let child!: ReturnType<typeof fakeChild>, opened!: () => void;
    const started = new Promise<void>((resolve) => { opened = resolve; });
    behavior = (active) => { child = active; active.stderr.emit('data', Buffer.from('/private/source.mp4')); opened(); };
    const response = preview(); await started;
    await vi.advanceTimersByTimeAsync(5001);
    const failed = await response;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('/private/');
    expect(await cacheEntries()).toHaveLength(0);
  });

  it('rejects oversized or invalid frames and non-container content without leaving partial cache files', async () => {
    behavior = (child) => child.stdout.emit('data', Buffer.alloc(512 * 1024 + 1));
    expect((await preview()).status).toBe(502);
    behavior = (child) => { child.stdout.emit('data', Buffer.from('not an image')); child.emit('close', 0); };
    expect((await preview()).status).toBe(502);
    await fs.writeFile(mediaPath, '#EXTM3U\nfile:///private/input');
    expect((await preview()).status).toBe(502);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(await cacheEntries()).toHaveLength(0);
  });

  it('does not publish a frame when the source changes while its descriptor is being decoded', async () => {
    behavior = (child) => { void fs.appendFile(mediaPath, 'changed').then(() => { child.stdout.emit('data', JPEG); child.emit('close', 0); }); };
    expect((await preview()).status).toBe(409);
    expect(await cacheEntries()).toHaveLength(0);
  });

  it('refuses cache symlinks without opening their targets or running another decoder', async () => {
    expect((await preview()).status).toBe(200);
    const [cache] = await cacheEntries();
    await fs.unlink(cache); await fs.symlink(mediaPath, cache);
    expect((await preview()).status).toBe(503);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(mediaPath)).not.toEqual(JPEG);
  });

  it('evicts old frames to bound per-item and global bytes while retaining user files outside its cache', async () => {
    const root = path.join(directory, '.libretv', 'previews'); await fs.mkdir(root);
    const seed = async (owner: string, count: number) => Promise.all(Array.from({ length: count }, async (_, index) => {
      const file = path.join(root, `${owner}-${'b'.repeat(32)}-${index * 5}.jpg`);
      const handle = await fs.open(file, 'wx'); await handle.truncate(512 * 1024); await handle.close();
      await fs.utimes(file, new Date(1), new Date(1));
    }));
    await seed(id, 33);
    for (const owner of ['1', '2', '3']) await seed(owner.repeat(32), 33);
    await fs.writeFile(path.join(root, 'unrelated-user-file'), 'keep');
    expect((await preview('500')).status).toBe(200);
    const files = await cacheEntries();
    const stats = await Promise.all(files.map(async (file) => ({ item: path.basename(file).slice(0, 32), bytes: (await fs.stat(file)).size })));
    expect(stats.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(stats.filter((entry) => entry.item === id).reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(files.length).toBeLessThanOrEqual(2048);
    expect(await fs.readFile(path.join(root, 'unrelated-user-file'), 'utf8')).toBe('keep');
  });

  it('bounds cache file counts even when old frames are very small', async () => {
    const root = path.join(directory, '.libretv', 'previews'); await fs.mkdir(root);
    for (let offset = 0; offset < 2049; offset += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 2049 - offset) }, async (_, index) => {
        const value = offset + index;
        const owner = value < 512 ? id : String(Math.floor((value - 512) / 512) + 1).repeat(32);
        await fs.writeFile(path.join(root, `${owner}-${'b'.repeat(32)}-${value * 5}.jpg`), JPEG);
      }));
    }
    expect((await preview('20000')).status).toBe(200);
    const files = await cacheEntries();
    expect(files.length).toBeLessThanOrEqual(2048);
    expect(files.filter((file) => path.basename(file).startsWith(`${id}-`)).length).toBeLessThanOrEqual(512);
  });
});
