import fs from 'node:fs/promises';
import path from 'node:path';
import { appendUpload, completeUpload, createUpload, getLibraryEntry, saveLibraryPoster, updateProgress } from '@/lib/local-library/server';
import { boundedBytes, remoteRequest } from './remote';
import { progressVersion, refreshCatalog, synchronizeProgress, syncPoster } from './service';
import { allTasks, atomicJson, mappingFile, readJson, syncConfig, syncRoot, taskFile, withLock, type CacheTask, type Mapping, type SyncConfig } from './storage';

const CHUNK = 256 * 1024;

async function changeTask(root: string, id: string, change: (task: CacheTask) => void, signal?: AbortSignal): Promise<CacheTask> {
  return withLock(root, `task-${id}`, async () => {
    const task = await readJson<CacheTask>(taskFile(root, id));
    if (!task) throw new Error('缓存任务已不存在');
    change(task); task.updatedAt = Date.now();
    await atomicJson(taskFile(root, id), task);
    return task;
  }, signal);
}

async function requireSpace(config: SyncConfig, bytes: number): Promise<void> {
  const space = await fs.statfs(config.libraryDirectory);
  if (space.bavail * space.bsize < bytes + 64 * 1024 * 1024) throw new Error('本机磁盘剩余空间不足，请清理后重试');
}

export async function processCacheTask(config: SyncConfig, id: string, signal?: AbortSignal): Promise<void> {
  const root = await syncRoot(config);
  let task = await readJson<CacheTask>(taskFile(root, id));
  if (!task) throw new Error('缓存任务已不存在');
  task = await changeTask(root, id, (entry) => { entry.status = 'downloading'; delete entry.error; }, signal);
  // uploadId is durable before createUpload. A crash on either side of the
  // library commit resumes the same ID, so it cannot publish a duplicate film.
  const upload = await createUpload({ metadata: task.item, format: task.item.format }, task.uploadId);
  let offset = upload.offset;
  let progressCheckedAt = Date.now();
  if (offset > task.item.bytes) throw new Error('云端文件大小发生变化，请重新提交缓存任务');
  await requireSpace(config, task.item.bytes - offset);
  while (offset < task.item.bytes) {
    signal?.throwIfAborted();
    const end = Math.min(offset + CHUNK, task.item.bytes) - 1;
    const response = await remoteRequest(config, `/api/library/${task.itemId}/media`, { headers: { Range: `bytes=${offset}-${end}` } }, signal);
    if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${end}/${task.item.bytes}`) {
      await response.body?.cancel(); throw new Error('云端未返回正确的续传片段，请检查服务器版本');
    }
    const bytes = await boundedBytes(response, end - offset + 1);
    if (bytes.byteLength !== end - offset + 1) throw new Error('云端返回的视频片段不完整，请重试');
    signal?.throwIfAborted();
    const result = await appendUpload(task.uploadId, offset, new Request('http://sync-worker.invalid/', { method: 'PUT', body: new Uint8Array(bytes) }));
    offset = result.offset;
    await changeTask(root, id, (entry) => { entry.progress = Math.min(99, Math.round(offset / task!.item.bytes * 100)); }, signal);
    if (Date.now() - progressCheckedAt >= 15_000) {
      const latest = await refreshCatalog(config, signal);
      if (latest.online) {
        try { await synchronizeProgress(config, latest.items, signal); }
        catch { signal?.throwIfAborted(); /* A different film's conflict cannot cancel this cache. */ }
      }
      progressCheckedAt = Date.now();
    }
  }
  signal?.throwIfAborted();
  const completed = await completeUpload(task.uploadId);
  if (completed.item.bytes !== task.item.bytes) throw new Error('缓存视频大小校验失败，请重试');
  const local = await getLibraryEntry(completed.item.id);
  // Poster failure never invalidates a complete local movie. Its generated
  // fallback is already available without the network.
  try {
    const poster = await syncPoster(task.itemId, signal);
    await saveLibraryPoster(local.id, await boundedBytes(poster, 5 * 1024 * 1024));
  } catch { signal?.throwIfAborted(); }
  await withLock(root, `mapping-${task.itemId}`, async () => {
    if (await readJson<Mapping>(mappingFile(root, task!.itemId))) return;
    let currentLocal = await getLibraryEntry(local.id);
    if (progressVersion(currentLocal) === null && task!.item.position !== undefined) {
      currentLocal = (await updateProgress(local.id, { position: task!.item.position, ...(task!.item.duration !== undefined ? { duration: task!.item.duration } : {}), expectedLastPlayedAt: null })).item;
    }
    const mapping: Mapping = {
      version: 1, remoteOrigin: config.origin, remoteId: task!.itemId, localId: local.id,
      localVersion: progressVersion(currentLocal), serverVersion: progressVersion(task!.item),
    };
    await atomicJson(mappingFile(root, task!.itemId), mapping);
  }, signal);
  await changeTask(root, id, (entry) => { entry.status = 'completed'; entry.progress = 100; delete entry.error; }, signal);
}

/** One testable iteration; errors and offline state leave local playback intact. */
export async function syncTick(config: SyncConfig, signal?: AbortSignal): Promise<void> {
  const root = await syncRoot(config);
  const catalog = await refreshCatalog(config, signal);
  if (!catalog.online) return;
  try { await synchronizeProgress(config, catalog.items, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if ((error as { status?: number }).status !== 409) {
      await atomicJson(path.join(root, 'catalog.json'), { ...catalog, online: false, error: '观看进度同步暂时中断；本机已保存的视频仍可播放' });
      return;
    }
    // Compare fresh versions again on the next tick; a concurrent viewer won.
  }
  const task = (await allTasks(root)).find((entry) => ['queued', 'downloading'].includes(entry.status));
  if (!task) return;
  try { await processCacheTask(config, task.id, signal); }
  catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : '';
    const timeout = (error as { name?: string } | null)?.name === 'TimeoutError' || /timed?\s*out|timeout/i.test(reason);
    const safe = timeout ? '连接服务器超时，请检查网络后重试'
      : /https?:\/\/|\/Users\/|\/home\//i.test(reason) ? '云端连接中断，请恢复网络后重试' : reason.slice(0, 180) || '缓存暂时失败，请稍后重试';
    await changeTask(root, task.id, (entry) => { entry.status = 'error'; entry.error = safe; });
  }
}

export async function runSyncWorker(): Promise<void> {
  const config = syncConfig();
  if (!config) throw new Error('云端影视库尚未配置');
  const root = await syncRoot(config);
  const stopping = new AbortController();
  const stop = () => stopping.abort(new Error('同步服务正在重启'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // The supervisor normally starts one daemon. This PID-backed lock also
  // prevents an accidentally launched second daemon from copying the same job.
  try {
    await withLock(root, 'worker', async () => {
      console.log('LibreTV 云端影视库同步服务已启动');
      while (!stopping.signal.aborted) {
        try { await syncTick(config, stopping.signal); }
        catch { if (stopping.signal.aborted) break; /* Retry without taking the local web server down. */ }
        if (!stopping.signal.aborted) {
          await new Promise<void>((resolve) => {
            const finish = () => { clearTimeout(timer); stopping.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, 10_000);
            stopping.signal.addEventListener('abort', finish, { once: true });
          });
        }
      }
    }, stopping.signal);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
