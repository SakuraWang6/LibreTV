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
import { enqueueDownload, enqueueQuarkDownload, enqueueQuarkDownloads, readTask, mutateTask, downloadsRoot, pauseDownload, resumeDownload, allStoredTasks } from './store';
import { processTask, runWorker } from './worker';
import { createMediaPlan, downloadResource, remuxLocal } from './media';
import * as library from '@/lib/local-library/server';
import { cleanupQuarkDownload, downloadQuarkMedia } from '@/lib/quark/download';

vi.mock('@/lib/ssrf', () => ({ checkUpstreamAllowed: vi.fn(async (url: string) => ({ ok: url.startsWith('https://media.example/') })) }));
vi.mock('./media', () => ({
  maxJobBytes: () => 1024 * 1024,
  requireFreeSpace: vi.fn(async () => undefined),
  createMediaPlan: vi.fn(async () => ({ version: 1, input: 'r000000.bin', resources: [{ url: 'https://media.example/a.ts', name: 'r000000.bin' }] })),
  downloadResource: vi.fn(async (_resource, directory: string) => { await fs.writeFile(path.join(directory, 'r000000.bin'), 'test video'); return 10; }),
  remuxLocal: vi.fn(async (_plan, directory: string, signal: AbortSignal) => { signal.throwIfAborted(); const target = path.join(directory, 'result.mp4'); await fs.writeFile(target, 'complete movie'); return target; }),
}));
vi.mock('@/lib/quark/download', () => ({
  cleanupQuarkDownload: vi.fn(async () => undefined),
  downloadQuarkMedia: vi.fn(async (_reference, work: string, _signal: AbortSignal, onProgress?: (bytes: number, total: number) => Promise<void>) => {
    await fs.writeFile(path.join(work, 'r000000.bin'), 'quark video');
    await onProgress?.(11, 11);
    return { version: 1, input: 'r000000.bin', resources: [{ url: 'https://cdn.example/temporary.mp4', name: 'r000000.bin' }] };
  }),
}));

let directory: string;
let cookie: string;
const metadata = { title: '后台电影', kind: 'movie', year: '2026' } as const;
const quarkReference = { shareUrl: 'https://pan.quark.cn/s/privateShare?pwd=privateCode', fileId: 'privateFileId', name: 'movie.mp4', size: 11, accountKey: 'a'.repeat(64) };
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
  it('persists the public source context and restores it for an independent worker', async () => {
    const body = { url: 'https://media.example/movie.mp4', metadata, mediaContext: 'libvio' };
    const created = await POST(request('POST', body));
    expect(created.status).toBe(200);
    const { task } = await created.json();
    expect(await readTask(task.id)).toMatchObject({ mediaContext: 'libvio', status: 'queued' });
    const signal = new AbortController().signal;
    await processTask(task.id, signal);
    expect(createMediaPlan).toHaveBeenLastCalledWith(body.url, signal, 'libvio');
    expect(downloadResource).toHaveBeenLastCalledWith(expect.any(Object), expect.any(String), signal, 0, 'libvio');
    expect(await readTask(task.id)).toMatchObject({ mediaContext: 'libvio', status: 'completed' });
    for (const data of [{ mediaContext: 'https://attacker.example' }, { mediaContext: { Cookie: 'secret' } }, { headers: { Cookie: 'secret' } }, { cookie: 'secret' }]) {
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

  it('accepts Quark references only through its trusted queue entry and hides private fields', async () => {
    for (const injected of [{ provider: 'quark' }, { quark: quarkReference }, { provider: null }, { quark: null }]) {
      expect((await POST(request('POST', { url: 'https://media.example/movie.mp4', metadata, ...injected }))).status).toBe(400);
    }
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata, idempotencyKey: 'same-queue-key' });
    expect(task).toMatchObject({ provider: 'quark', url: 'https://pan.quark.cn/s/privateShare', status: 'queued' });
    expect(await readTask(task.id)).toMatchObject({ provider: 'quark', quark: quarkReference });
    const listed = await (await GET(request('GET'))).json();
    const publicJson = JSON.stringify(listed);
    for (const secret of ['privateFileId', 'privateCode', quarkReference.accountKey, 'accountKey', 'shareUrl', 'fileId']) expect(publicJson).not.toContain(secret);
    expect(listed.tasks[0].quark).toBeUndefined();
    // Both entries use the same durable idempotency/record-count namespace.
    expect((await enqueueDownload({ url: 'https://media.example/other.mp4', metadata, idempotencyKey: 'same-queue-key' })).task.id).toBe(task.id);
    expect(await allStoredTasks()).toHaveLength(1);
  });

  it('validates persisted provider references and permits only canonical Quark share hosts', async () => {
    for (const shareUrl of ['http://pan.quark.cn/s/id', 'https://pan.quark.cn.evil.test/s/id', 'https://user:secret@pan.quark.cn/s/id', 'https://pan.quark.cn:8443/s/id', 'https://pan.quark.cn/other/id', 'https://127.0.0.1/s/id']) {
      await expect(enqueueQuarkDownload({ reference: { ...quarkReference, shareUrl }, metadata })).rejects.toThrow('夸克');
    }
    for (const overrides of [{ size: -1 }, { size: 1.5 }, { fileId: '../file' }, { name: 'bad\u0000name' }, { accountKey: 'not-an-account-key' }, { cookie: 'caller-cookie' }]) {
      await expect(enqueueQuarkDownload({ reference: { ...quarkReference, ...overrides }, metadata })).rejects.toThrow('夸克文件引用');
    }
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata });
    await mutateTask(task.id, (entry) => { delete entry.quark; });
    await expect(readTask(task.id)).rejects.toThrow('夸克文件引用');
  });

  it('keeps the shared 200-record cap while allowing an existing idempotent Quark task', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata, idempotencyKey: 'quark-full-queue' });
    const stored = await readTask(task.id);
    const root = await downloadsRoot();
    await Promise.all(Array.from({ length: 199 }, async (_, index) => {
      const id = index.toString(16).padStart(32, '0');
      await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify({ ...stored, id, idempotencyKey: `filler-${index}` }));
    }));
    expect(await allStoredTasks()).toHaveLength(200);
    await expect(enqueueQuarkDownload({ reference: quarkReference, metadata })).rejects.toThrow('下载记录已满');
    await expect(enqueueDownload({ url: 'https://media.example/a.m3u8', metadata })).rejects.toThrow('下载记录已满');
    expect((await enqueueQuarkDownload({ reference: quarkReference, metadata, idempotencyKey: 'quark-full-queue' })).task.id).toBe(task.id);
  });

  it('checks whole-batch capacity before writing and does not count idempotent matches twice', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata, idempotencyKey: 'existing-quark' });
    const stored = await readTask(task.id);
    const root = await downloadsRoot();
    await Promise.all(Array.from({ length: 198 }, async (_, index) => {
      const id = index.toString(16).padStart(32, '0');
      await fs.writeFile(path.join(root, `${id}.json`), JSON.stringify({ ...stored, id, idempotencyKey: `filler-${index}` }));
    }));
    const first = { reference: quarkReference, metadata, idempotencyKey: 'new-quark-1' };
    const second = { reference: { ...quarkReference, fileId: 'second-file' }, metadata, idempotencyKey: 'new-quark-2' };
    await expect(enqueueQuarkDownloads([first, second])).rejects.toThrow('下载记录已满');
    expect(await allStoredTasks()).toHaveLength(199);
    expect((await allStoredTasks()).some((entry) => entry.idempotencyKey === first.idempotencyKey)).toBe(false);
    const accepted = await enqueueQuarkDownloads([{ ...first, idempotencyKey: 'existing-quark' }, second]);
    expect(accepted.tasks[0].id).toBe(task.id);
    expect(await allStoredTasks()).toHaveLength(200);
    expect((await enqueueQuarkDownloads([{ ...first, idempotencyKey: 'existing-quark' }, second])).tasks.map((entry) => entry.id)).toEqual(accepted.tasks.map((entry) => entry.id));
  });

  it('validates every Quark batch entry and rolls back new files if a queue write fails', async () => {
    const first = { reference: quarkReference, metadata, idempotencyKey: 'batch-1' };
    const second = { reference: { ...quarkReference, fileId: 'second-file' }, metadata, idempotencyKey: 'batch-2' };
    await expect(enqueueQuarkDownloads([first, { ...second, reference: { ...second.reference, size: -1 } }])).rejects.toThrow('夸克文件引用');
    expect(await allStoredTasks()).toHaveLength(0);
    const rename = fs.rename;
    let writes = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      writes++;
      if (writes === 2) throw new Error('simulated disk failure');
      return rename(from, to);
    });
    await expect(enqueueQuarkDownloads([first, second])).rejects.toThrow('simulated disk failure');
    expect(await allStoredTasks()).toHaveLength(0);
    expect((await fs.readdir(await downloadsRoot())).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('keeps worker queue reads behind a Quark batch publication', async () => {
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rename = fs.rename;
    let writes = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (++writes === 1) { entered(); await gate; }
    });
    const batch = enqueueQuarkDownloads([
      { reference: quarkReference, metadata, idempotencyKey: 'batch-1' },
      { reference: { ...quarkReference, fileId: 'second-file' }, metadata, idempotencyKey: 'batch-2' },
    ]);
    await writing;
    let observed = false;
    const reading = allStoredTasks().then((tasks) => { observed = true; return tasks; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(observed).toBe(false);
    release();
    await batch;
    expect(await reading).toHaveLength(2);
  });

  it('uses the Quark transfer instead of treating a share page as a media manifest', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata });
    const signal = new AbortController().signal;
    await processTask(task.id, signal);
    expect(downloadQuarkMedia).toHaveBeenCalledWith(quarkReference, expect.any(String), signal, expect.any(Function));
    expect(createMediaPlan).not.toHaveBeenCalled();
    expect(downloadResource).not.toHaveBeenCalled();
    expect(remuxLocal).toHaveBeenCalledWith(expect.objectContaining({ input: 'r000000.bin' }), expect.any(String), signal);
    expect(await readTask(task.id)).toMatchObject({ provider: 'quark', status: 'completed', bytes: 11, finished: 11, total: 11 });
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('keeps Quark transfer state across a paused task and resumes the same reference', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata });
    vi.mocked(downloadQuarkMedia).mockImplementationOnce(async (_reference, work, _signal, onProgress) => {
      await fs.writeFile(path.join(work, 'transfer-state.json'), JSON.stringify({ stableFile: 'saved-fid', offset: 5 }));
      await fs.writeFile(path.join(work, 'quark.part'), 'first');
      await onProgress?.(5, quarkReference.size);
      await pauseDownload(task.id);
      throw new Error('transport interrupted for pause');
    });
    await processTask(task.id, new AbortController().signal);
    expect(await readTask(task.id)).toMatchObject({ provider: 'quark', status: 'paused', bytes: 5, finished: 5, total: 11 });
    expect((await listLibrary()).items).toHaveLength(0);
    await resumeDownload(task.id);
    vi.mocked(downloadQuarkMedia).mockImplementationOnce(async (reference, work, _signal, onProgress) => {
      expect(reference).toEqual(quarkReference);
      expect(JSON.parse(await fs.readFile(path.join(work, 'transfer-state.json'), 'utf8'))).toEqual({ stableFile: 'saved-fid', offset: 5 });
      expect(await fs.readFile(path.join(work, 'quark.part'), 'utf8')).toBe('first');
      await fs.writeFile(path.join(work, 'r000000.bin'), 'quark video');
      await onProgress?.(11, 11);
      return { version: 1, input: 'r000000.bin', resources: [{ url: 'https://cdn.example/fresh.mp4', name: 'r000000.bin' }] };
    });
    await processTask(task.id, new AbortController().signal);
    expect((await readTask(task.id)).status).toBe('completed');
    expect(downloadQuarkMedia).toHaveBeenCalledTimes(2);
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('honors a quick Quark resume when the progress callback stopped the transfer before polling', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata });
    const controller = new AbortController();
    vi.mocked(downloadQuarkMedia).mockImplementationOnce(async (_reference, work, signal, onProgress) => {
      await fs.writeFile(path.join(work, 'quark-transfer.json'), '{"recordId":"saved-checkpoint"}');
      await onProgress?.(5, quarkReference.size);
      await pauseDownload(task.id);
      let callbackError: unknown;
      try { await onProgress?.(6, quarkReference.size); }
      catch (error) { callbackError = error; }
      expect(callbackError).toBeInstanceOf(Error);
      expect(callbackError).toMatchObject({ message: '后台下载已暂停' });
      // The runtime preserves this error while SIGINT saves the checkpoint.
      // Resume can arrive before the worker's 500 ms signal poll ever fires.
      await resumeDownload(task.id);
      expect(signal.aborted).toBe(false);
      throw callbackError;
    });
    await expect(processTask(task.id, controller.signal)).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(false);
    expect(await readTask(task.id)).toMatchObject({ status: 'queued', pauseRequested: false, bytes: 5 });
    expect((await readTask(task.id)).error).toBeUndefined();
    expect((await listLibrary()).items).toHaveLength(0);
    expect(remuxLocal).not.toHaveBeenCalled();
    vi.mocked(downloadQuarkMedia).mockImplementationOnce(async (_reference, work, _signal, onProgress) => {
      expect(await fs.readFile(path.join(work, 'quark-transfer.json'), 'utf8')).toContain('saved-checkpoint');
      await fs.writeFile(path.join(work, 'r000000.bin'), 'quark video');
      await onProgress?.(11, 11);
      return { version: 1, input: 'r000000.bin', resources: [] };
    });
    await processTask(task.id, new AbortController().signal);
    expect((await readTask(task.id)).status).toBe('completed');
    expect(downloadQuarkMedia).toHaveBeenCalledTimes(2);
    expect((await listLibrary()).items).toHaveLength(1);
  });

  it('defers a busy Quark cleanup without losing ownership or crashing the worker', async () => {
    const { task } = await enqueueQuarkDownload({ reference: quarkReference, metadata });
    const work = path.join(await downloadsRoot(), 'work', task.id);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, 'transfer-state.json'), '{"recordId":"owned-record"}');
    await cancelRoute(request('POST'), context(task.id));
    vi.mocked(cleanupQuarkDownload).mockRejectedValueOnce(new Error('official CLI busy'));
    await expect(processTask(task.id, new AbortController().signal)).resolves.toBeUndefined();
    expect(await readTask(task.id)).toMatchObject({ status: 'cancelled', cancelRequested: true });
    expect(await fs.readFile(path.join(work, 'transfer-state.json'), 'utf8')).toContain('owned-record');
    await processTask(task.id, new AbortController().signal);
    expect(cleanupQuarkDownload).toHaveBeenCalledTimes(2);
    expect(cleanupQuarkDownload).toHaveBeenLastCalledWith(work);
    expect(await readTask(task.id)).toMatchObject({ status: 'cancelled', cancelRequested: false });
    await expect(fs.stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await listLibrary()).items).toHaveLength(0);
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
