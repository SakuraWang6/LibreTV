import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { createUpload, appendUpload, completeUpload, cancelUpload, getLibraryEntry } from '@/lib/local-library/server';
import { createMediaPlan, downloadResource, remuxLocal, maxJobBytes, requireFreeSpace, type MediaPlan } from './media';
import { allStoredTasks, atomicJson, downloadsRoot, mutateTask, readTask, type StoredTask } from './store';
import { downloadFailureMessage } from './error-message';

interface WorkTask extends StoredTask { uploadReady?: boolean }
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class DownloadPausedError extends Error {
  constructor() { super('后台下载已暂停'); }
}

function requireTaskActive(task: StoredTask): void {
  if (task.cancelRequested || task.status === 'cancelled') throw new Error('下载已取消');
  if (task.pauseRequested || task.status === 'paused') throw new DownloadPausedError();
}

async function workDirectory(id: string): Promise<string> {
  let directory = await downloadsRoot();
  for (const name of ['work', id]) {
    directory = path.join(directory, name);
    await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('后台下载暂存目录不安全');
  }
  return directory;
}

async function cleanupUpload(task: WorkTask): Promise<void> {
  if (!task.uploadId) return;
  await cancelUpload(task.uploadId).catch((error: { status?: number; code?: string }) => {
    if (error.status !== 409 && error.code !== 'ENOENT') throw error;
  });
  await mutateTask(task.id, (entry) => { delete entry.uploadId; delete (entry as WorkTask).uploadReady; });
}

async function cleanupCancelled(task: WorkTask): Promise<void> {
  const directory = path.join(await downloadsRoot(), 'work', task.id);
  await cleanupUpload(task);
  await fs.rm(directory, { recursive: true, force: true });
  await mutateTask(task.id, (entry) => {
    // A retry may already have moved the job back into the queue.
    if (entry.status !== 'cancelled' && !entry.cancelRequested) return;
    entry.status = 'cancelled'; entry.cancelRequested = false; entry.pauseRequested = false; entry.finished = 0; entry.bytes = 0; delete entry.error;
  });
}

async function loadPlan(directory: string, task: WorkTask, signal: AbortSignal): Promise<MediaPlan> {
  const file = path.join(directory, 'plan.json');
  try {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let plan: MediaPlan;
    try {
      if ((await handle.stat()).size > 16 * 1024 * 1024) throw new Error('下载计划过大');
      plan = JSON.parse(await handle.readFile('utf8')) as MediaPlan;
    } finally { await handle.close(); }
    if (plan.version !== 1 || !Array.isArray(plan.resources) || plan.resources.length > 30000
      || !/^(?:assembled|r\d{6})\.bin$/.test(plan.input)
      || plan.resources.some((resource) => !/^r\d{6}\.(?:key|bin)$/.test(resource.name))
      || plan.pieces?.some((piece) => !/^r\d{6}\.bin$/.test(piece.name) || (piece.keyName && !/^r\d{6}\.key$/.test(piece.keyName)) || (piece.iv && !/^[0-9a-f]{32}$/i.test(piece.iv)))) {
      throw new Error('下载计划不可用');
    }
    return plan;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const plan = await createMediaPlan(task.url, signal);
  await atomicJson(file, plan);
  return plan;
}

async function markCompleted(id: string, libraryItemId: string): Promise<void> {
  await mutateTask(id, (entry) => {
    entry.status = 'completed'; entry.finished = entry.total; entry.libraryItemId = libraryItemId;
    entry.cancelRequested = false; entry.pauseRequested = false; delete entry.error; delete entry.uploadId; delete (entry as WorkTask).uploadReady;
  });
  await fs.rm(path.join(await downloadsRoot(), 'work', id), { recursive: true, force: true });
}

async function commitUpload(id: string, uploadId: string, signal: AbortSignal): Promise<void> {
  // The same task lock serializes pause/cancel with the library commit. A pause
  // accepted before this point prevents publication; an already committed film
  // wins a later pause/cancel without deleting or publishing it twice.
  await mutateTask(id, async (entry) => {
    requireTaskActive(entry); signal.throwIfAborted();
    const completed = await completeUpload(uploadId);
    entry.status = 'completed'; entry.finished = entry.total; entry.libraryItemId = completed.item.id;
    entry.cancelRequested = false; entry.pauseRequested = false;
    delete entry.error; delete entry.uploadId; delete (entry as WorkTask).uploadReady;
  });
  await fs.rm(path.join(await downloadsRoot(), 'work', id), { recursive: true, force: true });
}

async function processActiveTask(id: string, signal: AbortSignal): Promise<void> {
  const requireActive = async () => {
    requireTaskActive(await readTask(id));
    signal.throwIfAborted();
  };
  const task = await readTask(id) as WorkTask;
  // If a crash happened after the library commit but before queue commit, reuse
  // that upload id. Merely having ready staging must not publish a paused task.
  if (task.uploadId) {
    try {
      const committed = await getLibraryEntry(task.uploadId);
      await markCompleted(id, committed.id);
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await requireActive();
  if (task.uploadId && task.uploadReady) { await commitUpload(id, task.uploadId, signal); return; }
  const directory = await workDirectory(id);
  let media = path.join(directory, 'result.mp4');
  // A paused library copy resumes its existing staging offset. Resources and
  // the already remuxed result also survive a worker restart.
  if (!task.uploadId) {
    await mutateTask(id, (entry) => { requireTaskActive(entry); entry.status = 'downloading'; delete entry.error; });
    const plan = await loadPlan(directory, task, signal);
    await mutateTask(id, (entry) => { requireTaskActive(entry); entry.total = plan.resources.length; entry.finished = 0; entry.bytes = 0; });
    let bytes = 0;
    for (let index = 0; index < plan.resources.length; index++) {
      await requireActive();
      bytes += await downloadResource(plan.resources[index], directory, signal, bytes);
      if (bytes > maxJobBytes()) throw new Error('该视频超过单个任务的空间限制');
      await mutateTask(id, (entry) => { entry.finished = index + 1; entry.bytes = bytes; });
    }
    await requireActive();
    await mutateTask(id, (entry) => { requireTaskActive(entry); entry.status = 'processing'; });
    media = await remuxLocal(plan, directory, signal);
  }
  await requireActive();
  const uploadId = task.uploadId ?? crypto.randomBytes(16).toString('hex');
  // Persist ownership before creating library staging, so even a power loss
  // between the two writes cannot orphan an untracked partial upload.
  await mutateTask(id, (entry) => { requireTaskActive(entry); entry.status = 'processing'; entry.uploadId = uploadId; });
  const upload = await createUpload({ metadata: task.metadata, format: 'MP4' }, uploadId);
  const input = await fs.open(media, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || upload.offset > stat.size) throw new Error('入库暂存大小与整理后的视频不一致');
    let offset = upload.offset;
    const buffer = Buffer.alloc(1024 * 1024);
    while (true) {
      await requireActive();
      const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      await requireFreeSpace(directory, bytesRead);
      const result = await appendUpload(upload.id, offset, new Request('http://worker.invalid/', { method: 'PUT', body: new Uint8Array(buffer.subarray(0, bytesRead)) }));
      offset = result.offset;
    }
  } finally { await input.close(); }
  await requireActive();
  await mutateTask(id, (entry) => {
    requireTaskActive(entry);
    (entry as WorkTask).uploadReady = true;
  });
  await commitUpload(id, upload.id, signal);
}

export async function processTask(id: string, signal: AbortSignal): Promise<void> {
  try { await processActiveTask(id, signal); }
  catch (error) {
    const latest = await readTask(id) as WorkTask;
    if (latest.status === 'completed') return;
    if (latest.cancelRequested || latest.status === 'cancelled') { await cleanupCancelled(latest); return; }
    if (latest.pauseRequested || latest.status === 'paused' || error instanceof DownloadPausedError || signal.reason instanceof DownloadPausedError) {
      const stopped = await mutateTask(id, (entry) => {
        if (entry.status === 'completed' || entry.cancelRequested || entry.status === 'cancelled') return;
        if (entry.pauseRequested || entry.status === 'paused') {
          entry.status = 'paused'; entry.pauseRequested = false;
        }
        // A quick resume may have queued the task before this request stopped.
        // Leave that queued state intact so the next pass uses fresh signals.
      });
      if (stopped.cancelRequested || stopped.status === 'cancelled') await cleanupCancelled(stopped);
      return;
    }
    throw error;
  }
}

async function claimWorker(root: string): Promise<() => Promise<void>> {
  const directory = path.join(root, 'worker.lock');
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('后台服务锁目录不可用');
    let alive = true;
    try {
      const pid = Number(await fs.readFile(path.join(directory, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid pid');
      const owner = JSON.parse(await fs.readFile(path.join(directory, 'owner.json'), 'utf8')) as { hostname: string };
      if (pid === process.pid || owner.hostname !== os.hostname()) {
        // Containers routinely restart with PID 1. A stale PID file must not
        // mistake the new container itself for the dead previous worker.
        const heartbeat = await fs.stat(path.join(root, 'worker-heartbeat')).catch(() => null);
        alive = !!heartbeat && Date.now() - heartbeat.mtimeMs < 30_000;
      } else {
        try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      }
    } catch { alive = Date.now() - stat.mtimeMs < 30_000; }
    if (alive) throw new Error('后台下载服务已经运行');
    await fs.rm(directory, { recursive: true, force: true });
    await fs.mkdir(directory, { mode: 0o700 });
  }
  await fs.writeFile(path.join(directory, 'pid'), String(process.pid), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ hostname: os.hostname(), pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return async () => { await fs.rm(directory, { recursive: true, force: true }); };
}

export async function runWorker(): Promise<void> {
  const root = await downloadsRoot();
  const release = await claimWorker(root);
  let stopping = false;
  let active: AbortController | undefined;
  const stop = () => { stopping = true; active?.abort(new Error('后台服务正在重启，任务稍后自动继续')); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const heartbeatFile = path.join(root, 'worker-heartbeat');
  const heartbeat = () => fs.writeFile(heartbeatFile, String(Date.now()), { mode: 0o600 }).catch(() => undefined);
  await heartbeat();
  const timer = setInterval(() => { void heartbeat(); }, 5000);
  console.log('LibreTV 后台下载服务已启动（关闭浏览器窗口不会中断任务）');
  try {
    while (!stopping) {
      const tasks = await allStoredTasks();
      const cleanup = tasks.find((task) => task.status === 'cancelled' && task.cancelRequested);
      if (cleanup) { await cleanupCancelled(cleanup); continue; }
      const task = tasks.find((entry) => ['queued', 'downloading', 'processing'].includes(entry.status));
      if (!task) { await pause(1500); continue; }
      active = new AbortController();
      const current = active;
      const deadline = setTimeout(() => current.abort(new Error('下载超过 24 小时，请检查网络后重试')), 24 * 60 * 60_000);
      const cancellation = setInterval(() => {
        void readTask(task.id).then((entry) => {
          if (entry.cancelRequested || entry.status === 'cancelled') current.abort(new Error('下载已取消'));
          else if (entry.pauseRequested || entry.status === 'paused') current.abort(new DownloadPausedError());
        }).catch(() => current.abort(new Error('下载记录不可用')));
      }, 500);
      try { await processTask(task.id, current.signal); }
      catch (error) {
        if (stopping) break; // Keep resumable state; the next worker picks it up.
        const latest = await readTask(task.id) as WorkTask;
        if (latest.status === 'completed') continue;
        if (latest.cancelRequested || latest.status === 'cancelled') await cleanupCancelled(latest);
        else {
          const safeReason = downloadFailureMessage(error);
          const failed = await mutateTask(task.id, (entry) => {
            if (entry.status === 'completed') return;
            if (entry.cancelRequested || entry.status === 'cancelled') { entry.status = 'cancelled'; return; }
            // A pause may arrive after processTask inspected the failure but
            // before this queue update. Never discard its library staging.
            if (entry.pauseRequested || entry.status === 'paused') { entry.status = 'paused'; entry.pauseRequested = false; return; }
            entry.status = 'failed'; entry.error = safeReason; entry.cancelRequested = false;
          });
          if (failed.status === 'failed') await cleanupUpload(failed);
        }
      } finally { clearTimeout(deadline); clearInterval(cancellation); active = undefined; }
    }
  } finally {
    clearInterval(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await fs.rm(heartbeatFile, { force: true }); await release();
  }
}
