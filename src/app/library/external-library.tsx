'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer } from '@/components/drawer';
import { useToast } from '@/components/toast';
import {
  addLibraryLocation, chooseLibraryLocation, fetchLibraryLocations, indexLibraryReference, scanLibraryLocation,
  type ExternalLocation, type ExternalMediaFile,
} from '@/lib/local-library/external-client';
import { guessLibraryMetadata } from '@/lib/local-library/client';
import { matchLibraryMetadata } from '@/lib/local-library/metadata-match';
import type { LibraryMetadata } from '@/lib/local-library/types';
import type { SourceConfig } from '@/lib/types';
import { LibraryIcon, sizeLabel } from './library-ui';
import styles from './library.module.css';

interface FileRow {
  file: ExternalMediaFile; selected: boolean; metadata: LibraryMetadata;
  state: 'ready' | 'matching' | 'adding' | 'added' | 'existing' | 'error'; error?: string;
}

export function ExternalLibraryDialog({ open, onClose, sources, onUpdated }: {
  open: boolean; onClose: () => void; sources: SourceConfig[]; onUpdated: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [locations, setLocations] = useState<ExternalLocation[]>([]);
  const [path, setPath] = useState('');
  const [location, setLocation] = useState<ExternalLocation | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState<'choose' | 'scan' | 'index' | null>(null);
  const [error, setError] = useState('');
  const running = useRef(false);
  const stopped = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const refreshLocations = useCallback(async () => {
    try {
      const result = await fetchLibraryLocations();
      if (mounted.current) { setLocations(result.locations); setError(''); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '媒体目录读取失败'); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopped.current = true; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setError('');
    void refreshLocations();
  }, [open, refreshLocations]);

  const scan = async (next: ExternalLocation) => {
    if (mounted.current) { setLocation(next); setPath(next.path); setRows([]); setTruncated(false); }
    const result = await scanLibraryLocation(next.id);
    if (!mounted.current) return;
    setLocation(result.location); setPath(result.location.path); setTruncated(result.truncated);
    setRows(result.files.map((file) => ({ file, selected: true, metadata: guessLibraryMetadata(file.name), state: 'ready' })));
    setLocations((previous) => [...previous.filter((item) => item.id !== result.location.id), result.location]);
  };
  const runDirectoryAction = async (action: () => Promise<ExternalLocation | undefined>, mode: 'choose' | 'scan') => {
    if (running.current) return;
    running.current = true; setBusy(mode); setError('');
    if (mode === 'scan') { setRows([]); setLocation(null); setTruncated(false); }
    try { const next = await action(); if (next) await scan(next); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '媒体目录暂时不可用'); }
    finally { running.current = false; if (mounted.current) setBusy(null); }
  };
  const choose = () => runDirectoryAction(async () => {
    const result = await chooseLibraryLocation();
    return result.cancelled ? undefined : result.location;
  }, 'choose');
  const add = () => runDirectoryAction(async () => (await addLibraryLocation(path)).location, 'scan');

  const selected = rows.filter((row) => row.selected && !['added', 'existing'].includes(row.state));
  const patchRow = (id: string, change: Partial<FileRow>) => {
    if (mounted.current) setRows((previous) => previous.map((row) => row.file.id === id ? { ...row, ...change } : row));
  };
  const index = async () => {
    if (running.current || !location || !selected.length) return;
    running.current = true; stopped.current = false; setBusy('index'); setError('');
    let added = 0, existing = 0;
    try {
      for (const row of selected) {
        if (stopped.current) break;
        const abort = new AbortController(); controller.current = abort;
        patchRow(row.file.id, { state: 'matching', error: undefined });
        let metadata = row.metadata;
        try {
          const match = await matchLibraryMetadata(metadata, sources, abort.signal);
          if (match.status === 'matched') metadata = match.metadata;
        } catch { if (stopped.current) { patchRow(row.file.id, { state: 'ready' }); break; } }
        if (stopped.current) { patchRow(row.file.id, { state: 'ready' }); break; }
        patchRow(row.file.id, { metadata, state: 'adding' });
        try {
          const result = await indexLibraryReference(location.id, row.file.id, metadata);
          if (result.existing) existing++; else added++;
          patchRow(row.file.id, { state: result.existing ? 'existing' : 'added', selected: false });
        } catch (cause) {
          patchRow(row.file.id, { state: 'error', error: cause instanceof Error ? cause.message : '加入片库失败' });
        }
      }
      await onUpdated();
      if (mounted.current && (added || existing)) toast(added ? `已加入 ${added} 个视频${existing ? `，${existing} 个已在片库` : ''}` : '所选视频已在片库', 'success');
    } finally { running.current = false; controller.current = null; if (mounted.current) setBusy(null); }
  };
  const stop = () => { stopped.current = true; controller.current?.abort(); };
  const close = () => { if (!running.current) onClose(); };
  const readyRows = rows.filter((row) => !['added', 'existing'].includes(row.state));
  const allSelected = readyRows.length > 0 && readyRows.every((row) => row.selected);
  const rowLabel = (row: FileRow) => row.state === 'matching' ? '匹配资料…' : row.state === 'adding' ? '加入中…' : row.state === 'added' ? '已加入' : row.state === 'existing' ? '已在片库' : row.state === 'error' ? '加入失败' : [row.metadata.title, row.metadata.year].filter(Boolean).join(' · ');

  return <Drawer open={open} onClose={close} title="添加媒体目录" width="max-w-2xl" closeOnOverlay={!busy}
    footer={<div className={styles.dialogFooter}>
      <span>{busy === 'choose' ? '请选择文件夹' : busy === 'scan' ? '正在扫描…' : `已选 ${selected.length} 个视频`}</span>
      {busy === 'index' ? <button className={styles.secondaryButton} onClick={stop}>停止</button>
        : <button className={styles.primaryButton} disabled={!!busy || !selected.length || !location} onClick={() => void index()}>加入片库</button>}
    </div>}>
    <p className={styles.externalHint}>引用原文件，不复制视频</p>
    <div className={styles.externalPathRow}>
      <input aria-label="媒体目录路径" placeholder="粘贴文件夹路径" value={path} maxLength={4096} disabled={!!busy} onChange={(event) => setPath(event.target.value)} />
      <button type="button" className={styles.secondaryButton} disabled={!!busy || !path.trim()} onClick={() => void add()}>添加并扫描</button>
    </div>
    <button type="button" className={styles.secondaryButton} disabled={!!busy} onClick={() => void choose()}><LibraryIcon name="folder" />选择文件夹</button>
    {error && <p className={styles.errorBanner} role="alert">{error}</p>}
    {locations.length > 0 && <section className={styles.externalLocations} aria-label="已添加的媒体目录">
      <div className={styles.externalSectionHeading}><h3>媒体目录</h3><button type="button" disabled={!!busy} onClick={() => void refreshLocations()}>刷新</button></div>
      {locations.map((item) => <div key={item.id} className={styles.externalLocation}>
        <div><strong>{item.label}</strong><span>{item.path}</span>{!item.online && <small>硬盘未连接</small>}</div>
        <button type="button" className={styles.secondaryButton} disabled={!!busy} onClick={() => void runDirectoryAction(async () => item, 'scan')}>重新扫描</button>
      </div>)}
    </section>}
    {location && <section className={styles.externalFiles} aria-label="目录内视频">
      <div className={styles.externalSectionHeading}><h3>{location.label}</h3>{readyRows.length > 0 && <button type="button" disabled={!!busy} onClick={() => setRows((previous) => previous.map((row) => ['added', 'existing'].includes(row.state) ? row : { ...row, selected: !allSelected }))}>{allSelected ? '取消选择' : '选择全部'}</button>}</div>
      {!rows.length ? <p className={styles.metadataStatus}>目录中没有可加入的视频</p> : rows.map((row) => <label key={row.file.id} className={styles.externalFile}>
        <input type="checkbox" checked={row.selected} aria-label={`选择 ${row.file.name}`} disabled={!!busy || ['added', 'existing'].includes(row.state)} onChange={(event) => patchRow(row.file.id, { selected: event.target.checked })} />
        <span><strong>{row.file.relativePath}</strong><small role={['matching', 'adding', 'added', 'existing'].includes(row.state) ? 'status' : undefined}>{rowLabel(row)}</small>{row.error && <small className={styles.externalFileError}>{row.error}</small>}</span><em>{sizeLabel(row.file.bytes)}</em>
      </label>)}
      {truncated && <p className={styles.metadataStatus}>目录较大，当前仅显示部分视频</p>}
    </section>}
  </Drawer>;
}
