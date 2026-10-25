'use client';

import { useMemo, useState } from 'react';
import { cacheServerVideo, resolveLibraryProgress } from '@/lib/library-sync-client';
import type { SyncCatalogItem, SyncProgressConflict, SyncStatus } from '@/lib/library-sync/types';
import { LOCAL_LIBRARY_UPDATED_EVENT } from '@/lib/local-library/types';
import styles from './library.module.css';

function clock(position = 0): string {
  return `${Math.floor(position / 3600) ? `${Math.floor(position / 3600)}:` : ''}${String(Math.floor(position / 60) % 60).padStart(2, '0')}:${String(Math.floor(position) % 60).padStart(2, '0')}`;
}

function episodeName(item: SyncCatalogItem): string {
  return item.kind === 'tv' ? `第 ${item.seasonNumber || 1} 季 · ${item.episodeTitle || `第 ${item.episodeNumber || 1} 集`}` : item.year || '电影';
}

function cacheLabel(item: SyncCatalogItem): string {
  if (item.cachedLocalId) return '已在本地';
  if (item.cacheTask?.status === 'queued') return '排队中';
  if (item.cacheTask?.status === 'downloading') return `正在缓存 ${Math.min(100, Math.round(item.cacheTask.progress))}%`;
  if (item.cacheTask?.status === 'error') return '缓存失败';
  return '服务器';
}

function ServerPoster({ item }: { item: SyncCatalogItem }) {
  const [failed, setFailed] = useState(false);
  const source = item.posterUrl.startsWith('/api/library-sync/') ? item.posterUrl : '';
  return <div className={styles.poster}>{source && !failed
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={source} alt={`${item.title} 海报`} loading="lazy" onError={() => setFailed(true)} />
    : <div className={styles.posterFallback}><span>{item.title}</span><small>{item.kind === 'tv' ? '电视剧' : '电影'}</small></div>}
  </div>;
}

export function ProgressConflicts({ conflicts, online, onRefresh }: { conflicts: SyncProgressConflict[]; online: boolean; onRefresh: () => Promise<void> }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (!conflicts.length) return null;
  const resolve = async (itemId: string, choice: 'local' | 'server') => {
    setPending(itemId);
    setError('');
    try {
      await resolveLibraryProgress(itemId, choice);
      await onRefresh();
      window.dispatchEvent(new CustomEvent(LOCAL_LIBRARY_UPDATED_EVENT));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '进度同步失败'); }
    finally { setPending(null); }
  };
  return <section className={styles.syncConflicts} aria-label="选择观看进度">
    <h2>观看进度冲突</h2>
    {conflicts.map((conflict) => <div key={conflict.itemId} className={styles.syncConflictRow}>
      <strong>{conflict.title}</strong>
      <div><button className={styles.secondaryButton} disabled={!online || pending !== null} onClick={() => void resolve(conflict.itemId, 'local')}>使用 Mac 进度 · {clock(conflict.local.position)}</button><button className={styles.secondaryButton} disabled={!online || pending !== null} onClick={() => void resolve(conflict.itemId, 'server')}>使用服务器进度 · {clock(conflict.server.position)}</button></div>
    </div>)}
    {!online && <p>服务器未连接</p>}
    {error && <p className={styles.progressError} role="alert">{error}</p>}
  </section>;
}

export function ServerLibrary({ status, onRefresh, onPlay }: { status: SyncStatus; onRefresh: () => Promise<void>; onPlay: (localId: string) => void }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'movie' | 'tv'>('all');
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const collections = useMemo(() => {
    const groups = new Map<string, SyncCatalogItem[]>();
    for (const item of status.catalog) {
      const key = item.kind === 'tv' ? item.groupId : item.id;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.entries()].map(([id, items]) => ({ id, items: items.sort((a, b) => (a.seasonNumber || 1) - (b.seasonNumber || 1) || (a.episodeNumber || 1) - (b.episodeNumber || 1)) }));
  }, [status.catalog]);
  const shown = collections.filter(({ items }) => (filter === 'all' || items[0].kind === filter) && items[0].title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = collections.find((collection) => collection.id === selectedGroup);
  const serverUrl = status.serverUrl && /^https?:\/\//.test(status.serverUrl) ? status.serverUrl.replace(/\/$/, '') : '';

  const cache = async (item: SyncCatalogItem) => {
    if (pending.has(item.id)) return;
    setPending((current) => new Set(current).add(item.id));
    setError('');
    try { await cacheServerVideo(item.id); await onRefresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '无法创建离线缓存任务'); }
    finally { setPending((current) => { const next = new Set(current); next.delete(item.id); return next; }); }
  };
  const actions = (item: SyncCatalogItem) => {
    const busy = pending.has(item.id) || item.cacheTask?.status === 'queued' || item.cacheTask?.status === 'downloading';
    return item.cachedLocalId
      ? <button className={styles.secondaryButton} onClick={() => onPlay(item.cachedLocalId!)}>本地播放</button>
      : <button className={styles.secondaryButton} disabled={busy || !status.online} onClick={() => void cache(item)}>{busy ? '缓存中…' : item.cacheTask?.status === 'error' ? '重试' : '保存到本地'}</button>;
  };

  return <section className={styles.serverLibrary} aria-label="服务器片库">
    <div className={styles.syncDescription}><div><p>{status.online ? '已连接' : '离线目录'}</p></div>{serverUrl && <a href={`${serverUrl}/library`} target="_blank" rel="noreferrer" className={styles.secondaryButton}>在线打开</a>}</div>
    {(error || status.error) && <div className={styles.errorBanner} role="status">{error || status.error}<button onClick={() => void onRefresh()}>重新连接</button></div>}
    <div className={styles.collectionHeader}>
      <div className={styles.tabs} role="group" aria-label="服务器影视分类">{([{ key: 'all', label: '全部' }, { key: 'movie', label: '电影' }, { key: 'tv', label: '电视剧' }] as const).map(({ key, label }) => <button key={key} className={filter === key ? styles.activeTab : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{collections.filter(({ items }) => key === 'all' || items[0].kind === key).length}</span></button>)}</div>
      <label className={styles.searchBox}><input type="search" aria-label="搜索服务器片名" placeholder="搜索影片" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>
    {selected && <div className={styles.serverEpisodes}>
      <div className={styles.sectionHeading}><h2>{selected.items[0].title}</h2><button className={styles.textButton} onClick={() => setSelectedGroup(null)}>收起选集</button></div>
      {selected.items.map((item) => <div key={item.id} className={styles.serverEpisodeRow}><div><strong>{episodeName(item)}</strong><span>{cacheLabel(item)}</span>{item.cacheTask?.status === 'error' && item.cacheTask.error && <small>{item.cacheTask.error}</small>}</div>{actions(item)}</div>)}
    </div>}
    {shown.length === 0 ? <div className={styles.statePanel}><h2>{query ? '没有找到这部影片' : status.catalog.length ? '暂无影片' : '暂无影片'}</h2></div>
      : <div className={styles.posterGrid}>{shown.map(({ id, items }) => {
        const item = items[0];
        const cached = items.filter((entry) => entry.cachedLocalId).length;
        return <div key={id} className={styles.movieCard}>
          <button className={styles.serverPosterButton} onClick={() => item.kind === 'tv' ? setSelectedGroup(id) : item.cachedLocalId ? onPlay(item.cachedLocalId) : setSelectedGroup(id)} aria-label={`${item.title}${item.kind === 'tv' ? '，选择缓存剧集' : '，查看离线缓存'}`}><div className={styles.posterWrap}><ServerPoster item={item} /><span className={styles.formatBadge}>{item.kind === 'tv' ? `${items.length} 集 · ${cached} 集已存` : item.cachedLocalId ? '本地已存' : '服务器'}</span></div></button>
          <strong className={styles.movieTitle}>{item.title}</strong><span className={styles.movieMeta}>{item.kind === 'tv' ? `${items.length} 集 · 电视剧` : cacheLabel(item)}</span>
          <div className={styles.serverCardAction}>{item.kind === 'tv' ? <button className={styles.secondaryButton} onClick={() => setSelectedGroup(id)}>选择剧集</button> : actions(item)}</div>
        </div>;
      })}</div>}
  </section>;
}
