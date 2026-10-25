'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { guessLibraryMetadata, updateLibraryMetadata } from '@/lib/local-library/client';
import { matchLibraryMetadata } from '@/lib/local-library/metadata-match';
import type { LibraryEntry, LibraryMetadata } from '@/lib/local-library/types';
import type { SourceConfig } from '@/lib/types';
import { useToast } from '@/components/toast';
import { LibraryIcon } from './library-ui';
import styles from './library.module.css';

type MatchState = 'ready' | 'matching' | 'saved' | 'unmatched' | 'ambiguous' | 'unavailable' | 'error';
interface MetadataRow { key: string; entries: LibraryEntry[]; query: LibraryMetadata; state: MatchState; error?: string }

const stateLabel: Record<MatchState, string> = {
  ready: '待匹配', matching: '匹配中…', saved: '已补全', unmatched: '未找到匹配',
  ambiguous: '存在同名影片，请补充年份', unavailable: '片源暂不可用', error: '保存失败',
};

function rowsFor(entries: LibraryEntry[]): MetadataRow[] {
  const groups = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    if (entry.hasPoster !== false && entry.description?.trim()) continue;
    const key = entry.kind === 'tv' ? `${entry.groupId}:${entry.seasonNumber || 1}` : entry.id;
    groups.set(key, [...(groups.get(key) || []), entry]);
  }
  return [...groups].map(([key, members]) => {
    const entry = members[0];
    const guessed = guessLibraryMetadata(`${entry.title}.mp4`);
    return { key, entries: members, state: 'ready', query: {
      title: guessed.title, kind: entry.kind, year: entry.year || guessed.year,
      ...(entry.kind === 'tv' ? { seasonNumber: entry.seasonNumber, episodeNumber: entry.episodeNumber, episodeTitle: entry.episodeTitle } : {}),
    } };
  });
}

/** Fill missing artwork and synopsis; existing TV group identity stays stable. */
export function LibraryMetadataCompletion({ entries, sources, disabled, onUpdated }: {
  entries: LibraryEntry[]; sources: SourceConfig[]; disabled?: boolean; onUpdated: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<MetadataRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopRequested.current = true; controller.current?.abort(); };
  }, []);

  const open = () => {
    const next = rowsFor(entries);
    if (!next.length) { toast('资料已完整', 'info'); return; }
    setRows(next); setError('');
  };
  const edit = (key: string, change: Partial<LibraryMetadata>) => {
    setRows((previous) => previous?.map((row) => row.key === key ? { ...row, query: { ...row.query, ...change }, state: 'ready', error: undefined } : row) || null);
  };
  const patch = (key: string, change: Partial<MetadataRow>) => {
    if (mounted.current) setRows((previous) => previous?.map((row) => row.key === key ? { ...row, ...change } : row) || null);
  };
  const stop = () => { stopRequested.current = true; controller.current?.abort(); };

  const complete = async () => {
    if (running.current || !rows) return;
    if (!sources.length) { setError('请先启用可用的点播源'); return; }
    running.current = true; stopRequested.current = false; setBusy(true); setError('');
    let saved = 0;
    try {
      for (const row of rows) {
        if (row.state === 'saved') continue;
        if (stopRequested.current) break;
        const abort = new AbortController(); controller.current = abort;
        patch(row.key, { state: 'matching', error: undefined });
        try {
          const match = await matchLibraryMetadata(row.query, sources, abort.signal);
          if (stopRequested.current) { patch(row.key, { state: 'ready' }); break; }
          if (match.status !== 'matched') { patch(row.key, { state: match.status }); continue; }
          for (const entry of row.entries) {
            if (stopRequested.current) break;
            const metadata: LibraryMetadata = {
              ...match.metadata,
              // Retain grouping and episode identity when enriching an existing series.
              ...(entry.kind === 'tv' ? { title: entry.title, year: entry.year, kind: entry.kind, seasonNumber: entry.seasonNumber, episodeNumber: entry.episodeNumber, episodeTitle: entry.episodeTitle } : {}),
              description: entry.description?.trim() ? entry.description : match.metadata.description,
              sourceName: entry.sourceName || match.metadata.sourceName,
              coverUrl: entry.hasPoster === true ? undefined : match.metadata.coverUrl,
            };
            await updateLibraryMetadata(entry.id, metadata);
          }
          if (stopRequested.current) { patch(row.key, { state: 'ready' }); break; }
          saved++; patch(row.key, { state: 'saved' });
        } catch (cause) {
          if (abort.signal.aborted || stopRequested.current) { patch(row.key, { state: 'ready' }); break; }
          patch(row.key, { state: 'error', error: cause instanceof Error ? cause.message : '资料更新失败' });
        }
      }
      await onUpdated();
      if (mounted.current && saved) toast(`已补全 ${saved} 项资料`, 'success');
    } finally { running.current = false; controller.current = null; if (mounted.current) setBusy(false); }
  };

  return <>
    <button type="button" className={styles.secondaryButton} disabled={disabled || busy} onClick={open}>补全资料</button>
    {rows && <MetadataDialog rows={rows} busy={busy} error={error} onEdit={edit} onStart={() => void complete()} onStop={stop} onClose={() => { if (!running.current) setRows(null); }} />}
  </>;
}

function MetadataDialog({ rows, busy, error, onEdit, onStart, onStop, onClose }: {
  rows: MetadataRow[]; busy: boolean; error: string; onEdit: (key: string, change: Partial<LibraryMetadata>) => void;
  onStart: () => void; onStop: () => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const done = rows.every((row) => row.state === 'saved');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; dialog.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !busy) onClose();
    if (event.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className={styles.modalBackdrop} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={styles.importDialog} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="metadata-title" tabIndex={-1} onKeyDown={keyDown}>
      <div className={styles.dialogHeading}><h2 id="metadata-title">补全资料</h2><button type="button" className={styles.closeButton} aria-label="关闭资料匹配" disabled={busy} onClick={onClose}><LibraryIcon name="close" /></button></div>
      {error && <p className={styles.errorBanner} role="alert">{error}</p>}
      <div className={styles.importList}>{rows.map((row) => <div key={row.key} className={styles.importRow}>
        <div className={styles.importFields}>
          <label className={styles.titleField}>片名<input aria-label={`${row.entries[0].title} 的匹配片名`} value={row.query.title} maxLength={200} disabled={busy || row.state === 'saved'} onChange={(event) => onEdit(row.key, { title: event.target.value })} /></label>
          <label className={styles.numberField}>年份<input aria-label={`${row.entries[0].title} 的匹配年份`} inputMode="numeric" value={row.query.year || ''} maxLength={4} disabled={busy || row.state === 'saved'} onChange={(event) => onEdit(row.key, { year: event.target.value.replace(/\D/g, '').slice(0, 4) || undefined })} /></label>
        </div>
        <p className={styles.metadataStatus} role="status">{row.entries[0].kind === 'tv' ? `第 ${row.entries[0].seasonNumber || 1} 季 · ` : ''}{stateLabel[row.state]}</p>
        {row.error && <p className={styles.importRowError} role="alert">{row.error}</p>}
      </div>)}</div>
      <div className={styles.dialogFooter}><span>{rows.filter((row) => row.state === 'saved').length} / {rows.length} 项已补全</span>
        {busy ? <button type="button" className={styles.secondaryButton} onClick={onStop}>停止</button>
          : done ? <button type="button" className={styles.primaryButton} onClick={onClose}>完成</button>
            : <button type="button" className={styles.primaryButton} disabled={rows.some((row) => !row.query.title.trim())} onClick={onStart}>{rows.some((row) => row.state !== 'ready') ? '重新匹配' : '开始匹配'}</button>}
      </div>
    </div>
  </div>;
}
