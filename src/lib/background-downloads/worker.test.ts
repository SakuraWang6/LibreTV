import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession, SESSION_COOKIE } from '@/lib/auth';
import { listLibrary, createUpload, appendUpload, completeUpload } from '@/lib/local-library/server';
import { GET, POST } from '@/app/api/downloads/route';
import { POST as cancelRoute } from '@/app/api/downloads/[id]/cancel/route';
import { POST as retryRoute } from '@/app/api/downloads/[id]/retry/route';
import { DELETE } from '@/app/api/downloads/[id]/route';
import { enqueueDownload, readTask, mutateTask, downloadsRoot } from './store';
import { processTask } from './worker';
import { createMediaPlan, downloadResource } from './media';

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
const metadata = { title: '后台电影', kind: 'movie', year: '2026' };
const request = (method: string, data?: unknown, headers: Record<string, string> = {}) => new Request('http://127.0.0.1:8899/api/downloads', { method, headers: { cookie, ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-background-worker-'));
  vi.stubEnv('LOCAL_LIBRARY_DIR', directory); vi.stubEnv('PASSWORD', 'test-background-password'); vi.stubEnv('PROXY_SECRET', 'test-secret'); vi.stubEnv('BACKGROUND_DOWNLOADS_ENABLED', '1');
  cookie = `${SESSION_COOKIE}=${signSession().token}`;
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

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
    for (const route of [cancelRoute, retryRoute, DELETE]) expect((await route(new Request('http://localhost/api/downloads', { method: 'POST' }), context(id))).status).toBe(401);
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
});
