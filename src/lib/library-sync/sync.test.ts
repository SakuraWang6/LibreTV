import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLibraryEntry, listLibrary, mediaResponse, updateProgress } from '@/lib/local-library/server';
import type { LibraryEntry } from '@/lib/local-library/types';
import { GET as statusRoute } from '@/app/api/library-sync/route';
import { POST as cacheRoute } from '@/app/api/library-sync/cache/route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { enqueueCache, getSyncStatus, refreshCatalog, resolveProgress, synchronizeProgress, syncPoster } from './service';
import { allTasks, atomicJson, mappingFile, readJson, syncConfig, syncRoot, type Mapping } from './storage';
import { processCacheTask, syncTick } from './worker';
import { remoteCatalog, remoteRequest } from './remote';

const ID = 'a'.repeat(32);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=', 'base64');
let directory: string;
let remote: LibraryEntry;
let content: Buffer;
let offline: boolean;
let requestedOffsets: number[];
let remoteVersion: number;
let failOffset: number | undefined;
let raceProgress: boolean;
type MediaRange = { start: number; end: number };
let requestedRanges: MediaRange[];
let rangeResponse: ((range: MediaRange, options: RequestInit) => Response | undefined) | undefined;
const MIN_CHUNK = 256 * 1024;

function advanceRemote(position: number): void {
  remote.position = position;
  remote.lastPlayedAt = new Date(Date.UTC(2026, 1, 1) + ++remoteVersion * 1000).toISOString();
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-sync-test-'));
  vi.stubEnv('LOCAL_LIBRARY_DIR', directory);
  vi.stubEnv('LIBRARY_SERVER_URL', 'https://cloud.example.test');
  vi.stubEnv('LIBRARY_SERVER_PASSWORD', 'server-private-password');
  vi.stubEnv('PASSWORD', 'local-private-password');
  vi.stubEnv('PUBLIC_ORIGIN', '');
  content = Buffer.from('0123456789abcdef');
  remoteVersion = 0; offline = false; requestedOffsets = []; failOffset = undefined; raceProgress = false;
  requestedRanges = []; rangeResponse = undefined;
  remote = {
    id: ID, groupId: 'remote-group', title: '云端电影', kind: 'movie', year: '2026', bytes: content.length, format: 'MP4',
    createdAt: '2026-01-01T00:00:00.000Z', mediaUrl: `/api/library/${ID}/media`, posterUrl: `/api/library/${ID}/poster`, position: 40, duration: 1800,
  };
  advanceRemote(40);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, options: RequestInit = {}) => {
    if (offline) throw new Error('https://user:private-secret@cloud.example.test failed');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    expect(url.origin).toBe('https://cloud.example.test');
    if (url.pathname === '/api/auth') {
      expect(JSON.parse(String(options.body))).toEqual({ password: 'server-private-password' });
      return Response.json({ success: true }, { headers: { 'Set-Cookie': 'ltv_session=test-cloud-session; HttpOnly; Path=/' } });
    }
    expect(new Headers(options.headers).get('cookie')).toBe('ltv_session=test-cloud-session');
    if (url.pathname === '/api/library') return Response.json({ enabled: true, items: [{ ...remote }] });
    if (url.pathname === `/api/library/${ID}/poster`) return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname === `/api/library/${ID}/media`) {
      const range = new Headers(options.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
      if (!range) throw new Error('Expected bounded range request');
      const start = Number(range[1]); const end = Number(range[2]);
      requestedOffsets.push(start);
      requestedRanges.push({ start, end });
      if (failOffset === start) { failOffset = undefined; throw new Error('Connection interrupted'); }
      const replacement = rangeResponse?.({ start, end }, options);
      if (replacement) return replacement;
      return new Response(new Uint8Array(content.subarray(start, end + 1)), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': String(end - start + 1) } });
    }
    if (url.pathname === `/api/library/${ID}` && options.method === 'PATCH') {
      const data = JSON.parse(String(options.body));
      if (raceProgress) { raceProgress = false; advanceRemote(999); }
      if ((remote.lastPlayedAt ?? null) !== data.expectedLastPlayedAt) return Response.json({ error: 'changed' }, { status: 409 });
      remote.duration = data.duration ?? remote.duration;
      advanceRemote(data.position);
      return Response.json({ item: { ...remote } });
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  }));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

async function cached(): Promise<string> {
  const config = syncConfig()!;
  await refreshCatalog(config);
  await enqueueCache({ itemId: ID });
  await processCacheTask(config, ID);
  return (await getSyncStatus()).catalog[0].cachedLocalId!;
}

async function expectExactCachedVideo(): Promise<void> {
  const items = (await listLibrary()).items;
  expect(items).toHaveLength(1);
  const response = await mediaResponse(items[0].id, new Request('http://local/media'));
  expect(Buffer.from(await response.arrayBuffer()).equals(content)).toBe(true);
}

describe('cloud library cache and progress synchronization', () => {
  it('is optional, requires HTTPS and never exposes credentials or sessions in its API', async () => {
    vi.stubEnv('LIBRARY_SERVER_URL', '');
    expect(await getSyncStatus()).toEqual({ enabled: false, online: false, catalog: [], progressConflicts: [] });
    vi.stubEnv('LIBRARY_SERVER_URL', 'http://cloud.example.test');
    expect((await getSyncStatus()).enabled).toBe(false);
    vi.stubEnv('LIBRARY_SERVER_URL', 'https://cloud.example.test');
    await refreshCatalog(syncConfig()!);
    const status = await getSyncStatus();
    expect(status).toMatchObject({ enabled: true, online: true });
    expect(JSON.stringify(status)).not.toMatch(/private-password|test-cloud-session|server-private/);
    expect(status.catalog[0].posterUrl).toBe(`/api/library-sync/${ID}/poster`);
  });

  it('guards reads and cache mutations and refuses untrusted IDs or cross-site requests', async () => {
    expect((await statusRoute(new Request('http://127.0.0.1:8899/api/library-sync'))).status).toBe(401);
    expect((await cacheRoute(new Request('http://127.0.0.1:8899/api/library-sync/cache', { method: 'POST', body: '{}' }))).status).toBe(401);
    const cookie = `${SESSION_COOKIE}=${signSession().token}`;
    expect((await cacheRoute(new Request('http://127.0.0.1:8899/api/library-sync/cache', { method: 'POST', headers: { cookie, origin: 'https://attacker.test' }, body: JSON.stringify({ itemId: ID }) }))).status).toBe(403);
    await expect(enqueueCache({ itemId: '../../private' })).rejects.toMatchObject({ status: 400 });
  });

  it('queues idempotently, copies exact bytes and a poster, and preserves explicit remote-to-local identity', async () => {
    const localId = await cached();
    expect(localId).not.toBe(ID);
    const local = await getLibraryEntry(localId);
    expect(local).toMatchObject({ title: remote.title, bytes: content.length, position: 40, duration: 1800 });
    expect(Buffer.from(await (await mediaResponse(localId, new Request('http://local/media'))).arrayBuffer())).toEqual(content);
    const again = await enqueueCache({ itemId: ID });
    expect(again.task.status).toBe('completed');
    await processCacheTask(syncConfig()!, ID);
    expect((await listLibrary()).items).toHaveLength(1);
    const mapping = await readJson<Mapping>(mappingFile(await syncRoot(syncConfig()!), ID));
    expect(mapping).toMatchObject({ remoteOrigin: 'https://cloud.example.test', remoteId: ID, localId });
    offline = true;
    expect((await syncPoster(ID)).headers.get('content-type')).toBe('image/png');
  });

  it('resumes a partial Range download after interruption without publishing an incomplete movie', async () => {
    content = Buffer.alloc(2 * 256 * 1024 + 17, 83); remote.bytes = content.length;
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    failOffset = 256 * 1024;
    await expect(processCacheTask(config, ID)).rejects.toThrow('Connection interrupted');
    expect((await listLibrary()).items).toHaveLength(0);
    await processCacheTask(config, ID);
    expect(requestedOffsets).toEqual([0, 256 * 1024, 256 * 1024, 2 * 256 * 1024]);
    expect((await listLibrary()).items).toHaveLength(1);
    expect((await allTasks(await syncRoot(config)))[0]).toMatchObject({ status: 'completed', progress: 100 });
  });

  it('gradually grows fast transfers up to 4 MiB while preserving exact video bytes', async () => {
    content = Buffer.alloc(12 * 1024 * 1024 + 17, 91); remote.bytes = content.length;
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = () => { clock += 200; return undefined; };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    await processCacheTask(config, ID);
    const sizes = requestedRanges.map(({ start, end }) => end - start + 1);
    expect(sizes.slice(0, 6)).toEqual([MIN_CHUNK, 2 * MIN_CHUNK, 4 * MIN_CHUNK, 8 * MIN_CHUNK, 16 * MIN_CHUNK, 16 * MIN_CHUNK]);
    expect(Math.max(...sizes)).toBe(4 * 1024 * 1024);
    await expectExactCachedVideo();
  });

  it('reduces request sizes when a fast link slows down and retains the 256 KiB floor', async () => {
    content = Buffer.alloc(12 * 1024 * 1024 + 17, 92); remote.bytes = content.length;
    let clock = 0;
    const durations = [200, 200, 200, 200, 8_000, 8_000, 16_000];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = () => { clock += durations.shift() ?? 4_000; return undefined; };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    await processCacheTask(config, ID);
    const sizes = requestedRanges.map(({ start, end }) => end - start + 1);
    expect(sizes.slice(0, 8)).toEqual([MIN_CHUNK, 2 * MIN_CHUNK, 4 * MIN_CHUNK, 8 * MIN_CHUNK, 16 * MIN_CHUNK, 8 * MIN_CHUNK, 4 * MIN_CHUNK, MIN_CHUNK]);
    expect(sizes.slice(0, -1).every((size) => size >= MIN_CHUNK)).toBe(true);
    await expectExactCachedVideo();
  });

  it('discards a partially read timed-out block and retries its original offset with half the range', async () => {
    content = Buffer.alloc(2 * 1024 * 1024 + 17, 93); remote.bytes = content.length;
    let clock = 0;
    let interrupted = false;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = ({ start, end }) => {
      clock += 200;
      if (start !== MIN_CHUNK || interrupted) return undefined;
      interrupted = true;
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new Uint8Array(content.subarray(start, start + 1024))); }
          else controller.error(new DOMException('Media read timed out', 'TimeoutError'));
        },
      }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${content.length}`, 'Content-Length': String(end - start + 1) } });
    };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    await processCacheTask(config, ID);
    expect(requestedRanges.slice(0, 3)).toEqual([
      { start: 0, end: MIN_CHUNK - 1 },
      { start: MIN_CHUNK, end: 3 * MIN_CHUNK - 1 },
      { start: MIN_CHUNK, end: 2 * MIN_CHUNK - 1 },
    ]);
    await expectExactCachedVideo();
  });

  it('does not shrink or retry an externally aborted large block even when SIGTERM has a TimeoutError reason', async () => {
    content = Buffer.alloc(2 * 1024 * 1024, 94); remote.bytes = content.length;
    let clock = 0;
    let received!: () => void;
    const reading = new Promise<void>((resolve) => { received = resolve; });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = ({ start, end }, options) => {
      clock += 200;
      if (start !== MIN_CHUNK) return undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          options.signal!.addEventListener('abort', () => controller.error(options.signal!.reason), { once: true });
          received();
        },
      }), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${content.length}` } });
    };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    const stopping = new AbortController();
    const pending = processCacheTask(config, ID, stopping.signal);
    await reading;
    stopping.abort(new DOMException('SIGTERM', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: 'SIGTERM' });
    expect(requestedRanges).toEqual([{ start: 0, end: MIN_CHUNK - 1 }, { start: MIN_CHUNK, end: 3 * MIN_CHUNK - 1 }]);
    expect((await listLibrary()).items).toHaveLength(0);
    expect((await allTasks(await syncRoot(config)))[0].status).toBe('downloading');
  });

  it('does not repeatedly retry a small final tail just because the adaptive ceiling is larger', async () => {
    content = Buffer.alloc(MIN_CHUNK + 17, 96); remote.bytes = content.length;
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = ({ start }) => {
      clock += 200;
      if (start === MIN_CHUNK) throw new DOMException('Tail read timed out', 'TimeoutError');
      return undefined;
    };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    await syncTick(config);
    expect(requestedRanges).toEqual([{ start: 0, end: MIN_CHUNK - 1 }, { start: MIN_CHUNK, end: MIN_CHUNK + 16 }]);
    expect((await allTasks(await syncRoot(config)))[0]).toMatchObject({ status: 'error', error: '连接服务器超时，请检查网络后重试' });
    expect((await listLibrary()).items).toHaveLength(0);
  });

  it('resumes after restart from an adaptive, non-grid offset without redownloading committed bytes', async () => {
    content = Buffer.alloc(3 * 1024 * 1024 + 17, 95); remote.bytes = content.length;
    let clock = 0;
    const durations = [200, 3_000, 4_000];
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    rangeResponse = () => {
      clock += durations.shift() ?? 4_000;
      if (requestedRanges.length === 4) throw new Error('Simulated restart');
      return undefined;
    };
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    await expect(processCacheTask(config, ID)).rejects.toThrow('Simulated restart');
    const resumeOffset = requestedRanges[3].start;
    expect(resumeOffset % MIN_CHUNK).not.toBe(0);
    expect((await listLibrary()).items).toHaveLength(0);
    await processCacheTask(config, ID);
    expect(requestedRanges[4]).toEqual({ start: resumeOffset, end: resumeOffset + MIN_CHUNK - 1 });
    expect(requestedOffsets.slice(4).every((offset) => offset >= resumeOffset)).toBe(true);
    await expectExactCachedVideo();
  });

  it('recovers a crash after media commit and before mapping commit without creating a duplicate', async () => {
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    const originalRename = fs.rename.bind(fs);
    let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith(`mapping-${ID}.json`)) { failed = true; throw new Error('Simulated crash'); }
      await originalRename(from, to);
    });
    await expect(processCacheTask(config, ID)).rejects.toThrow('Simulated crash');
    expect((await listLibrary()).items).toHaveLength(1);
    await processCacheTask(config, ID);
    expect((await listLibrary()).items).toHaveLength(1);
    expect((await getSyncStatus()).catalog[0].cachedLocalId).toBeTruthy();
  });

  it('keeps cached catalog and local playback available while offline and leaves queued tasks durable', async () => {
    const localId = await cached();
    offline = true;
    await syncTick(syncConfig()!);
    const status = await getSyncStatus();
    expect(status).toMatchObject({ enabled: true, online: false });
    expect(status.catalog[0].cachedLocalId).toBe(localId);
    expect(JSON.stringify(status)).not.toMatch(/private-secret|user:/);
    expect(await (await mediaResponse(localId, new Request('http://local/media'))).text()).toBe(content.toString());
  });

  it('syncs one-sided changes in either direction, including intentional backwards seeks', async () => {
    const localId = await cached();
    await updateProgress(localId, { position: 12, duration: 1800 });
    await synchronizeProgress(syncConfig()!, [{ ...remote }]);
    expect(remote.position).toBe(12);
    advanceRemote(5);
    await synchronizeProgress(syncConfig()!, [{ ...remote }]);
    expect((await getLibraryEntry(localId)).position).toBe(5);
    expect((await getSyncStatus()).progressConflicts).toEqual([]);
  });

  it('reports simultaneous offline progress changes and resolves an explicit server choice', async () => {
    remote.kind = 'tv'; remote.seasonNumber = 2; remote.episodeNumber = 7;
    const localId = await cached();
    await updateProgress(localId, { position: 20, duration: 1800 }); advanceRemote(100);
    await synchronizeProgress(syncConfig()!, [{ ...remote }]);
    const status = await getSyncStatus();
    expect(status.progressConflicts).toMatchObject([{ itemId: ID, localId, local: { position: 20 }, server: { position: 100 } }]);
    expect(status.progressConflicts[0].title).toContain('第 2 季 第 7 集');
    expect(remote.position).toBe(100); expect((await getLibraryEntry(localId)).position).toBe(20);
    await resolveProgress({ itemId: ID, choice: 'server' });
    expect((await getLibraryEntry(localId)).position).toBe(100);
    expect((await getSyncStatus()).progressConflicts).toEqual([]);
  });

  it('resolves a local choice and rejects stale concurrent writes rather than losing cloud progress', async () => {
    const localId = await cached();
    await updateProgress(localId, { position: 22, duration: 1800 }); advanceRemote(200);
    await synchronizeProgress(syncConfig()!, [{ ...remote }]);
    await resolveProgress({ itemId: ID, choice: 'local' });
    expect(remote.position).toBe(22);
    await updateProgress(localId, { position: 33, duration: 1800 });
    raceProgress = true;
    await expect(synchronizeProgress(syncConfig()!, [{ ...remote }])).rejects.toMatchObject({ status: 409 });
    expect(remote.position).toBe(999);
    await synchronizeProgress(syncConfig()!, [{ ...remote }]);
    expect((await getSyncStatus()).progressConflicts[0]).toMatchObject({ local: { position: 33 }, server: { position: 999 } });
  });

  it('namespaces identities when switching servers and never guesses by title', async () => {
    await cached();
    const oldRoot = await syncRoot(syncConfig()!);
    vi.stubEnv('LIBRARY_SERVER_URL', 'https://other.example.test');
    const newRoot = await syncRoot(syncConfig()!);
    expect(newRoot).not.toBe(oldRoot);
    await atomicJson(path.join(newRoot, 'catalog.json'), { version: 1, online: true, checkedAt: Date.now(), items: [{ ...remote }] });
    expect((await getSyncStatus()).catalog[0].cachedLocalId).toBeUndefined();
  });

  it('uses a longer media deadline while catalog/auth requests retain their short deadline', async () => {
    const deadline = vi.spyOn(AbortSignal, 'timeout');
    await remoteCatalog(syncConfig()!);
    expect(deadline.mock.calls.length).toBeGreaterThan(0);
    expect(deadline.mock.calls.every(([milliseconds]) => milliseconds === 15_000)).toBe(true);
    deadline.mockClear();
    const response = await remoteRequest(syncConfig()!, `/api/library/${ID}/media`, { headers: { Range: 'bytes=0-3' } });
    expect(await response.text()).toBe('0123');
    expect(deadline).toHaveBeenCalledTimes(1);
    expect(deadline).toHaveBeenCalledWith(60_000);
  });

  it('immediately aborts a pending media request when the daemon stops despite its longer deadline', async () => {
    await remoteCatalog(syncConfig()!); // Authenticate before isolating the long media request.
    let received: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { received = resolve; });
    vi.stubGlobal('fetch', vi.fn((_input: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      received!();
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    })));
    const stop = new AbortController();
    const pending = remoteRequest(syncConfig()!, `/api/library/${ID}/media`, {}, stop.signal);
    await waiting;
    stop.abort(new Error('Daemon stopped'));
    await expect(pending).rejects.toThrow('Daemon stopped');
  });

  it('keeps a timed-out cache retryable and reports a Chinese connection error', async () => {
    const config = syncConfig()!;
    await refreshCatalog(config); await enqueueCache({ itemId: ID });
    const normalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/media')) return Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      return normalFetch(input, options);
    }));
    await syncTick(config);
    expect((await getSyncStatus()).catalog[0].cacheTask).toMatchObject({ status: 'error', error: '连接服务器超时，请检查网络后重试' });
    await enqueueCache({ itemId: ID });
    expect((await getSyncStatus()).catalog[0].cacheTask?.status).toBe('queued');
  });
});
