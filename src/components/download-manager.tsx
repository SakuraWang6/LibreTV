'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { useToast } from './toast';
import { db, type DownloadTaskEntry } from '@/lib/db';
import {
  PauseResumeController,
  clearDownloadChunks,
  runDownloadJob,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import { pickSaveTarget, type SaveTarget } from '@/lib/download-saver';
import { cleanupInterruptedLibraryUploads, fetchLibrary, guessLibraryMetadata } from '@/lib/local-library/client';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryMetadata } from '@/lib/local-library/types';
import { changeBackgroundDownload, createBackgroundDownload, fetchBackgroundDownloads, removeBackgroundDownload } from '@/lib/background-downloads-client';
import type { BackgroundDownloadStatus, BackgroundDownloadTask } from '@/lib/background-downloads/types';
import Link from 'next/link';
import { Switch } from './settings-shared';
import type { MediaContext } from '@/lib/media-context';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 启用影视库：持久化到服务端队列，浏览器只提交、轮询和管理；
 * - 未启用影视库：保留浏览器下载，最多并发 3 个，可缓存分片后继续。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
/** 进度落库节流间隔：整集动辄上千分片，逐片「写库 + 全量查询 + setState」会把长任务页面拖垮 */
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

function formatDownloadBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(Math.max(0, bytes) / 1024 ** 2).toFixed(1)} MB`;
}

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
  libraryMetadata?: LibraryMetadata;
  mediaContext?: MediaContext;
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [proxy, setProxy] = useState(false);
  // A separate target per task prevents queued downloads from overwriting each other's file handle.
  const targets = useRef(new Map<string, SaveTarget>());
  // Reserve this map entry before any async target creation; preparation counts toward the limit.
  const running = useRef(new Map<string, RunningHandle>());
  const cancelled = useRef(new Set<string>());
  const scheduling = useRef(false);
  const scheduleRequested = useRef(false);
  const scheduleNextRef = useRef<() => void>(() => {});
  const [libraryEnabled, setLibraryEnabled] = useState<boolean | undefined>();
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundDownloadTask[]>([]);
  const [workerOnline, setWorkerOnline] = useState<boolean | undefined>();
  const [backgroundError, setBackgroundError] = useState('');
  const [busyTasks, setBusyTasks] = useState<Set<string>>(new Set());
  const observedBackground = useRef(new Map<string, BackgroundDownloadStatus>());
  const pollingBackground = useRef(false);

  const refreshBackground = useCallback(async () => {
    if (pollingBackground.current) return;
    pollingBackground.current = true;
    try {
      const result = await fetchBackgroundDownloads();
      if (!result.enabled) {
        setBackgroundError('当前部署未启用后台下载，请检查后台服务配置');
        return;
      }
      for (const task of result.tasks) {
        const previous = observedBackground.current.get(task.id);
        if (task.status === 'completed' && previous && previous !== 'completed') {
          window.dispatchEvent(new CustomEvent(LOCAL_LIBRARY_UPDATED_EVENT));
          toast(`《${task.title}》已加入影视库`, 'success');
        }
        observedBackground.current.set(task.id, task.status);
      }
      setBackgroundTasks(result.tasks);
      setWorkerOnline(result.workerOnline);
      setBackgroundError('');
    } catch (error) {
      setBackgroundError(error instanceof Error ? error.message : '无法读取后台下载任务');
    } finally {
      pollingBackground.current = false;
    }
  }, [toast]);

  const refresh = useCallback(() => {
    void db.downloads.orderBy('createdAt').reverse().toArray().then(setTasks);
  }, []);

  const updateEntry = useCallback(async (id: string, patch: Partial<DownloadTaskEntry>) => {
    await db.downloads.update(id, { ...patch, updatedAt: Date.now() });
    refresh();
  }, [refresh]);

  const checkLibrary = useCallback(async () => {
    const library = await fetchLibrary();
    setLibraryEnabled(library.enabled);
    return library.enabled;
  }, []);

  useEffect(() => {
    setProxy(loadDownloadSettings().proxy);
    // A browser reload loses live pause and file handles. Keep the cached segments for an explicit resume.
    void db.downloads.toArray().then(async (entries) => {
      await Promise.all(entries.filter((entry) => (entry.status === 'downloading' || entry.status === 'waiting') && !running.current.has(entry.id) && !targets.current.has(entry.id))
        .map((entry) => db.downloads.update(entry.id, { status: 'paused', updatedAt: Date.now() })));
      refresh();
    });
    void checkLibrary().catch(() => setLibraryEnabled(undefined));
  }, [checkLibrary, refresh]);

  useEffect(() => {
    if (!libraryEnabled) return;
    void refreshBackground();
    // The worker runs independently. Polling is only for reflecting its persisted state in this window.
    const timer = setInterval(() => { void refreshBackground(); }, 3_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshBackground(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [libraryEnabled, refreshBackground]);

  const startTask = useCallback(async (entry: DownloadTaskEntry) => {
    if (cancelled.current.has(entry.id) || running.current.has(entry.id) || running.current.size >= MAX_CONCURRENT_DOWNLOADS) return;
    const handle: RunningHandle = { abort: new AbortController(), pause: new PauseResumeController() };
    running.current.set(entry.id, handle);
    const target = targets.current.get(entry.id);
    let completed = false;
    const stopWriting = () => { void target?.abort().catch(() => {}); };
    handle.abort.signal.addEventListener('abort', stopWriting, { once: true });
    try {
      await updateEntry(entry.id, { status: 'downloading' });
      if (!target || entry.saveDestination === 'library') throw new Error('请点击「继续」重新建立下载任务');
      if (handle.abort.signal.aborted) return;
      let lastPersistAt = 0;
      const onProgress = (progress: DownloadProgress) => {
        if (handle.abort.signal.aborted) return;
        // An in-flight segment can finish after pausing. Do not let its progress unpause the UI.
        const status = handle.pause.getPaused() ? 'paused' as const : 'downloading' as const;
        setTasks((previous) => previous.map((task) => task.id === entry.id
          ? { ...task, finished: progress.current, total: progress.total, status } : task));
        const now = Date.now();
        if (progress.status === 'downloading' && now - lastPersistAt < PROGRESS_PERSIST_INTERVAL_MS) return;
        lastPersistAt = now;
        void db.downloads.update(entry.id, { finished: progress.current, total: progress.total, status, updatedAt: now });
      };
      await runDownloadJob({
        taskId: entry.id,
        url: entry.url,
        title: entry.title,
        format: entry.format,
        signal: handle.abort.signal,
        pause: handle.pause,
        proxy,
        mediaContext: entry.mediaContext,
        onProgress,
        target,
      });
      if (handle.abort.signal.aborted) return;
      // Library downloads never reach this browser worker.
      completed = true;
      await updateEntry(entry.id, { status: 'completed' });
      void clearDownloadChunks(entry.id);
      toast(`《${entry.title}》下载完成`, 'success');
    } catch (error) {
      if (!handle.abort.signal.aborted) {
        await updateEntry(entry.id, { status: 'error' });
        toast(`《${entry.title}》下载失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
      }
    } finally {
      if (target && !completed) {
        try {
          await target.abort();
        } catch {
          if (!handle.abort.signal.aborted) toast('未能清理下载临时文件，请重新打开下载管理后重试', 'error');
        }
      }
      handle.pause.destroy();
      handle.abort.signal.removeEventListener('abort', stopWriting);
      targets.current.delete(entry.id);
      running.current.delete(entry.id);
      scheduleNextRef.current();
    }
  }, [proxy, toast, updateEntry]);

  const scheduleNext = useCallback(() => {
    if (scheduling.current) {
      scheduleRequested.current = true;
      return;
    }
    scheduling.current = true;
    void (async () => {
      try {
        const all = await db.downloads.orderBy('createdAt').toArray();
        for (const entry of all) {
          if (running.current.size >= MAX_CONCURRENT_DOWNLOADS) break;
          if (entry.status === 'waiting' && entry.saveDestination !== 'library' && targets.current.has(entry.id) && !running.current.has(entry.id)) void startTask(entry);
        }
      } finally {
        scheduling.current = false;
        if (scheduleRequested.current) {
          scheduleRequested.current = false;
          scheduleNextRef.current();
        }
      }
    })();
  }, [startTask]);
  useEffect(() => { scheduleNextRef.current = scheduleNext; }, [scheduleNext]);

  useEffect(() => {
    const onAdd = (event: Event) => {
      const detail = (event as CustomEvent<AddDownloadPayload>).detail;
      if (!detail?.url || !detail?.title) return;
      void (async () => {
        const format = detail.format ?? 'MP4';
        const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let target: SaveTarget | undefined;
        try {
          // Query at the click as well: a mount-time 401 before login must never disable the library permanently.
          const useLibrary = await checkLibrary();
          if (useLibrary) {
            await createBackgroundDownload(detail.url, detail.libraryMetadata ?? guessLibraryMetadata(detail.title), undefined, detail.mediaContext);
            await refreshBackground();
            toast(`《${detail.title}》已加入下载队列`, 'success');
            return;
          }
          target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
          targets.current.set(id, target);
          const entry: DownloadTaskEntry = {
            id, url: detail.url, mediaContext: detail.mediaContext, title: detail.title, format,
            libraryMetadata: detail.libraryMetadata ?? guessLibraryMetadata(detail.title),
            saveDestination: 'file',
            status: 'waiting', finished: 0, total: 0, errorNum: 0,
            createdAt: Date.now(), updatedAt: Date.now(),
          };
          await db.downloads.put(entry);
          refresh();
          scheduleNextRef.current();
          toast(`《${detail.title}》已加入下载队列`, 'success');
        } catch (error) {
          targets.current.delete(id);
          await target?.abort().catch(() => {});
          const message = error instanceof Error ? error.message : '无法创建下载任务';
          toast(message, message.includes('取消') ? 'info' : 'error');
        }
      })();
    };
    window.addEventListener(ADD_TASK_EVENT, onAdd);
    return () => window.removeEventListener(ADD_TASK_EVENT, onAdd);
  }, [checkLibrary, refresh, refreshBackground, toast]);

  useEffect(() => {
    if (!isOpen) return;
    setProxy(loadDownloadSettings().proxy);
    refresh();
    if (libraryEnabled) void refreshBackground();
    void checkLibrary().then(scheduleNext).catch(() => setLibraryEnabled(undefined));
  }, [isOpen, refresh, scheduleNext, checkLibrary, libraryEnabled, refreshBackground]);

  const onToggleProxy = (next: boolean) => {
    setProxy(saveDownloadSettings({ proxy: next }).proxy);
    toast(next ? '已开启下载中转' : '已关闭下载中转', 'info');
  };

  const onPauseResume = async (entry: DownloadTaskEntry) => {
    const handle = running.current.get(entry.id);
    if (handle) {
      if (handle.pause.getPaused()) {
        handle.pause.resume();
        await updateEntry(entry.id, { status: 'downloading' });
      } else {
        handle.pause.pause();
        await updateEntry(entry.id, { status: 'paused' });
      }
      return;
    }
    if (entry.status === 'completed') return;
    try {
      const useLibrary = entry.saveDestination === 'library'
        || (entry.saveDestination === undefined && await checkLibrary());
      if (useLibrary) {
        // Transfer legacy browser work only after the durable server creation has been acknowledged.
        await createBackgroundDownload(entry.url, entry.libraryMetadata ?? guessLibraryMetadata(entry.title), `browser:${entry.id}`, entry.mediaContext);
        await clearDownloadChunks(entry.id);
        await db.downloads.delete(entry.id);
        refresh();
        await refreshBackground();
        toast(`《${entry.title}》已转为后台下载`, 'success');
        return;
      }
      if (!useLibrary && !targets.current.has(entry.id)) {
        targets.current.set(entry.id, await pickSaveTarget(`${entry.title}.${entry.format.toLowerCase()}`));
      }
      await updateEntry(entry.id, { status: 'waiting', saveDestination: useLibrary ? 'library' : 'file' });
      scheduleNextRef.current();
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法继续下载';
      toast(message, message.includes('取消') ? 'info' : 'error');
    }
  };

  const onCancel = async (entry: DownloadTaskEntry) => {
    // A scheduler may already hold a snapshot of a queued row while its IndexedDB deletion awaits.
    cancelled.current.add(entry.id);
    const handle = running.current.get(entry.id);
    handle?.abort.abort();
    handle?.pause.destroy();
    // Keep the running reservation until its finally block completes, including upload cleanup.
    const target = targets.current.get(entry.id);
    if (!handle && target) {
      await target.abort().catch(() => {});
      targets.current.delete(entry.id);
    }
    await clearDownloadChunks(entry.id);
    await db.downloads.delete(entry.id);
    refresh();
    toast(entry.status === 'completed' || entry.status === 'error'
      ? `《${entry.title}》已删除下载记录`
      : `《${entry.title}》已取消下载`, 'info');
  };

  const statusLabel: Record<DownloadTaskEntry['status'], string> = {
    waiting: '排队中',
    downloading: '下载中',
    paused: '已暂停',
    completed: '已完成',
    error: '失败',
  };

  const backgroundStatusLabel: Record<BackgroundDownloadStatus, string> = {
    queued: '排队中', downloading: '后台下载中', processing: '整理视频并入库',
    completed: '已入库', failed: '失败', cancelled: '已取消', paused: '已暂停',
  };

  const onBackgroundAction = async (task: BackgroundDownloadTask, action: 'cancel' | 'retry' | 'pause' | 'resume' | 'remove') => {
    if (busyTasks.has(task.id)) return;
    setBusyTasks((previous) => new Set(previous).add(task.id));
    try {
      if (action === 'remove') {
        await removeBackgroundDownload(task.id);
        setBackgroundTasks((previous) => previous.filter((entry) => entry.id !== task.id));
        toast('下载记录已移除', 'info');
      } else {
        const changed = await changeBackgroundDownload(task.id, action);
        toast(changed.status === 'completed' ? '视频已加入影视库'
          : action === 'pause' ? '后台下载已暂停'
            : action === 'resume' ? '已继续后台下载'
              : action === 'retry' ? '已重新加入后台下载队列' : '已请求取消后台下载', 'info');
      }
      await refreshBackground();
    } catch (error) {
      toast(error instanceof Error ? error.message : '后台下载操作失败', 'error');
    } finally {
      setBusyTasks((previous) => { const next = new Set(previous); next.delete(task.id); return next; });
    }
  };

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载" width="max-w-lg">
      <div className="mac-download-manager space-y-3">
        {!libraryEnabled && <div className="card p-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-content">经服务器中转下载</p>
          </div>
          <Switch checked={proxy} onChange={onToggleProxy} label="经服务器中转下载" />
        </div>}
        {libraryEnabled && (
          <div className="card p-3 space-y-1">
            <div className="flex items-center justify-between"><span className="text-xs text-muted">后台任务</span><Link href="/library" className="text-xs text-accent hover:underline" onClick={onClose}>影视库</Link></div>
          </div>
        )}
        {libraryEnabled && backgroundError && <p className="text-xs text-danger" role="status">{backgroundError}</p>}
        {libraryEnabled && workerOnline === false && !backgroundError && <p className="text-xs text-warning" role="status">后台服务未连接</p>}
        {!libraryEnabled && <p className="text-xs text-faint">
          浏览器下载 · {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS} 进行中
          <span className="block mt-1">请勿关闭下载页面</span>
        </p>}
        {tasks.length === 0 && backgroundTasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载
          </div>
        )}
        {backgroundTasks.map((task) => {
          const active = ['queued', 'downloading', 'processing'].includes(task.status);
          const progress = task.total > 0 ? Math.min(100, Math.round(task.finished / task.total * 100)) : 0;
          const episode = task.metadata.kind === 'tv' ? task.metadata.episodeTitle || (task.metadata.episodeNumber ? `第 ${task.metadata.episodeNumber} 集` : '') : '';
          const quarkTask = 'provider' in task && task.provider === 'quark';
          return (
            <div key={task.id} className="card p-3 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-content truncate">{task.title}{episode ? ` · ${episode}` : ''}</p>
                  <p className="text-xs text-faint">{quarkTask ? '夸克' : 'MP4'} · {backgroundStatusLabel[task.status]}{(task.status === 'downloading' || task.status === 'paused') && task.total > 0 ? ` · ${progress}%` : ''}{quarkTask && task.total > 0 ? ` · ${formatDownloadBytes(task.finished)} / ${formatDownloadBytes(task.total)}` : task.bytes > 0 ? ` · ${formatDownloadBytes(task.bytes)}` : ''}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {task.status === 'completed' && task.libraryItemId && <Link href={`/library/play/${encodeURIComponent(task.libraryItemId)}`} onClick={onClose} className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content">播放</Link>}
                  {(task.status === 'failed' || task.status === 'cancelled') && <button type="button" disabled={busyTasks.has(task.id)} onClick={() => void onBackgroundAction(task, 'retry')} className="px-2 py-1 rounded bg-chip hover:bg-hover disabled:opacity-50 text-xs text-content">重试</button>}
                  {active && <button type="button" disabled={busyTasks.has(task.id)} onClick={() => void onBackgroundAction(task, 'pause')} className="px-2 py-1 rounded bg-chip hover:bg-hover disabled:opacity-50 text-xs text-content">暂停</button>}
                  {task.status === 'paused' && <button type="button" disabled={busyTasks.has(task.id)} onClick={() => void onBackgroundAction(task, 'resume')} className="px-2 py-1 rounded bg-chip hover:bg-hover disabled:opacity-50 text-xs text-content">继续</button>}
                  {active || task.status === 'paused' ? <button type="button" disabled={busyTasks.has(task.id)} onClick={() => void onBackgroundAction(task, 'cancel')} className="px-2 py-1 rounded bg-chip hover:bg-hover disabled:opacity-50 text-xs text-content">取消</button>
                    : <button type="button" aria-label="移除下载记录" disabled={busyTasks.has(task.id)} onClick={() => void onBackgroundAction(task, 'remove')} className="p-1.5 rounded bg-chip hover:bg-hover disabled:opacity-50 text-content"><Icon name="close" className="w-4 h-4" /></button>}
                </div>
              </div>
              {task.error && task.status === 'failed' && <p className="text-xs text-danger break-words">{task.error}</p>}
              {task.total > 0 && task.status !== 'cancelled' && <div className="h-1.5 rounded-full bg-chip overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${task.status === 'completed' ? 100 : progress}%` }} /></div>}
            </div>
          );
        })}
        {libraryEnabled && tasks.length > 0 && <p className="text-xs text-faint">浏览器任务</p>}
        {tasks.map((t) => (
          <div key={t.id} className="card p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-content truncate">{t.title}</p>
                <p className="text-xs text-faint">
                  {t.format.toUpperCase()} · {statusLabel[t.status]}
                  {t.status === 'downloading' && t.total > 0 ? ` · ${t.finished}/${t.total} 分片` : ''}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {t.status === 'completed' && t.saveDestination === 'library' && (
                  <Link href="/library" onClick={onClose} className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content">查看影视库</Link>
                )}
                {t.status === 'downloading' && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    暂停
                  </button>
                )}
                {(t.status === 'paused' || t.status === 'waiting' || t.status === 'error') && (
                  <button
                    type="button"
                    className="px-2 py-1 rounded bg-chip hover:bg-hover text-xs text-content transition-colors"
                    onClick={() => void onPauseResume(t)}
                  >
                    继续
                  </button>
                )}
                <button
                  type="button"
                  aria-label="删除下载任务"
                  className="p-1.5 rounded bg-chip hover:bg-hover text-content transition-colors"
                  onClick={() => void onCancel(t)}
                >
                  <Icon name="close" className="w-4 h-4" />
                </button>
              </div>
            </div>
            {(t.status === 'downloading' || t.status === 'paused' || t.status === 'completed') && t.total > 0 && (
              <div className="h-1.5 rounded-full bg-chip overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${t.total > 0 ? Math.min(100, Math.round((t.finished / t.total) * 100)) : 0}%` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  );
}

/** 播放页等处调用：把一集加入下载队列（必须在用户手势内调用） */
export function enqueueDownload(payload: AddDownloadPayload): void {
  window.dispatchEvent(new CustomEvent(ADD_TASK_EVENT, { detail: payload }));
}

/** header 等处调用：打开下载管理器 */
export function requestShowDownloadManager(): void {
  window.dispatchEvent(new CustomEvent(SHOW_MANAGER_EVENT));
}

/** 全局挂载点：根布局渲染一次，监听打开事件 */
export function GlobalDownloadManager() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onShow = () => setOpen(true);
    void cleanupInterruptedLibraryUploads();
    // Mount can precede login. Retry persisted staging cleanup after authentication without losing its IDs.
    const cleanupTimer = setInterval(() => { void cleanupInterruptedLibraryUploads(); }, 60_000);
    window.addEventListener(SHOW_MANAGER_EVENT, onShow);
    return () => {
      clearInterval(cleanupTimer);
      window.removeEventListener(SHOW_MANAGER_EVENT, onShow);
    };
  }, []);
  return <DownloadManager isOpen={open} onClose={() => setOpen(false)} />;
}

