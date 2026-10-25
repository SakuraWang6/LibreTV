import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { ExternalMediaError, type ExternalMediaReference } from './external-media';
import { createUpload, appendUpload, completeUpload, getLibraryEntry, migrateManagedLibraryEntryToExternal, saveLibraryPoster, updateProgress } from './server';
import { GET as library } from '@/app/api/library/route';
import { GET as media, HEAD as mediaHead } from '@/app/api/library/[id]/media/route';
import { GET as poster } from '@/app/api/library/[id]/poster/route';
import { PATCH as metadata } from '@/app/api/library/[id]/metadata/route';
import { POST as referenceImport } from '@/app/api/library/references/route';
import { GET as locations, POST as changeLocation } from '@/app/api/library/locations/route';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), open: vi.fn(), status: vi.fn(), list: vi.fn(), register: vi.fn(), scan: vi.fn(), choose: vi.fn() }));
vi.mock('./external-media', async (original) => ({ ...await original<object>(),
  resolveExternalMedia: mocks.resolve, openExternalMedia: mocks.open, externalMediaStatus: mocks.status,
  listExternalLocations: mocks.list, registerExternalLocation: mocks.register, scanExternalLocation: mocks.scan,
}));
vi.mock('./folder-picker', () => ({ chooseLibraryFolder: mocks.choose }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const BASE = 'http://127.0.0.1:8899';
const LOCATION = 'a'.repeat(32), FILE = 'b'.repeat(32);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7f8AAAAASUVORK5CYII=', 'base64');
let directory: string, root: string, externalPath: string, cookie: string, reference: ExternalMediaReference;
let failure: 'offline' | 'changed' | 'unavailable' | undefined;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const request = (url: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => new Request(BASE + url, {
  method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), headers: { host: '127.0.0.1:8899', cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', origin: BASE } : {}), ...headers },
});
const importRequest = () => referenceImport(request('/api/library/references', { locationId: LOCATION, fileId: FILE, metadata: { title: '外部电影', kind: 'movie', year: '1972' } }));

async function rescan() {
  const stat = await fs.stat(externalPath);
  reference = { version: 1, locationId: LOCATION, relativePath: 'movie.mp4', bytes: stat.size, ino: String(stat.ino), mtimeMs: stat.mtimeMs };
}

async function managedItem(value = '0123456789') {
  const upload = await createUpload({ metadata: { title: '原片库', kind: 'movie', year: '1972' }, format: 'MP4' });
  await appendUpload(upload.id, 0, new Request('http://worker.invalid/', { method: 'PUT', body: value }));
  return (await completeUpload(upload.id)).item;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-external-api-')); root = path.join(directory, 'library');
  externalPath = path.join(directory, 'outside', 'movie.mp4');
  await fs.mkdir(path.dirname(externalPath)); await fs.writeFile(externalPath, '0123456789'); await rescan(); failure = undefined;
  vi.stubEnv('LOCAL_LIBRARY_DIR', root); vi.stubEnv('PASSWORD', 'external-test-private'); vi.stubEnv('PROXY_SECRET', 'external-test-signing');
  vi.stubEnv('LOCAL_AUTH_BYPASS', 'true'); vi.stubEnv('LIBRETV_LOCAL_AUTH_BIND', '127.0.0.1:8899'); vi.stubEnv('PUBLIC_ORIGIN', '');
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  cookie = `${SESSION_COOKIE}=${signSession().token}`;
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.open.mockImplementation(async (expected: ExternalMediaReference) => {
    if (failure) throw new ExternalMediaError('Test status', failure);
    const stat = await fs.lstat(externalPath);
    if (stat.isSymbolicLink() || expected.bytes !== stat.size || expected.ino !== String(stat.ino) || expected.mtimeMs !== stat.mtimeMs) throw new ExternalMediaError('Changed file', 'changed');
    return fs.open(externalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  });
  mocks.status.mockImplementation(async (expected: ExternalMediaReference) => {
    try { const handle = await mocks.open(expected); await handle.close(); return { available: true }; }
    catch (error) { return { available: false, reason: (error as ExternalMediaError).reason || 'unavailable' }; }
  });
  mocks.resolve.mockImplementation(async (locationId, fileId) => {
    if (locationId !== LOCATION || fileId !== FILE) throw new ExternalMediaError('Not scanned');
    const handle = await mocks.open(reference); await handle.close();
    return { reference, filename: 'movie.mp4', bytes: reference.bytes, format: 'MP4' };
  });
  const location = { id: LOCATION, path: path.dirname(externalPath), label: '电影', online: true };
  mocks.list.mockResolvedValue([location]); mocks.register.mockResolvedValue(location);
  mocks.scan.mockResolvedValue({ location, files: [{ id: FILE, name: 'movie.mp4', relativePath: 'movie.mp4', bytes: 10, format: 'MP4' }], truncated: false });
  mocks.choose.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('No network in test'))));
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', platform); await fs.rm(directory, { recursive: true, force: true }); });

describe('private local external-media references', () => {
  it('indexes a scanned file idempotently without copying media and serves ranges and HEAD', async () => {
    const before = await fs.stat(externalPath);
    const first = await importRequest(); expect(first.status).toBe(200);
    const result = await first.json(); expect(result.existing).toBe(false);
    expect(result.item).toMatchObject({ storage: 'external', available: true, bytes: 10, title: '外部电影' });
    expect(JSON.stringify(result)).not.toContain(directory);
    const again = await (await importRequest()).json(); expect(again.existing).toBe(true); expect(again.item.id).toBe(result.item.id);
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.libretv/items', `${result.item.id}.json`), 'utf8'));
    expect(manifest.external).toEqual(reference); expect(manifest).not.toHaveProperty('mediaPath');
    expect(await fs.readdir(root)).toEqual(['.libretv']);
    expect((await fs.stat(externalPath)).mtimeMs).toBe(before.mtimeMs);
    const full = await media(request(result.item.mediaUrl), context(result.item.id)); expect(await full.text()).toBe('0123456789');
    const range = await media(request(result.item.mediaUrl, undefined, { range: 'bytes=2-5' }), context(result.item.id));
    expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe('bytes 2-5/10'); expect(await range.text()).toBe('2345');
    const head = await mediaHead(request(result.item.mediaUrl, undefined, { range: 'bytes=-3' }, 'HEAD'), context(result.item.id));
    expect(head.status).toBe(206); expect(head.headers.get('content-length')).toBe('3'); expect(await head.text()).toBe('');
  });

  it('retains offline entries, cached art and progress, and can repair art without the disk', async () => {
    const item = (await (await importRequest()).json()).item;
    await saveLibraryPoster(item.id, PNG); await updateProgress(item.id, { position: 321, duration: 3600 });
    failure = 'offline';
    const listed = (await (await library(request('/api/library'))).json()).items;
    expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({ id: item.id, available: false, availabilityReason: 'offline', position: 321 });
    expect(await getLibraryEntry(item.id)).toMatchObject({ available: false, availabilityReason: 'offline' });
    const unavailable = await media(request(item.mediaUrl), context(item.id)); expect(unavailable.status).toBe(503); expect(await unavailable.text()).not.toContain(directory);
    expect(Buffer.from(await (await poster(request(item.posterUrl), context(item.id))).arrayBuffer())).toEqual(PNG);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } })));
    const repaired = await metadata(request(`/api/library/${item.id}/metadata`, { metadata: { title: '规范片名', kind: 'movie', description: '介绍', coverUrl: 'https://93.184.216.34/poster.png' } }, {}, 'PATCH'), context(item.id));
    expect(repaired.status).toBe(200); expect((await repaired.json()).item).toMatchObject({ available: false, hasPoster: true, position: 321 });
    const manifest = JSON.parse(await fs.readFile(path.join(root, '.libretv/items', `${item.id}.json`), 'utf8'));
    expect(manifest.posterPath).toMatch(new RegExp(`^\\.libretv/artwork/${item.id}/`));
    expect(await fs.readdir(path.dirname(externalPath))).toEqual(['movie.mp4']);
  });

  it('rejects public access even with a valid session and does not inspect external files', async () => {
    const item = (await (await importRequest()).json()).item;
    mocks.open.mockClear(); mocks.status.mockClear(); mocks.list.mockClear(); mocks.resolve.mockClear();
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    expect((await locations(request('/api/library/locations'))).status).toBe(403);
    expect((await changeLocation(request('/api/library/locations', { action: 'choose' }))).status).toBe(403);
    expect((await importRequest()).status).toBe(403);
    expect((await media(request(item.mediaUrl), context(item.id))).status).toBe(403);
    expect((await poster(request(item.posterUrl), context(item.id))).status).toBe(403);
    const entries = (await (await library(request('/api/library'))).json()).items;
    expect(entries[0]).toMatchObject({ id: item.id, storage: 'external', available: false, availabilityReason: 'unavailable' });
    expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.choose).not.toHaveBeenCalled();
  });

  it('guards folder operations and accepts only typed actions and scanned file IDs', async () => {
    expect((await locations(request('/api/library/locations'))).status).toBe(200);
    expect((await changeLocation(request('/api/library/locations', { action: 'add', path: path.dirname(externalPath) }))).status).toBe(200);
    expect((await changeLocation(request('/api/library/locations', { action: 'scan', locationId: LOCATION }))).status).toBe(200);
    expect(await (await changeLocation(request('/api/library/locations', { action: 'choose' }))).json()).toEqual({ cancelled: true });
    mocks.choose.mockResolvedValue(path.dirname(externalPath));
    expect(await (await changeLocation(request('/api/library/locations', { action: 'choose' }))).json()).toMatchObject({ cancelled: false, location: { id: LOCATION } });
    expect((await changeLocation(request('/api/library/locations', { action: 'run', script: 'anything' }))).status).toBe(400);
    expect((await changeLocation(request('/api/library/locations', { action: 'choose' }, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }))).status).toBe(403);
    const unknown = await referenceImport(request('/api/library/references', { locationId: LOCATION, fileId: 'c'.repeat(32), metadata: { title: '未知', kind: 'movie' } }));
    expect(unknown.status).toBe(404);
    expect((await library(request('/api/library')).then((r) => r.json())).items).toEqual([]);
  });

  it('requires a new scanned identity to refresh a changed file while preserving its entry and progress', async () => {
    const item = (await (await importRequest()).json()).item; await updateProgress(item.id, { position: 432 });
    await fs.writeFile(externalPath, 'new video contents');
    expect((await media(request(item.mediaUrl), context(item.id))).status).toBe(409);
    expect((await importRequest()).status).toBe(409);
    await rescan();
    const refreshed = await (await importRequest()).json();
    expect(refreshed).toMatchObject({ existing: false, refreshed: true, item: { id: item.id, title: '外部电影', bytes: 18, position: 432, available: true } });
    expect(await (await media(request(item.mediaUrl), context(item.id))).text()).toBe('new video contents');
    expect((await (await library(request('/api/library'))).json()).items).toHaveLength(1);
  });

  it('migrates only byte-identical stable files, preserving metadata, art, ID and history', async () => {
    const item = await managedItem(); await saveLibraryPoster(item.id, PNG); await updateProgress(item.id, { position: 555, duration: 900 });
    const file = path.join(root, '.libretv/items', `${item.id}.json`); const before = JSON.parse(await fs.readFile(file, 'utf8'));
    const linked = await migrateManagedLibraryEntryToExternal(item.id, LOCATION, FILE, true);
    expect(linked).toMatchObject({ existing: false, released: true, item: { id: item.id, title: item.title, position: 555, duration: 900, storage: 'external', available: true } });
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(after.posterPath).toBe(before.posterPath); expect(after.posterVersion).toBe(before.posterVersion); expect(after.item).toEqual(before.item);
    expect(after).not.toHaveProperty('mediaPath');
    await expect(fs.stat(path.join(root, before.mediaPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(externalPath, 'utf8')).toBe('0123456789');
    expect(await migrateManagedLibraryEntryToExternal(item.id, LOCATION, FILE, true)).toMatchObject({ existing: true, released: false, item: { id: item.id } });
    const reindexed = await (await importRequest()).json(); expect(reindexed.existing).toBe(true); expect(reindexed.item.id).toBe(item.id);
    expect((await (await library(request('/api/library'))).json()).items).toHaveLength(1);
  });

  it('leaves the original manifest and managed media untouched when full content hashes differ', async () => {
    const item = await managedItem('abcdefghij');
    const file = path.join(root, '.libretv/items', `${item.id}.json`); const before = await fs.readFile(file, 'utf8');
    await expect(migrateManagedLibraryEntryToExternal(item.id, LOCATION, FILE, true)).rejects.toThrow('内容');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(root, JSON.parse(before).mediaPath), 'utf8')).toBe('abcdefghij');
    expect(await fs.readFile(externalPath, 'utf8')).toBe('0123456789');
  });

  it('refuses migration if the external file changes during full-hash verification', async () => {
    const item = await managedItem();
    const file = path.join(root, '.libretv/items', `${item.id}.json`); const before = await fs.readFile(file, 'utf8');
    const open = mocks.open.getMockImplementation()!;
    let changed = false;
    mocks.open.mockImplementation(async (expected) => {
      const handle = await open(expected);
      handle.read = new Proxy(handle.read, { apply(target, thisArgument, arguments_) {
        const result = Reflect.apply(target, thisArgument, arguments_) as Promise<unknown>;
        return result.then(async (value) => {
          if (!changed) {
            changed = true;
            await fs.writeFile(externalPath, 'abcdefghij');
            await fs.utimes(externalPath, new Date(), new Date(Date.now() + 1000));
          }
          return value;
        });
      } });
      return handle;
    });
    await expect(migrateManagedLibraryEntryToExternal(item.id, LOCATION, FILE, true)).rejects.toThrow('变化');
    expect(changed).toBe(true); expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(root, JSON.parse(before).mediaPath), 'utf8')).toBe('0123456789');
    expect(await fs.readFile(externalPath, 'utf8')).toBe('abcdefghij');
  });

  it('reopens the selected path after hashing instead of trusting a stable old descriptor', async () => {
    const item = await managedItem();
    const file = path.join(root, '.libretv/items', `${item.id}.json`); const before = await fs.readFile(file, 'utf8');
    const open = mocks.open.getMockImplementation()!;
    const originalPath = path.join(path.dirname(externalPath), 'renamed-original.mp4');
    let opened = 0;
    mocks.open.mockImplementation(async (expected) => {
      opened++;
      if (opened === 3) {
        // Resolve and the full-hash descriptor already succeeded. Replace the
        // pathname only when the required pre-commit fresh open is attempted.
        await fs.rename(externalPath, originalPath); await fs.writeFile(externalPath, 'abcdefghij');
      }
      return open(expected);
    });
    await expect(migrateManagedLibraryEntryToExternal(item.id, LOCATION, FILE, true)).rejects.toThrow();
    expect(opened).toBe(3); expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(root, JSON.parse(before).mediaPath), 'utf8')).toBe('0123456789');
    expect(await fs.readFile(originalPath, 'utf8')).toBe('0123456789'); expect(await fs.readFile(externalPath, 'utf8')).toBe('abcdefghij');
  });
});
