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
  supportsChunkCache,
  type DownloadProgress,
} from '@/lib/m3u8-downloader';
import { loadDownloadSettings, saveDownloadSettings } from '@/lib/download-settings';
import { detectSavingCapability, pickSaveTarget, type SaveTarget } from '@/lib/download-saver';
import { cleanupInterruptedLibraryUploads, createLibrarySaveTarget, fetchLibrary, guessLibraryMetadata } from '@/lib/local-library/client';
import type { LibraryMetadata } from '@/lib/local-library/types';
import Link from 'next/link';
import { Switch } from './settings-shared';

/**
 * 全局下载管理器（UI 采用本站 Drawer 模式）：
 * - 入口：header 下载图标 + 播放页「下载本集」（均派发 window 事件）；
 * - 并发：全局最多同时进行 3 个任务，其余排队（waiting）；
 * - 断点：已下载分片写入 Cache Storage（网络层断点）；
 *   刷新后可用已缓存分片继续；本机库重新建立写入目标，浏览器文件重新选择保存位置。
 */

const MAX_CONCURRENT_DOWNLOADS = 3;
/** 进度落库节流间隔：整集动辄上千分片，逐片「写库 + 全量查询 + setState」会把长任务页面拖垮 */
const PROGRESS_PERSIST_INTERVAL_MS = 1000;
const ADD_TASK_EVENT = 'libretv:add-download';
const SHOW_MANAGER_EVENT = 'libretv:show-download-manager';
export const DOWNLOADS_UPDATED_EVENT = 'libretv:downloads-updated';

export interface AddDownloadPayload {
  url: string;
  title: string;
  format?: 'TS' | 'MP4';
  libraryMetadata?: LibraryMetadata;
}

/** 运行中的任务句柄（不进持久化） */
interface RunningHandle {
  abort: AbortController;
  pause: PauseResumeController;
}

export function DownloadManager({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<DownloadTaskEntry[]>([]);
  const [capability, setCapability] = useState<'fs-access' | 'memory'>('memory');
  const [chunkCache, setChunkCache] = useState(true);
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
      await Promise.all(entries.filter((entry) => entry.status === 'downloading' && !running.current.has(entry.id))
        .map((entry) => db.downloads.update(entry.id, { status: 'paused', updatedAt: Date.now() })));
      refresh();
    });
    void checkLibrary().catch(() => setLibraryEnabled(undefined));
  }, [checkLibrary, refresh]);

  const startTask = useCallback(async (entry: DownloadTaskEntry) => {
    if (cancelled.current.has(entry.id) || running.current.has(entry.id) || running.current.size >= MAX_CONCURRENT_DOWNLOADS) return;
    const handle: RunningHandle = { abort: new AbortController(), pause: new PauseResumeController() };
    running.current.set(entry.id, handle);
    let target = targets.current.get(entry.id);
    let completed = false;
    const stopWriting = () => { void target?.abort().catch(() => {}); };
    handle.abort.signal.addEventListener('abort', stopWriting, { once: true });
    try {
      await updateEntry(entry.id, { status: 'downloading' });
      if (!target) {
        const useLibrary = entry.saveDestination === 'library'
          || (entry.saveDestination === undefined && await checkLibrary());
        if (!useLibrary) throw new Error('请点击「继续」选择保存位置');
        target = await createLibrarySaveTarget(entry.libraryMetadata ?? guessLibraryMetadata(entry.title), entry.format);
        targets.current.set(entry.id, target);
        await db.downloads.update(entry.id, { saveDestination: 'library' });
      }
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
        onProgress,
        target,
      });
      if (handle.abort.signal.aborted) return;
      // The job awaits target.close(), which confirms the server has committed the complete video.
      completed = true;
      await updateEntry(entry.id, { status: 'completed' });
      void clearDownloadChunks(entry.id);
      toast(`《${entry.title}》${entry.saveDestination === 'library' ? '已加入本地影视库' : '下载完成'}`, 'success');
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
          if (!handle.abort.signal.aborted) toast('未能清理本地影视库临时文件，请确认本地服务正在运行', 'error');
        }
      }
      handle.pause.destroy();
      handle.abort.signal.removeEventListener('abort', stopWriting);
      targets.current.delete(entry.id);
      running.current.delete(entry.id);
      scheduleNextRef.current();
    }
  }, [checkLibrary, proxy, toast, updateEntry]);

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
          if (entry.status === 'waiting' && !running.current.has(entry.id)) void startTask(entry);
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
          if (!useLibrary) {
            target = await pickSaveTarget(`${detail.title}.${format.toLowerCase()}`);
            targets.current.set(id, target);
          }
          const entry: DownloadTaskEntry = {
            id, url: detail.url, title: detail.title, format,
            libraryMetadata: detail.libraryMetadata ?? guessLibraryMetadata(detail.title),
            saveDestination: useLibrary ? 'library' : 'file',
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
  }, [checkLibrary, refresh, toast]);

  useEffect(() => {
    if (!isOpen) return;
    setCapability(detectSavingCapability());
    setChunkCache(supportsChunkCache());
    setProxy(loadDownloadSettings().proxy);
    refresh();
    void checkLibrary().then(scheduleNext).catch(() => setLibraryEnabled(undefined));
  }, [isOpen, refresh, scheduleNext, checkLibrary]);

  const onToggleProxy = (next: boolean) => {
    setProxy(saveDownloadSettings({ proxy: next }).proxy);
    toast(next ? '已开启下载中转，新任务经服务器转发' : '已关闭下载中转，新任务直连源站', 'info');
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

  return (
    <Drawer open={isOpen} onClose={onClose} title="下载管理" width="max-w-lg">
      <div className="space-y-3">
        <div className="card p-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-content">经服务器中转下载</p>
            <p className="text-xs text-faint">
              直连被跨域 / 防盗链 / 混合内容拦下时开启：整集流量（含分片与密钥）经服务器转发，
              带宽由部署者承担。仅对之后开始的任务生效。
            </p>
          </div>
          <Switch checked={proxy} onChange={onToggleProxy} label="经服务器中转下载" />
        </div>
        {libraryEnabled && (
          <p className="text-xs text-muted">
            下载完成后自动加入本地影视库 · <Link href="/library" className="text-accent hover:underline" onClick={onClose}>打开影视库</Link>
          </p>
        )}
        <p className="text-xs text-faint">
          保存能力：{libraryEnabled ? '本机影视库存储' : capability === 'fs-access' ? '磁盘直写（边下边存）' : '内存聚合（完成后浏览器下载）'}
          {chunkCache ? ' · 支持断点续传' : ' · 当前环境无断点缓存（需 HTTPS 访问）'} ·
          同时进行 {Math.min(running.current.size, MAX_CONCURRENT_DOWNLOADS)}/{MAX_CONCURRENT_DOWNLOADS} 个任务
        </p>
        {tasks.length === 0 && (
          <div className="py-10 text-center text-sm text-faint">
            暂无下载任务。在播放页点击「下载本集」开始。
          </div>
        )}
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

