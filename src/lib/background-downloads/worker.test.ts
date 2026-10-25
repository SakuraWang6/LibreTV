import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession, SESSION_COOKIE } from '@/lib/auth';
import { listLibrary, createUpload, appendUpload, completeUpload } from '@/lib/local-library/server';
import { GET, POST } from '@/app/api/downloads/route';
import { POST as cancelRoute } from '@/app/api/downloads/[id]/cancel/route';
import { POST as retryRoute } from '@/app/api/downloads/[id]/retry/route';
import { POST as pauseRoute } from '@/app/api/downloads/[id]/pause/route';
import { POST as resumeRoute } from '@/app/api/downloads/[id]/resume/route';
import { DELETE } from '@/app/api/downloads/[id]/route';
import { enqueueDownload, readTask, mutateTask, downloadsRoot, pauseDownload, resumeDownload, allStoredTasks } from './store';
import { processTask, runWorker } from './worker';
import { createMediaPlan, downloadResource, remuxLocal } from './media';
import * as library from '@/lib/local-library/server';

vi.mock('@/lib/ssrf', () => ({ checkUpstreamAllowed: vi.fn(async (url: string) => ({ ok: url.startsWith('https://media.example/') })) }));
vi.mock('./media', () => ({
  maxJobBytes: () => 1024 * 1024,
  requireFreeSpace: vi.fn(async () => undefined),
  createMediaPlan: vi.fn(async () => ({ version: 1, input: 'r000000.bin', resources: [{ url: 'https://media.example/a.ts', name: 'r000000.bin' }] })),
  downloadResource: vi.fn(async (_resource, directory: string) => { await fs.writeFile(path.join(directory, 'r000000.bin'), 'test video'); return 10; }),
  remuxLocal: vi.fn(async (_plan, directory: string, signal: AbortSignal) => { signal.throwIfAborted(); const target = path.join(directory, 'result.mp4'); await fs.writeFile(target, 'complete movie'); return target; }),
}));

let directory: string;
let cookie: string;
const metadata = { title: '后台电影', kind: 'movie', year: '2026' } as const;
const request = (method: string, data?: unknown, headers: Record<string, string> = {}) => new Request('http://127.0.0.1:8899/api/downloads', { method, headers: { cookie, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  vi.clearAllMocks();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-background-worker-'));
  vi.stubEnv('LOCAL_LIBRARY_DIR', directory); vi.stubEnv('PASSWORD', 'test-background-password'); vi.stubEnv('PROXY_SECRET', 'test-secret'); vi.stubEnv('BACKGROUND_DOWNLOADS_ENABLED', '1');
  cookie = `${SESSION_COOKIE}=${signSession().token}`;
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe('durable background download queue', () => {
  it('persists an ordinary source for an independent worker and rejects retired contexts and caller headers', async () => {
    const body = { url: 'https://media.example/movie.mp4', metadata };
    const created = await POST(request('POST', body));
    expect(created.status).toBe(200);
    const { task } = await created.json();
    expect(await readTask(task.id)).toMatchObject({ status: 'queued' });
    const signal = new AbortController().signal;
    await processTask(task.id, signal);
    expect(createMediaPlan).toHaveBeenLastCalledWith(body.url, signal);
    expect(downloadResource).toHaveBeenLastCalledWith(expect.any(Object), expect.any(String), signal, 0);
    expect(await readTask(task.id)).toMatchObject({ status: 'completed' });
    for (const data of [{ mediaContext: 'libvio' }, { mediaContext: null }, { mediaContext: { Cookie: 'secret' } }, { headers: { Cookie: 'secret' } }, { cookie: 'secret' }, { provider: 'quark' }, { quark: {} }]) {
      expect((await POST(request('POST', { ...body, ...data }))).status).toBe(400);
    }
  });

  it('authenticates every endpoint and rejects cross-origin writes and private sources', async () => {
    expect((await GET(new Request('http://localhost/api/downloads'))).status).toBe(401);
    expect((await POST(request('POST', {}, { origin: 'https://attacker.example' }))).status).toBe(403);
    expect((await POST(request('POST', { url: 'http://127.0.0.1/metadata', metadata }))).status).toBe(400);
    const id = 'a'.repeat(32);
    for (const route of [cancelRoute, retryRoute, pauseRoute, resumeRoute, DELETE]) expect((await route(new Request('http://localhost/api/downloads', { method: 'POST' }), context(id))).status).toBe(401);
    for (const route of [pauseRoute, resumeRoute]) expect((await route(request('POST', undefined, { origin: 'https://attacker.example' }), context(id))).status).toBe(403);
  });

  it('deduplicates lost-response retries and preserves queue state independently of any browser', async () => {
    const body = { url: 'https://media.example/a.m3u8', metadata, idempotencyKey: 'browser:old-task' };
    const first = await enqueueDownload(body);
    const repeated = await enqueueDownload(body);
    expect(repeated.task.id).toBe(first.task.id);
    expect((await readTask(first.task.id)).status).toBe('queued');
    const response = await GET(request('GET'));
    const listed = await response.json();
    expect(listed).toMatchObject({ enabled: true, workerOnline: false });
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].idempotencyKey).toBeUndefined();
    expect(listed.tasks[0].uploadId).toBeUndefined();
  });

  it('excludes retired provider jobs and refuses resume, retry or HTTP fallback without modifying their files', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const stored = await readTask(task.id);
    const root = await downloadsRoot();
    const oldJobs = [
      { provider: 'quark', status: 'queued' },
      { quark: { fileId: 'retired-reference' }, status: 'processing' },
      { mediaContext: 'libvio', status: 'paused' },
      { provider: 'retired-provider', status: 'failed' },
    ];
    for (const [index, old] of oldJobs.entries()) {
      const id = index.toString(16).padStart(32, '0');
      const file = path.join(root, `${id}.json`);
      const original = JSON.stringify({ ...stored, ...old, id });
      await fs.writeFile(file, original);
      const work = path.join(root, 'work', id);
      await fs.mkdir(work, { recursive: true });
      await fs.writeFile(path.join(work, 'retained.part'), 'checkpoint');
      await expect(readTask(id)).rejects.toMatchObject({ status: 410 });
      await expect(processTask(id, new AbortController().signal)).rejects.toMatchObject({ status: 410 });
      for (const route of [resumeRoute, retryRoute]) expect((await route(request('POST'), context(id))).status).toBe(410);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
      expect(await fs.readFile(path.join(work, 'retained.part'), 'utf8')).toBe('checkpoint');
    }
    expect(createMediaPlan).not.toHaveBeenCalled();
    expect(downloadResource).not.toHaveBeenCalled();
    expect((await allStoredTasks()).map((entry) => entry.id)).toEqual([task.id]);
    const listed = await (await GET(request('GET'))).json();
    expect(listed.tasks.map((entry: { id: string }) => entry.id)).toEqual([task.id]);
    await processTask(task.id, new AbortController().signal);
    expect((await readTask(task.id)).status).toBe('completed');
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('keeps the 200-record cap while allowing an existing idempotent media task', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata, idempotencyKey: 'full-queue' });
    const stored = await readTask(task.id);
    const root = await downloadsRoot();
    await Promise.all(Array.from({ length: 199 }, async (_, index) => {
      const id = index.toString(16).padStart(32, '0');
      await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify({ ...stored, id, idempotencyKey: `filler-${index}` }));
    }));
    expect(await allStoredTasks()).toHaveLength(200);
    await expect(enqueueDownload({ url: 'https://media.example/b.m3u8', metadata })).rejects.toThrow('下载记录已满');
    expect((await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata, idempotencyKey: 'full-queue' })).task.id).toBe(task.id);
  });

  it('downloads into the library exactly once even after a crash following its commit', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const uploadId = '1'.repeat(32);
    await mutateTask(task.id, (entry) => { entry.status = 'processing'; entry.uploadId = uploadId; Object.assign(entry, { uploadReady: true }); });
    await createUpload({ metadata, format: 'MP4' }, uploadId);
    await appendUpload(uploadId, 0, new Request('http://worker/', { method: 'PUT', body: 'already complete movie' }));
    await completeUpload(uploadId); // Simulate crash before queue commit.
    await processTask(task.id, new AbortController().signal);
    expect((await readTask(task.id))).toMatchObject({ status: 'completed', libraryItemId: uploadId });
    expect((await listLibrary()).items).toHaveLength(1);
    expect((await DELETE(request('DELETE'), context(task.id))).status).toBe(200);
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('commits a normal queued job and never treats cancellation as completion', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    await processTask(task.id, new AbortController().signal);
    const result = await readTask(task.id);
    expect(result.status).toBe('completed');
    expect((await listLibrary()).items[0].id).toBe(result.libraryItemId);
    expect((await fs.readdir(path.join(await downloadsRoot(), 'work')))).not.toContain(task.id);

    const second = await enqueueDownload({ url: 'https://media.example/b.m3u8', metadata });
    expect((await cancelRoute(request('POST'), context(second.task.id))).status).toBe(200);
    await processTask(second.task.id, new AbortController().signal);
    expect(await readTask(second.task.id)).toMatchObject({ status: 'cancelled', cancelRequested: false });
    expect((await listLibrary()).items).toHaveLength(1);
    expect((await retryRoute(request('POST'), context(second.task.id))).status).toBe(200);
    expect((await readTask(second.task.id)).status).toBe('queued');
    expect((await DELETE(request('DELETE'), context(second.task.id))).status).toBe(409);
  });

  it('persists a queued pause across worker startup and resumes it explicitly', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const response = await pauseRoute(request('POST'), context(task.id));
    expect(response.status).toBe(200);
    const paused = (await response.json()).task;
    expect(paused.status).toBe('paused');
    expect(paused.pauseRequested).toBeUndefined();
    expect((await allStoredTasks())[0]).toMatchObject({ id: task.id, status: 'paused', pauseRequested: true });
    await processTask(task.id, new AbortController().signal);
    expect(createMediaPlan).not.toHaveBeenCalled();
    expect(await readTask(task.id)).toMatchObject({ status: 'paused', pauseRequested: false });
    expect((await pauseRoute(request('POST'), context(task.id))).status).toBe(200);
    expect((await DELETE(request('DELETE'), context(task.id))).status).toBe(409);
    expect((await resumeRoute(request('POST'), context(task.id))).status).toBe(200);
    expect(await readTask(task.id)).toMatchObject({ status: 'queued', pauseRequested: false });
    await processTask(task.id, new AbortController().signal);
    expect((await readTask(task.id)).status).toBe('completed');
  });

  it('keeps completed resources when a pause arrives during the download', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    vi.mocked(downloadResource).mockImplementationOnce(async (_resource, work) => {
      await fs.writeFile(path.join(work, 'r000000.bin'), 'saved segment');
      await pauseDownload(task.id);
      return 13;
    });
    await processTask(task.id, new AbortController().signal);
    const work = path.join(await downloadsRoot(), 'work', task.id);
    expect(await fs.readFile(path.join(work, 'r000000.bin'), 'utf8')).toBe('saved segment');
    expect(await readTask(task.id)).toMatchObject({ status: 'paused', finished: 1, bytes: 13 });
    expect((await listLibrary()).items).toHaveLength(0);
    expect(remuxLocal).not.toHaveBeenCalled();
    await resumeDownload(task.id);
    vi.mocked(downloadResource).mockImplementationOnce(async (_resource, resumed) => {
      expect(resumed).toBe(work);
      return (await fs.stat(path.join(resumed, 'r000000.bin'))).size;
    });
    await processTask(task.id, new AbortController().signal);
    expect(createMediaPlan).toHaveBeenCalledTimes(1); // The durable plan is reused.
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('does not publish ready staging while paused and commits the same id after resume', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const uploadId = '2'.repeat(32);
    await createUpload({ metadata, format: 'MP4' }, uploadId);
    await appendUpload(uploadId, 0, new Request('http://worker/', { method: 'PUT', body: 'ready movie' }));
    await mutateTask(task.id, (entry) => { entry.status = 'processing'; entry.uploadId = uploadId; Object.assign(entry, { uploadReady: true }); });
    await pauseDownload(task.id);
    await processTask(task.id, new AbortController().signal);
    expect((await listLibrary()).items).toHaveLength(0);
    expect(await readTask(task.id)).toMatchObject({ status: 'paused', uploadId, uploadReady: true });
    await resumeDownload(task.id);
    await processTask(task.id, new AbortController().signal);
    expect(await readTask(task.id)).toMatchObject({ status: 'completed', libraryItemId: uploadId });
    expect(createMediaPlan).not.toHaveBeenCalled();
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('resumes a paused library copy at its durable upload offset', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const uploadId = '3'.repeat(32);
    const movie = Buffer.from('complete movie');
    const prefix = movie.subarray(0, 5);
    const work = path.join(await downloadsRoot(), 'work', task.id);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'result.mp4'), movie);
    await createUpload({ metadata, format: 'MP4' }, uploadId);
    await appendUpload(uploadId, 0, new Request('http://worker/', { method: 'PUT', body: prefix }));
    await mutateTask(task.id, (entry) => { entry.status = 'processing'; entry.uploadId = uploadId; });
    await pauseDownload(task.id);
    await processTask(task.id, new AbortController().signal);
    expect(await createUpload({ metadata, format: 'MP4' }, uploadId)).toMatchObject({ offset: prefix.length });
    const append = vi.spyOn(library, 'appendUpload');
    await resumeDownload(task.id);
    await processTask(task.id, new AbortController().signal);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][1]).toBe(prefix.length);
    expect(createMediaPlan).not.toHaveBeenCalled();
    expect(remuxLocal).not.toHaveBeenCalled();
    expect((await listLibrary()).items[0]).toMatchObject({ id: uploadId, bytes: movie.length });
  });

  it('gives cancellation priority over a pause and removes only unfinished staging', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const uploadId = '4'.repeat(32);
    const work = path.join(await downloadsRoot(), 'work', task.id);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'result.mp4'), 'partial');
    await createUpload({ metadata, format: 'MP4' }, uploadId);
    await appendUpload(uploadId, 0, new Request('http://worker/', { method: 'PUT', body: 'partial' }));
    await mutateTask(task.id, (entry) => { entry.status = 'processing'; entry.uploadId = uploadId; });
    await pauseDownload(task.id);
    expect((await cancelRoute(request('POST'), context(task.id))).status).toBe(200);
    expect((await resumeRoute(request('POST'), context(task.id))).status).toBe(409);
    await processTask(task.id, new AbortController().signal);
    expect(await readTask(task.id)).toMatchObject({ status: 'cancelled', cancelRequested: false, pauseRequested: false });
    await expect(fs.stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(directory, '.libretv', 'uploads', `${uploadId}.part`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await listLibrary()).items).toHaveLength(0);
  });

  it('keeps a committed film when a pause races with crash recovery', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const uploadId = '5'.repeat(32);
    await createUpload({ metadata, format: 'MP4' }, uploadId);
    await appendUpload(uploadId, 0, new Request('http://worker/', { method: 'PUT', body: 'committed movie' }));
    await completeUpload(uploadId);
    await mutateTask(task.id, (entry) => { entry.status = 'processing'; entry.uploadId = uploadId; Object.assign(entry, { uploadReady: true }); });
    await pauseDownload(task.id);
    await processTask(task.id, new AbortController().signal);
    expect(await readTask(task.id)).toMatchObject({ status: 'completed', libraryItemId: uploadId, pauseRequested: false });
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('serializes a late pause with the library commit so completion wins', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    let entered!: () => void;
    let release!: () => void;
    const committing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const complete = library.completeUpload;
    vi.spyOn(library, 'completeUpload').mockImplementationOnce(async (id) => {
      entered(); await gate;
      return complete(id);
    });
    const processing = processTask(task.id, new AbortController().signal);
    await committing;
    const pausing = pauseDownload(task.id);
    release();
    await processing;
    expect((await pausing).task.status).toBe('completed');
    expect(await readTask(task.id)).toMatchObject({ status: 'completed', pauseRequested: false });
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('stops an in-flight request and honors a quick resume before its abort settles', async () => {
    const { task } = await enqueueDownload({ url: 'https://media.example/a.m3u8', metadata });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.mocked(downloadResource).mockImplementationOnce(async (_resource, work, signal) => {
      await fs.writeFile(path.join(work, 'retained.part'), 'partial bytes');
      await pauseDownload(task.id);
      if (!signal.aborted) await new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); });
      await resumeDownload(task.id);
      signal.throwIfAborted();
      throw new Error('expected pause to abort the request');
    });
    const worker = runWorker();
    try {
      await vi.waitFor(async () => { expect((await readTask(task.id)).status).toBe('completed'); }, { timeout: 3000, interval: 25 });
      expect(downloadResource).toHaveBeenCalledTimes(2);
      expect((await listLibrary()).items).toHaveLength(1);
    } finally {
      process.emit('SIGTERM');
      await worker;
      log.mockRestore();
    }
  });
});
