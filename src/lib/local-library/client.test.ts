import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupInterruptedLibraryUploads, createLibrarySaveTarget, fetchLibrary, guessLibraryMetadata, importLibraryFile, updateLibraryMetadata } from './client';
import { LOCAL_LIBRARY_UPDATED_EVENT } from './types';

const metadata = { title: '测试电影', kind: 'movie' as const };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('navigator', {});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('local library client', () => {
  it('does not cache a pre-login failure or silently treat a malformed result as disabled', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ enabled: true, items: [] }))
      .mockResolvedValueOnce(json({ items: [] }));
    vi.stubGlobal('fetch', request);
    await expect(fetchLibrary()).rejects.toThrow('请登录');
    await expect(fetchLibrary()).resolves.toEqual({ enabled: true, items: [] });
    await expect(fetchLibrary()).rejects.toThrow('返回异常');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('serializes writes in bounded chunks and announces completion only after the commit', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const updated = vi.fn();
    events.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, updated);
    const chunks: { offset: number; data: Uint8Array }[] = [];
    let active = 0;
    let maxActive = 0;
    let committed = false;
    const request = vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') {
        expect(JSON.parse(options.body as string)).toEqual({ metadata, format: 'MP4' });
        return json({ id: 'upload-1', offset: 0 });
      }
      if (options.method === 'PUT') {
        active++;
        maxActive = Math.max(active, maxActive);
        await Promise.resolve();
        const data = new Uint8Array(options.body as ArrayBuffer);
        const offset = Number(url.split('offset=')[1]);
        chunks.push({ offset, data });
        expect(data.length).toBeLessThanOrEqual(1024 * 1024);
        active--;
        return json({ offset: offset + data.byteLength });
      }
      expect(updated).not.toHaveBeenCalled();
      committed = true;
      return json({ item: { id: 'movie-1' } });
    });
    vi.stubGlobal('fetch', request);
    const target = await createLibrarySaveTarget(metadata);
    expect(target.kind).toBe('fs');
    await Promise.all([target.write(new Uint8Array(2 * 1024 * 1024 + 5).fill(4)), target.write(new Uint8Array([9, 8]))]);
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 1024 * 1024, 2 * 1024 * 1024, 2 * 1024 * 1024 + 5]);
    expect(Array.from(chunks[3].data)).toEqual([9, 8]);
    expect(maxActive).toBe(1);
    expect(committed).toBe(false);
    await target.close();
    await target.close();
    expect(updated).toHaveBeenCalledTimes(1);
    expect(committed).toBe(true);
  });

  it('retries a lost chunk response with identical bytes at the same offset', async () => {
    const calls: { url: string; bytes: number[] }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') return json({ id: 'u', offset: 0 });
      if (options.method === 'DELETE') return json({ ok: true });
      calls.push({ url, bytes: Array.from(new Uint8Array(options.body as ArrayBuffer)) });
      if (calls.length === 1) throw new TypeError('Response lost after disk write');
      return json({ offset: 3 });
    }));
    const target = await createLibrarySaveTarget(metadata);
    await target.write(new Uint8Array([1, 2, 3]));
    expect(calls).toEqual([
      { url: '/api/library/uploads/u?offset=0', bytes: [1, 2, 3] },
      { url: '/api/library/uploads/u?offset=0', bytes: [1, 2, 3] },
    ]);
    await target.abort();
  });

  it('stops after two retries and never announces a failed commit as completed', async () => {
    const events = new EventTarget();
    const updated = vi.fn();
    events.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, updated);
    vi.stubGlobal('window', events);
    let completes = 0;
    let deletes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') return json({ id: 'u', offset: 0 });
      if (options.method === 'PUT') return json({ offset: 3 });
      if (options.method === 'DELETE') { deletes++; return json({ ok: true }); }
      completes++;
      return json({ error: '磁盘空间不足' }, 507);
    }));
    const target = await createLibrarySaveTarget(metadata);
    await target.write(new Uint8Array([1, 2, 3]));
    await expect(target.close()).rejects.toThrow('磁盘空间不足');
    await Promise.all([target.abort(), target.abort()]);
    expect(completes).toBe(3);
    expect(deletes).toBe(1);
    expect(updated).not.toHaveBeenCalled();
  });

  it('refuses writes and commit after an abort', async () => {
    const request = vi.fn(async (_url: string, options: RequestInit) => options.method === 'POST'
      ? json({ id: 'u', offset: 0 }) : new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', request);
    const target = await createLibrarySaveTarget(metadata);
    await target.abort();
    await expect(target.write(new Uint8Array([1]))).rejects.toThrow('已结束');
    await expect(target.close()).rejects.toThrow('已取消');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('imports file slices and reports 100 percent only after the server commits', async () => {
    const progress: number[] = [];
    const file = new File([new Uint8Array(1024 * 1024 + 4)], 'Movie.m4v');
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') return json({ id: 'u', offset: 0 });
      if (options.method === 'PUT') return json({ offset: Number(url.split('offset=')[1]) + (options.body as ArrayBuffer).byteLength });
      expect(progress).not.toContain(100);
      return json({ item: { id: 'movie' } });
    }));
    await importLibraryFile(file, metadata, (percent) => progress.push(percent));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(progress[progress.length - 1]).toBe(100);
    await expect(importLibraryFile(new File(['bad'], 'video.mkv'), metadata)).rejects.toThrow('请选择');
  });

  it('cleans up a failed import without reporting 100 percent or accepting an unconfirmed commit', async () => {
    const progress: number[] = [];
    let deletes = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') return json({ id: 'u', offset: 0 });
      if (options.method === 'PUT') return json({ offset: 3 });
      if (options.method === 'DELETE') { deletes++; return json({ ok: true }); }
      return json({});
    }));
    await expect(importLibraryFile(new File(['123'], 'Movie.mp4'), metadata, (percent) => progress.push(percent)))
      .rejects.toThrow('未确认保存完成');
    expect(progress).not.toContain(100);
    expect(deletes).toBe(1);
  });
});

describe('interrupted library upload recovery', () => {
  const prefix = 'libretv:pending-library-upload:';
  const ownerKey = 'libretv:library-upload-owner';
  function remember(id: string, patch: Record<string, unknown> = {}) {
    localStorage.setItem(`${prefix}${id}`, JSON.stringify({
      id, owner: 'previous-tab', documentId: 'previous-document',
      startedAt: Date.now() - 5000, heartbeatAt: Date.now() - 5000, usesLock: false,
      ...patch,
    }));
  }

  it('persists staging IDs immediately and removes recovery records after commit/abort', async () => {
    let created = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/library/uploads') return json({ id: `u${++created}`, offset: 0 });
      return options.method === 'DELETE' ? json({ cancelled: true }) : json({ item: { id: 'video' } });
    }));
    const first = await createLibrarySaveTarget(metadata);
    const record = JSON.parse(localStorage.getItem(`${prefix}u1`)!);
    expect(record).toMatchObject({ id: 'u1', owner: sessionStorage.getItem(ownerKey), usesLock: false });
    expect(record.startedAt).toBeGreaterThan(0);
    await first.close();
    expect(localStorage.getItem(`${prefix}u1`)).toBeNull();
    const second = await createLibrarySaveTarget(metadata);
    expect(localStorage.getItem(`${prefix}u2`)).not.toBeNull();
    await second.abort();
    expect(localStorage.getItem(`${prefix}u2`)).toBeNull();
  });

  it('cleans a previous document of this tab while preserving another tab with a fresh heartbeat', async () => {
    sessionStorage.setItem(ownerKey, 'this-tab');
    remember('orphan', { owner: 'this-tab' });
    remember('other-tab');
    const request = vi.fn(async (url: string) => { void url; return json({ cancelled: true }); });
    vi.stubGlobal('fetch', request);
    await cleanupInterruptedLibraryUploads();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/library/uploads/orphan');
    expect(localStorage.getItem(`${prefix}orphan`)).toBeNull();
    expect(localStorage.getItem(`${prefix}other-tab`)).not.toBeNull();
  });

  it('retains unauthorized cleanup records and retries successfully after login', async () => {
    sessionStorage.setItem(ownerKey, 'this-tab');
    remember('orphan', { owner: 'this-tab' });
    const request = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(json({ cancelled: true }));
    vi.stubGlobal('fetch', request);
    await cleanupInterruptedLibraryUploads();
    expect(localStorage.getItem(`${prefix}orphan`)).not.toBeNull();
    await cleanupInterruptedLibraryUploads();
    expect(localStorage.getItem(`${prefix}orphan`)).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('forgets a completed upload conflict without attempting any media deletion', async () => {
    sessionStorage.setItem(ownerKey, 'this-tab');
    remember('committed', { owner: 'this-tab' });
    const request = vi.fn(async () => json({ error: '该视频已入库' }, 409));
    vi.stubGlobal('fetch', request);
    await cleanupInterruptedLibraryUploads();
    expect(localStorage.getItem(`${prefix}committed`)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toMatchObject(['/api/library/uploads/committed', { method: 'DELETE' }]);
  });

  it('retains records after a network failure and reclaims an expired heartbeat on a later run', async () => {
    remember('stale', { heartbeatAt: Date.now() - 25 * 60 * 60 * 1000 });
    const request = vi.fn().mockRejectedValue(new TypeError('Offline'));
    vi.stubGlobal('fetch', request);
    await cleanupInterruptedLibraryUploads();
    expect(request).toHaveBeenCalledTimes(3);
    expect(localStorage.getItem(`${prefix}stale`)).not.toBeNull();
    request.mockResolvedValue(json({ cancelled: true }));
    await cleanupInterruptedLibraryUploads();
    expect(localStorage.getItem(`${prefix}stale`)).toBeNull();
  });

  it('uses browser locks to preserve a live other tab even if its heartbeat was throttled', async () => {
    remember('live', { usesLock: true, heartbeatAt: 0 });
    remember('crashed', { usesLock: true });
    const lockRequest = vi.fn(async (name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
      await callback(name.endsWith('live') ? null : {});
    });
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
    const request = vi.fn(async (url: string) => { void url; return json({ cancelled: true }); });
    vi.stubGlobal('fetch', request);
    await cleanupInterruptedLibraryUploads();
    expect(localStorage.getItem(`${prefix}live`)).not.toBeNull();
    expect(localStorage.getItem(`${prefix}crashed`)).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/api/library/uploads/crashed');
  });

  it('holds a browser lock before publishing the ID and releases it with the target', async () => {
    const held = new Set<string>();
    vi.stubGlobal('navigator', { locks: { request: async (
      name: string, _options: unknown, callback: (lock: object | null) => Promise<void>,
    ) => {
      expect(localStorage.getItem(`${prefix}locked`)).toBeNull();
      if (held.has(name)) { await callback(null); return; }
      held.add(name);
      try { await callback({}); } finally { held.delete(name); }
    } } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/library/uploads'
      ? json({ id: 'locked', offset: 0 }) : json({ cancelled: true })));
    const target = await createLibrarySaveTarget(metadata);
    expect(held.has(`${prefix}locked`)).toBe(true);
    expect(JSON.parse(localStorage.getItem(`${prefix}locked`)!).usesLock).toBe(true);
    await target.abort();
    expect(held.size).toBe(0);
    expect(localStorage.getItem(`${prefix}locked`)).toBeNull();
  });

  it('never cleans up a target still running in the current document', async () => {
    const request = vi.fn(async (url: string) => url === '/api/library/uploads'
      ? json({ id: 'active', offset: 0 }) : json({ cancelled: true }));
    vi.stubGlobal('fetch', request);
    const target = await createLibrarySaveTarget(metadata);
    await cleanupInterruptedLibraryUploads();
    expect(request).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(`${prefix}active`)).not.toBeNull();
    await target.abort();
  });

  it('refuses to create server staging when persistent recovery storage is unavailable', async () => {
    vi.stubGlobal('localStorage', { setItem() { throw new Error('Blocked'); } });
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(createLibrarySaveTarget(metadata)).rejects.toThrow('本地存储');
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels newly created staging if writing its recovery record fails', async () => {
    const save = localStorage.setItem.bind(localStorage);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === `${prefix}u`) throw new Error('Quota exceeded');
      save(key, value);
    });
    const request = vi.fn(async (url: string) => url === '/api/library/uploads'
      ? json({ id: 'u', offset: 0 }) : json({ cancelled: true }));
    vi.stubGlobal('fetch', request);
    await expect(createLibrarySaveTarget(metadata)).rejects.toThrow('本次下载已取消');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toBe('/api/library/uploads/u');
  });
});

describe('guessLibraryMetadata', () => {
  it.each([
    ['Some.Show.S02E13.1080p.mp4', { title: 'Some Show', kind: 'tv', seasonNumber: 2, episodeNumber: 13 }],
    ['长安十二时辰 第3集.mp4', { title: '长安十二时辰', kind: 'tv', seasonNumber: 1, episodeNumber: 3 }],
    ['电影名字.mp4', { title: '电影名字', kind: 'movie' }],
    ['/a/b/影片名称.M4V', { title: '影片名称', kind: 'movie' }],
    ['教父 1972.mp4', { title: '教父', year: '1972', kind: 'movie' }],
    ['教父2 1974.mp4', { title: '教父2', year: '1974', kind: 'movie' }],
    ['教父3 (1990).mp4', { title: '教父3', year: '1990', kind: 'movie' }],
    ['影片【2020】.mp4', { title: '影片', year: '2020', kind: 'movie' }],
    ['Some.Show.2019.S02E13.mp4', { title: 'Some Show', year: '2019', kind: 'tv', seasonNumber: 2, episodeNumber: 13 }],
    ['1917.mp4', { title: '1917', kind: 'movie' }],
    ['1984.mp4', { title: '1984', kind: 'movie' }],
    ['2001太空漫游.mp4', { title: '2001太空漫游', kind: 'movie' }],
  ])('recognizes %s', (name, expected) => expect(guessLibraryMetadata(name)).toEqual(expected));
});

describe('updateLibraryMetadata', () => {
  it('sends only metadata to its own route and refreshes the library after confirmation', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const changed = vi.fn();
    events.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, changed);
    const item = { ...metadata, id: 'movie-1' };
    const request = vi.fn().mockResolvedValue(json({ item }));
    vi.stubGlobal('fetch', request);
    await expect(updateLibraryMetadata('movie-1', metadata)).resolves.toEqual(item);
    expect(request).toHaveBeenCalledWith('/api/library/movie-1/metadata', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ metadata }),
    }));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not announce an update when the server did not confirm a saved item', async () => {
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const changed = vi.fn();
    events.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, changed);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({})));
    await expect(updateLibraryMetadata('movie-1', metadata)).rejects.toThrow('未确认');
    expect(changed).not.toHaveBeenCalled();
  });
});
