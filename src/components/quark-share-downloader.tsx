'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LibraryMetadata } from '@/lib/local-library/types';
import { createQuarkDownloads, fetchQuarkStatus, listQuarkShare, QUARK_STATUS_QUERY_KEY, type QuarkShareEntry, type QuarkShareListing } from '@/lib/quark-client';
import { Drawer } from './drawer';
import { Icon } from './icon';
import { Spinner } from './states';
import { QuarkConnection } from './quark-connection';
import { DOWNLOADS_UPDATED_EVENT } from './download-manager';
import { useToast } from './toast';

interface FolderLocation { id: string; name: string }

function fileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function QuarkShareDownloader({ url, metadata, label = '夸克下载' }: { url: string; metadata: LibraryMetadata; label?: string }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<QuarkShareListing | null>(null);
  const [folders, setFolders] = useState<FolderLocation[]>([]);
  const [selected, setSelected] = useState<Map<string, QuarkShareEntry>>(new Map());
  const [title, setTitle] = useState(metadata.title);
  const [kind, setKind] = useState(metadata.kind);
  const [season, setSeason] = useState(String(metadata.seasonNumber || 1));
  const [episode, setEpisode] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<AbortController | null>(null);
  const submitKeyRef = useRef('');
  const { toast } = useToast();
  const status = useQuery({ queryKey: QUARK_STATUS_QUERY_KEY, queryFn: fetchQuarkStatus, enabled: open, retry: false, staleTime: 10_000 });
  const connected = status.data?.enabled && status.data.connected;

  const loadFolder = async (nextFolders: FolderLocation[]) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError('');
    try {
      const result = await listQuarkShare(url, nextFolders.at(-1)?.id, controller.signal);
      if (controller.signal.aborted) return;
      setListing(result); setFolders(nextFolders);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '无法读取分享');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };

  useEffect(() => {
    if (!open || !connected) return;
    void loadFolder([]);
    return () => requestRef.current?.abort();
    // The share and connection identify the listing, not metadata changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connected, url]);

  const show = () => {
    setListing(null); setFolders([]); setSelected(new Map()); setError(''); setLoading(false);
    setTitle(metadata.title); setKind(metadata.kind); setSeason(String(metadata.seasonNumber || 1)); setEpisode('');
    submitKeyRef.current = crypto.randomUUID(); setOpen(true);
  };
  const close = () => { if (!submitting) { requestRef.current?.abort(); setOpen(false); } };
  const toggle = (entry: QuarkShareEntry) => {
    if (!entry.downloadable || entry.isDirectory) return;
    submitKeyRef.current = crypto.randomUUID();
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(entry.id)) next.delete(entry.id); else next.set(entry.id, entry);
      return next;
    });
  };
  const submit = async () => {
    if (submitting || !selected.size || !title.trim()) return;
    setSubmitting(true); setError('');
    try {
      const tasks = await createQuarkDownloads(url, [...selected.keys()], {
        ...metadata, title: title.trim(), kind,
        seasonNumber: kind === 'tv' ? Number(season) || 1 : undefined,
        // Batch episode numbers are inferred from each selected filename.
        episodeNumber: kind === 'tv' && selected.size === 1 && episode ? Number(episode) : undefined,
        episodeTitle: undefined,
      }, submitKeyRef.current);
      window.dispatchEvent(new CustomEvent(DOWNLOADS_UPDATED_EVENT));
      toast(`已加入 ${tasks.length} 个后台下载`, 'success');
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建下载失败'); }
    finally { setSubmitting(false); }
  };
  const videos = listing?.entries.filter((entry) => entry.downloadable && !entry.isDirectory) || [];
  const allSelected = videos.length > 0 && videos.every((entry) => selected.has(entry.id));

  return <>
    <button type="button" className="btn-ghost btn-sm" onClick={show}><Icon name="download" className="h-3.5 w-3.5" />{label}</button>
    <Drawer open={open} onClose={close} title="夸克下载" width="max-w-lg" closeOnOverlay={!submitting}
      footer={connected ? <div className="space-y-2">
        <p className="text-xs text-faint">所选视频将转存至夸克 LibreTV 文件夹，占用网盘空间。</p>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted">已选 {selected.size} 个视频</span>
          <button type="button" className="btn-primary" disabled={submitting || !selected.size || !title.trim() || loading} onClick={() => void submit()}>{submitting ? '正在加入…' : '转存并下载'}</button>
        </div>
      </div> : undefined}>
      {status.isPending ? <div className="flex justify-center py-8"><Spinner /></div>
        : status.isError ? <p role="alert" className="text-sm text-danger">{status.error.message}</p>
          : !status.data?.enabled ? <div className="space-y-3"><p className="text-sm text-muted">当前设备未启用夸克连接</p><a className="btn-ghost btn-sm" href={url} target="_blank" rel="noopener noreferrer">打开夸克分享</a></div>
            : !connected ? <QuarkConnection /> : <div className="space-y-4">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <label className="min-w-0 text-xs text-muted">影片名称<input value={title} disabled={submitting} onChange={(event) => { setTitle(event.target.value); submitKeyRef.current = crypto.randomUUID(); }} className="input mt-1 w-full" maxLength={200} /></label>
                <label className="text-xs text-muted">分类<select className="input mt-1 block" disabled={submitting} value={kind} onChange={(event) => { setKind(event.target.value as LibraryMetadata['kind']); submitKeyRef.current = crypto.randomUUID(); }}><option value="movie">电影</option><option value="tv">电视剧</option></select></label>
              </div>
              {kind === 'tv' && <div className="flex gap-3">
                <label className="text-xs text-muted">季数<input className="input mt-1 block w-24" type="number" disabled={submitting} min={1} max={999} value={season} onChange={(event) => { setSeason(event.target.value); submitKeyRef.current = crypto.randomUUID(); }} /></label>
                {selected.size === 1 && <label className="text-xs text-muted">集数<input className="input mt-1 block w-32" type="number" disabled={submitting} min={1} max={9999} placeholder="按文件名" value={episode} onChange={(event) => { setEpisode(event.target.value); submitKeyRef.current = crypto.randomUUID(); }} /></label>}
              </div>}
              <div className="overflow-hidden rounded-lg border border-line">
                <div className="flex min-h-10 items-center gap-2 border-b border-line bg-chip px-3 py-2">
                  {folders.length > 0 && <button type="button" className="btn-ghost btn-sm shrink-0" disabled={loading || submitting} onClick={() => void loadFolder(folders.slice(0, -1))}>返回</button>}
                  <span className="min-w-0 flex-1 truncate text-xs text-content">{folders.at(-1)?.name || listing?.shareTitle || '分享文件'}</span>
                  {videos.length > 0 && <button type="button" className="text-xs text-accent shrink-0 disabled:opacity-40" disabled={loading || submitting} onClick={() => {
                    submitKeyRef.current = crypto.randomUUID();
                    setSelected((previous) => { const next = new Map(previous); videos.forEach((entry) => { if (allSelected) next.delete(entry.id); else next.set(entry.id, entry); }); return next; });
                  }}>{allSelected ? '取消本页' : '选择本页'}</button>}
                </div>
                {loading ? <div className="flex justify-center py-10"><Spinner size="sm" /></div>
                  : !listing?.entries.length ? <p className="px-3 py-8 text-center text-xs text-faint">暂无文件</p>
                    : <ul className="divide-y divide-line">{listing.entries.map((entry) => <li key={entry.id}>
                      {entry.isDirectory ? <button type="button" className="flex w-full items-center gap-3 px-3 py-3 text-left text-sm text-content hover:bg-hover disabled:opacity-40" disabled={submitting} onClick={() => void loadFolder([...folders, { id: entry.id, name: entry.name }])}>
                        <span className="rounded bg-chip px-1.5 py-1 text-[10px] text-muted shrink-0">目录</span><span className="min-w-0 flex-1 break-words">{entry.name}</span><span className="text-muted" aria-hidden>›</span>
                      </button> : <label className={`flex items-start gap-3 px-3 py-3 ${entry.downloadable ? 'cursor-pointer hover:bg-hover' : 'opacity-50'}`}>
                        <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-accent" checked={selected.has(entry.id)} disabled={!entry.downloadable || submitting} onChange={() => toggle(entry)} aria-label={`选择 ${entry.name}`} />
                        <span className="min-w-0"><span className="block break-words text-sm text-content">{entry.name}</span><span className="mt-1 block text-xs text-faint">{entry.downloadable ? fileSize(entry.size) : '非视频文件'}</span></span>
                      </label>}
                    </li>)}</ul>}
              </div>
              {listing?.hasMore && <p className="text-xs text-faint">当前目录仅显示前 {listing.entries.length} 项</p>}
            </div>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </Drawer>
  </>;
}
