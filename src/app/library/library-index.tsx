'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { api, STATUS_QUERY_KEY } from '@/lib/client-api';
import { Header } from '@/components/header';
import { useAuth } from '@/components/auth';
import { fetchLibrary, guessLibraryMetadata, importLibraryFile } from '@/lib/local-library/client';
import { matchLibraryMetadata } from '@/lib/local-library/metadata-match';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import type { SourceConfig } from '@/lib/types';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryEntry, type LibraryKind, type LibraryMetadata } from '@/lib/local-library/types';
import { fetchLibrarySync } from '@/lib/library-sync-client';
import type { SyncStatus } from '@/lib/library-sync/types';
import { ProgressConflicts, ServerLibrary } from './server-library';
import { LibraryMetadataCompletion } from './library-metadata';
import { ExternalLibraryDialog } from './external-library';
import { LibraryIcon, type LibraryIconName, episodeLabel, orderedEpisodes, percentPlayed, sizeLabel, timeLabel, unfinished } from './library-ui';
import styles from './library.module.css';

type Collection = { id: string; entry: LibraryEntry; episodes: LibraryEntry[] };
type ImportItem = { file: File; metadata: LibraryMetadata; progress: number; state: 'ready' | 'matching' | 'uploading' | 'done' | 'error'; metadataStatus?: 'matched' | 'unmatched' | 'ambiguous' | 'unavailable'; error?: string };
function Poster({ entry, className = '' }: { entry: LibraryEntry; className?: string }) {
  const [failed, setFailed] = useState(false);
  // The library only renders its cached local cover. A remote fallback would break offline playback.
  const localPoster = entry.posterUrl.startsWith('/api/library/') ? entry.posterUrl : '';
  useEffect(() => setFailed(false), [localPoster]);
  return (
    <div className={`${styles.poster} ${className}`}>
      {localPoster && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={localPoster} alt={`${entry.title} 海报`} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className={styles.posterFallback}><LibraryIcon name="film" /><span>{entry.title}</span><small>{entry.kind === 'tv' ? '电视剧' : '电影'}</small></div>
      )}
    </div>
  );
}

export default function LibraryIndex() {
  const router = useRouter();
  const { checked, verified, openLogin } = useAuth();
  const status = useQuery({ queryKey: STATUS_QUERY_KEY, queryFn: api.status, staleTime: 30_000 });
  const directoryImport = status.data?.localAuthBypass === true;
  const selectedKeys = useAppStore((state) => state.selectedKeys);
  const envSources = useAppStore((state) => state.envSources);
  const customAPIs = useAppStore((state) => state.customAPIs);
  const sourceHealth = useAppStore((state) => state.sourceHealth);
  const subscriptions = useAppStore((state) => state.subscriptions);
  const [items, setItems] = useState<LibraryEntry[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | LibraryKind>('all');
  const [sort, setSort] = useState<'added' | 'title'>('added');
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncError, setSyncError] = useState('');
  const [libraryView, setLibraryView] = useState<'local' | 'server'>('local');
  const [onThisMac, setOnThisMac] = useState(true);
  const [externalImportOpen, setExternalImportOpen] = useState(false);
  const syncing = useRef(false);
  const cachedIds = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const importRunning = useRef(false);
  const hasExternal = items.some((item) => item.storage === 'external');
  const metadataSources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys.map((key) => resolveSource({ envSources, customAPIs }, key)).filter((source): source is SourceConfig => {
      if (!source || source.isAdult || seen.has(source.url)
        || isSourceDisabled({ sourceHealth }, source.key) || isInDisabledSubscription({ subscriptions }, source.key)) return false;
      seen.add(source.url); return true;
    });
  }, [selectedKeys, envSources, customAPIs, sourceHealth, subscriptions]);

  const refresh = useCallback(async () => {
    if (!verified) return;
    try {
      const result = await fetchLibrary();
      setEnabled(result.enabled);
      setItems(result.items);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '本地库读取失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [verified]);

  const refreshSync = useCallback(async () => {
    if (!verified || syncing.current) return;
    syncing.current = true;
    try {
      const result = await fetchLibrarySync();
      setSyncStatus(result);
      setSyncError('');
      if (result.enabled) {
        const currentIds = new Set(result.catalog.flatMap((item) => item.cachedLocalId ? [item.cachedLocalId] : []));
        if ([...currentIds].some((id) => !cachedIds.current.has(id))) void refresh();
        cachedIds.current = currentIds;
      }
    } catch (cause) {
      setSyncError(cause instanceof Error ? cause.message : '服务器片库暂时不可用');
    } finally { syncing.current = false; }
  }, [verified, refresh]);

  useEffect(() => {
    setOnThisMac(['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname));
    if (verified) void refreshSync();
  }, [verified, refreshSync]);

  useEffect(() => {
    if (!syncStatus?.enabled) return;
    const timer = setInterval(() => { void refreshSync(); }, 5_000);
    const onFocus = () => { void refreshSync(); };
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [syncStatus?.enabled, refreshSync]);

  useEffect(() => {
    if (verified) {
      void refresh();
      const onFocus = () => { void refresh(); };
      window.addEventListener(LOCAL_LIBRARY_UPDATED_EVENT, refresh);
      window.addEventListener('focus', onFocus);
      return () => {
        window.removeEventListener(LOCAL_LIBRARY_UPDATED_EVENT, refresh);
        window.removeEventListener('focus', onFocus);
      };
    }
    if (checked) setLoading(false);
  }, [checked, verified, refresh]);

  useEffect(() => {
    if (!verified || !hasExternal) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5_000);
    return () => window.clearInterval(timer);
  }, [verified, hasExternal, refresh]);

  useEffect(() => {
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      const kind = params.get('kind');
      setFilter(kind === 'movie' || kind === 'tv' ? kind : 'all');
      setLibraryView(params.get('view') === 'server' ? 'server' : 'local');
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, []);

  useEffect(() => {
    if (syncStatus && !syncStatus.enabled) setLibraryView('local');
  }, [syncStatus]);

  const selectEntry = useCallback((id: string) => {
    router.push(`/library/play/${encodeURIComponent(id)}`);
  }, [router]);

  const collections = useMemo(() => {
    const groups = new Map<string, LibraryEntry[]>();
    for (const item of items) {
      const key = item.kind === 'tv' ? item.groupId : item.id;
      groups.set(key, [...(groups.get(key) || []), item]);
    }
    return [...groups.entries()].map(([id, entries]): Collection => ({ id, entry: entries[0], episodes: orderedEpisodes(entries) }));
  }, [items]);

  const shown = useMemo(() => collections
    .filter(({ entry }) => (filter === 'all' || entry.kind === filter) && entry.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => sort === 'title' ? a.entry.title.localeCompare(b.entry.title, 'zh-CN') : b.episodes.reduce((latest, item) => item.createdAt > latest ? item.createdAt : latest, '').localeCompare(a.episodes.reduce((latest, item) => item.createdAt > latest ? item.createdAt : latest, ''))),
  [collections, filter, query, sort]);

  const continuing = useMemo(() => items.filter(unfinished).sort((a, b) => (b.lastPlayedAt || '').localeCompare(a.lastPlayedAt || '')).slice(0, 6), [items]);
  const movieCount = collections.filter(({ entry }) => entry.kind === 'movie').length;
  const tvCount = collections.filter(({ entry }) => entry.kind === 'tv').length;

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (importRunning.current || directoryImport) return;
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const accepted = files.filter((file) => /\.(mp4|m4v|mov|webm)$/i.test(file.name));
    setImportError(accepted.length !== files.length ? '已跳过不支持的文件。请选择 MP4、M4V、MOV 或 WebM 视频。' : '');
    setImportItems(accepted.map((file) => ({ file, metadata: guessLibraryMetadata(file.name), progress: 0, state: 'ready' })));
  };

  const openImport = () => {
    if (directoryImport) setExternalImportOpen(true);
    else fileInput.current?.click();
  };

  const updateImport = (index: number, metadata: Partial<LibraryMetadata>) => {
    setImportItems((current) => current.map((item, at) => at === index ? { ...item, metadata: { ...item.metadata, ...metadata } } : item));
  };

  const startImport = async () => {
    if (importRunning.current) return;
    importRunning.current = true;
    setImporting(true);
    setImportError('');
    try {
      for (let index = 0; index < importItems.length; index++) {
        const item = importItems[index];
        if (item.state === 'done') continue;
        setImportItems((current) => current.map((row, at) => at === index ? { ...row, state: 'matching', progress: 0, error: undefined } : row));
        try {
          const match = await matchLibraryMetadata(item.metadata, metadataSources)
            .catch(() => ({ status: 'unavailable' as const, metadata: item.metadata }));
          const metadata = match.status === 'matched' ? {
            ...match.metadata, description: item.metadata.description || match.metadata.description,
            coverUrl: item.metadata.coverUrl || match.metadata.coverUrl,
          } : item.metadata;
          setImportItems((current) => current.map((row, at) => at === index ? { ...row, metadata, metadataStatus: match.status, state: 'uploading' } : row));
          await importLibraryFile(item.file, metadata, (progress) => {
            setImportItems((current) => current.map((row, at) => at === index ? { ...row, progress } : row));
          });
          setImportItems((current) => current.map((row, at) => at === index ? { ...row, progress: 100, state: 'done' } : row));
        } catch (cause) {
          setImportItems((current) => current.map((row, at) => at === index ? { ...row, state: 'error', error: cause instanceof Error ? cause.message : '导入失败' } : row));
        }
      }
      await refresh();
    } finally { importRunning.current = false; setImporting(false); }
  };

  return (
    <div className={styles.page}>
      <Header libraryNavigation={{ filter, onFilter: setFilter, view: libraryView, onView: setLibraryView, hasServer: !!syncStatus?.enabled }} />
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="library-title">
          <div>
            <h1 id="library-title">{libraryView === 'server' ? '服务器片库' : filter === 'movie' ? '电影' : filter === 'tv' ? '电视剧' : '全部影片'}</h1>
          </div>
          <div className={styles.heroAside}>
            <span className={styles.localBadge}><span /> {libraryView === 'server' ? syncStatus?.online ? '已连接' : '未连接' : onThisMac ? '本机' : '服务器'}</span>
            {verified && enabled && libraryView === 'local' && <>
              {items.length > 0 && <LibraryMetadataCompletion entries={items} sources={metadataSources} disabled={importing} onUpdated={refresh} />}
              <button className={styles.primaryButton} disabled={importing} onClick={openImport}><LibraryIcon name={directoryImport ? 'folder' : 'upload'} />导入视频</button>
            </>}
          </div>
        </section>

        {verified && syncStatus?.enabled && <nav className={styles.locationTabs} aria-label="片库存储位置"><button aria-pressed={libraryView === 'local'} className={libraryView === 'local' ? styles.activeLocation : ''} onClick={() => setLibraryView('local')}>本地</button><button aria-pressed={libraryView === 'server'} className={libraryView === 'server' ? styles.activeLocation : ''} onClick={() => setLibraryView('server')}>服务器片库</button></nav>}

        <input className={styles.fileInput} ref={fileInput} type="file" accept=".mp4,.m4v,.mov,.webm,video/mp4,video/webm,video/quicktime" multiple disabled={importing || directoryImport} onChange={chooseFiles} aria-label="选择要导入本地库的视频" />

        {!checked || (verified && loading) ? (
          <div className={styles.loading} role="status"><span />正在打开你的影视库…</div>
        ) : !verified ? (
          <StatePanel icon="folder" title="影视库已锁定" description=""><button className={styles.primaryButton} onClick={openLogin}>解锁<LibraryIcon name="arrow" className={styles.forwardArrow} /></button></StatePanel>
        ) : enabled === false ? (
          <StatePanel icon="folder" title="影视库尚未启用" description="未配置存储目录" />
        ) : error && enabled === null ? (
          <StatePanel icon="folder" title="暂时无法打开本地库" description={error}><button className={styles.secondaryButton} onClick={() => void refresh()}>重新读取</button></StatePanel>
        ) : (
          <>
            {syncStatus?.enabled && syncError && <div role="status" className={styles.errorBanner}>{syncError}<button onClick={() => void refreshSync()}>重新连接</button></div>}
            {syncStatus?.enabled && <ProgressConflicts conflicts={syncStatus.progressConflicts} online={syncStatus.online} onRefresh={refreshSync} />}
            {libraryView === 'server' && syncStatus?.enabled ? <ServerLibrary status={syncStatus} onRefresh={refreshSync} onPlay={selectEntry} /> : <>
            {error && <div role="alert" className={styles.errorBanner}>{error}<button onClick={() => void refresh()}>重试</button></div>}

            {continuing.length > 0 && !query && filter === 'all' && <section className={styles.continueSection} aria-labelledby="continue-title">
              <div className={styles.sectionHeading}><h2 id="continue-title">继续观看</h2></div>
              <div className={styles.continueGrid}>{continuing.map((item) => <button key={item.id} className={styles.continueCard} onClick={() => selectEntry(item.id)}>
                <Poster entry={item} className={styles.continuePoster} />
                <div className={styles.continueInfo}><span className={styles.smallEyebrow}>{item.kind === 'tv' ? episodeLabel(item) : '电影'}</span><strong>{item.title}</strong><span>{item.duration ? `还剩 ${timeLabel(Math.max(0, item.duration - (item.position || 0)))}` : `已观看 ${timeLabel(item.position)}`}</span><div className={styles.progressTrack}><i style={{ width: `${percentPlayed(item)}%` }} /></div></div>
                <span className={styles.roundPlay}><LibraryIcon name="play" /></span>
              </button>)}</div>
            </section>}

            <section className={styles.collectionSection} aria-label="全部收藏">
              <div className={styles.collectionHeader}>
                <div className={styles.tabs} role="group" aria-label="影视分类">
                  {([{ key: 'all', label: '全部', count: collections.length }, { key: 'movie', label: '电影', count: movieCount }, { key: 'tv', label: '电视剧', count: tvCount }] as const).map(({ key, label, count }) => <button key={key} className={filter === key ? styles.activeTab : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span>{count}</span></button>)}
                </div>
                <div className={styles.collectionTools}><label className={styles.searchBox}><LibraryIcon name="search" /><input type="search" aria-label="搜索本地片名" placeholder="搜索影片" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select className={styles.sortSelect} aria-label="片库排序" value={sort} onChange={(event) => setSort(event.target.value as 'added' | 'title')}><option value="added">最近入库</option><option value="title">片名排序</option></select></div>
              </div>

              {items.length === 0 ? <StatePanel icon="film" title="暂无影片" description=""><button className={styles.primaryButton} onClick={openImport}><LibraryIcon name={directoryImport ? 'folder' : 'upload'} />导入视频</button><Link className={styles.secondaryButton} href="/">发现影片<LibraryIcon name="arrow" className={styles.forwardArrow} /></Link></StatePanel> : shown.length === 0 ? <StatePanel icon="search" title={query ? `未找到“${query}”` : `暂无${filter === 'tv' ? '电视剧' : '电影'}`} description="" /> : <div className={styles.posterGrid}>{shown.map(({ id, entry, episodes }) => {
                const resume = [...episodes].filter(unfinished).sort((a, b) => (b.lastPlayedAt || '').localeCompare(a.lastPlayedAt || ''))[0];
                const target = resume || episodes[0];
                return <button key={id} className={styles.movieCard} onClick={() => selectEntry(target.id)} aria-label={`${resume ? '继续观看' : '播放'} ${entry.title}${entry.kind === 'tv' ? `，已存 ${episodes.length} 集` : ''}`}>
                  <div className={styles.posterWrap}><Poster entry={entry} /><span className={styles.formatBadge}>{target.available === false ? target.availabilityReason === 'offline' ? '硬盘未连接' : target.availabilityReason === 'changed' ? '文件已变更' : '暂不可用' : target.storage === 'external' ? '外部文件' : entry.kind === 'tv' ? `${episodes.length} 集已存` : '已保存'}</span><div className={styles.posterHover}><span className={styles.posterPlay}><LibraryIcon name="play" /></span><span>{target.available === false ? '查看影片' : resume ? '继续观看' : '立即播放'}</span></div>{percentPlayed(target) > 0 && <div className={styles.cardProgress}><i style={{ width: `${percentPlayed(target)}%` }} /></div>}</div>
                  <strong className={styles.movieTitle}>{entry.title}</strong><span className={styles.movieMeta}>{entry.year && `${entry.year} · `}{entry.kind === 'tv' ? `${new Set(episodes.map((episode) => episode.seasonNumber || 1)).size} 季 · 电视剧` : sizeLabel(entry.bytes)}{entry.kind === 'movie' && percentPlayed(entry) >= 98 ? ' · 已看完' : ''}</span>
                </button>;
              })}</div>}
              {items.length > 0 && <p className={styles.libraryFootnote}><LibraryIcon name="folder" /><span>{movieCount} 部电影，{tvCount} 部电视剧 · 共 {items.length} 个视频 · 视频总大小 {sizeLabel(items.reduce((sum, item) => sum + item.bytes, 0))}</span></p>}
            </section>
            </>}
          </>
        )}

        {importError && importItems.length === 0 && <p role="alert" className={styles.errorBanner}>{importError}</p>}
      </main>

      {!directoryImport && importItems.length > 0 && <ImportDialog items={importItems} importing={importing} error={importError} onChange={updateImport} onStart={() => void startImport()} onClose={() => setImportItems([])} />}
      {directoryImport && <ExternalLibraryDialog open={externalImportOpen} onClose={() => setExternalImportOpen(false)} sources={metadataSources} onUpdated={refresh} />}
    </div>
  );
}

function StatePanel({ icon, title, description, children }: { icon: LibraryIconName; title: string; description: string; children?: ReactNode }) {
  return <div className={styles.statePanel}><span className={styles.stateIcon}><LibraryIcon name={icon} /></span><h2>{title}</h2><p>{description}</p>{children && <div className={styles.stateActions}>{children}</div>}</div>;
}

function ImportDialog({ items, importing, error, onChange, onStart, onClose }: { items: ImportItem[]; importing: boolean; error: string; onChange: (index: number, metadata: Partial<LibraryMetadata>) => void; onStart: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const done = items.every((item) => item.state === 'done');

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    return () => { document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !importing) onClose();
    if (event.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className={styles.modalBackdrop} onClick={(event) => { if (event.target === event.currentTarget && !importing) onClose(); }}>
    <div ref={dialog} className={styles.importDialog} role="dialog" aria-modal="true" aria-labelledby="import-title" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className={styles.dialogHeading}><div><h2 id="import-title">{done ? '导入完成' : '导入视频'}</h2></div><button aria-label="关闭导入窗口" className={styles.closeButton} disabled={importing} onClick={onClose}><LibraryIcon name="close" /></button></div>
      {error && <p className={styles.errorBanner} role="alert">{error}</p>}
      <div className={styles.importList}>{items.map((item, index) => <div key={`${item.file.name}-${index}`} className={styles.importRow}>
        <div className={styles.importFile}><LibraryIcon name={item.state === 'done' ? 'check' : 'film'} /><span title={item.file.name}>{item.file.name}</span><small>{sizeLabel(item.file.size)}</small></div>
        <div className={styles.importFields}><label className={styles.titleField}>片名<input aria-label={`${item.file.name} 的片名`} value={item.metadata.title} maxLength={200} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { title: event.target.value })} /></label><label className={styles.numberField}>年份<input aria-label={`${item.file.name} 的年份`} inputMode="numeric" value={item.metadata.year || ''} maxLength={4} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { year: event.target.value.replace(/\D/g, '').slice(0, 4) || undefined })} /></label><label>分类<select aria-label={`${item.file.name} 的分类`} value={item.metadata.kind} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { kind: event.target.value as LibraryKind, ...(event.target.value === 'tv' ? { seasonNumber: item.metadata.seasonNumber || 1, episodeNumber: item.metadata.episodeNumber || index + 1 } : {}) })}><option value="movie">电影</option><option value="tv">电视剧</option></select></label>{item.metadata.kind === 'tv' && <><label className={styles.numberField}>季<input type="number" min="1" max="999" aria-label={`${item.file.name} 的季数`} value={item.metadata.seasonNumber || 1} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { seasonNumber: Math.max(1, Number(event.target.value) || 1) })} /></label><label className={styles.numberField}>集<input type="number" min="1" max="9999" aria-label={`${item.file.name} 的集数`} value={item.metadata.episodeNumber || index + 1} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { episodeNumber: Math.max(1, Number(event.target.value) || 1) })} /></label></>}</div>
        {item.state === 'matching' && <p className={styles.metadataStatus} role="status">匹配资料…</p>}
        {(item.state === 'uploading' || item.state === 'done') && <div className={styles.importProgress}><div className={styles.progressTrack}><i style={{ width: `${item.progress}%` }} /></div><span>{item.state === 'done' ? '已入库' : `${Math.round(item.progress)}%`}</span></div>}
        {item.metadataStatus && item.metadataStatus !== 'matched' && <p className={styles.metadataStatus}>{item.metadataStatus === 'ambiguous' ? '同名资料未确认' : '资料未匹配'}</p>}
        {item.error && <p className={styles.importRowError} role="alert">{item.error}</p>}
      </div>)}</div>
      <div className={styles.dialogFooter}><span>{importing || done ? `${items.filter((item) => item.state === 'done').length} / ${items.length} 个视频已入库` : '复制到当前片库，原文件保留'}</span>{done ? <button className={styles.primaryButton} onClick={onClose}>打开片库<LibraryIcon name="arrow" className={styles.forwardArrow} /></button> : <button className={styles.primaryButton} disabled={importing || items.some((item) => !item.metadata.title.trim())} onClick={onStart}><LibraryIcon name="upload" />{importing ? '导入中…' : items.some((item) => item.state === 'error') ? '重试' : '复制入库'}</button>}</div>
    </div>
  </div>;
}
