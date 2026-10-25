'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { Header } from '@/components/header';
import { useAuth } from '@/components/auth';
import { fetchLibrary, guessLibraryMetadata, importLibraryFile } from '@/lib/local-library/client';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryEntry, type LibraryKind, type LibraryMetadata } from '@/lib/local-library/types';
import { fetchLibrarySync } from '@/lib/library-sync-client';
import type { SyncStatus } from '@/lib/library-sync/types';
import { ProgressConflicts, ServerLibrary } from './server-library';
import styles from './library.module.css';

type Collection = { id: string; entry: LibraryEntry; episodes: LibraryEntry[] };
type ImportItem = { file: File; metadata: LibraryMetadata; progress: number; state: 'ready' | 'uploading' | 'done' | 'error'; error?: string };
type LibraryIconName = 'play' | 'folder' | 'search' | 'upload' | 'close' | 'arrow' | 'next' | 'previous' | 'check' | 'film';

function LibraryIcon({ name, className = '' }: { name: LibraryIconName; className?: string }) {
  const paths: Record<LibraryIconName, ReactNode> = {
    play: <path d="m9 5 11 7-11 7V5Z" />,
    folder: <path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9H3V7Z" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <path d="m9 5-7 7 7 7M2 12h20" />,
    next: <><path d="m5 5 11 7-11 7V5Z" /><path d="M20 5v14" /></>,
    previous: <><path d="m19 5-11 7 11 7V5Z" /><path d="M4 5v14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    film: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7 3v18M17 3v18M3 8h4m-4 8h4M17 8h4m-4 8h4" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>{paths[name]}</svg>;
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

function timeLabel(seconds = 0): string {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

function episodeLabel(entry: LibraryEntry): string {
  if (entry.kind !== 'tv') return entry.year || '电影';
  const season = entry.seasonNumber ? `第 ${entry.seasonNumber} 季 · ` : '';
  return `${season}${entry.episodeNumber ? `第 ${entry.episodeNumber} 集` : entry.episodeTitle || '剧集'}`;
}

function percentPlayed(entry: LibraryEntry): number {
  return entry.duration ? Math.min(100, Math.max(0, ((entry.position || 0) / entry.duration) * 100)) : 0;
}

function unfinished(entry: LibraryEntry): boolean {
  return (entry.position || 0) > 3 && (!entry.duration || (entry.position || 0) < entry.duration - 10);
}

function orderedEpisodes(items: LibraryEntry[]): LibraryEntry[] {
  return [...items].sort((a, b) => (a.seasonNumber || 1) - (b.seasonNumber || 1) || (a.episodeNumber || 0) - (b.episodeNumber || 0) || a.createdAt.localeCompare(b.createdAt));
}

function Poster({ entry, className = '' }: { entry: LibraryEntry; className?: string }) {
  const [failed, setFailed] = useState(false);
  // The library only renders its cached local cover. A remote fallback would break offline playback.
  const localPoster = entry.posterUrl.startsWith('/api/library/') ? entry.posterUrl : '';
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

export default function LibraryPage() {
  const { checked, verified, openLogin } = useAuth();
  const [items, setItems] = useState<LibraryEntry[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | LibraryKind>('all');
  const [sort, setSort] = useState<'added' | 'title'>('added');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importItems, setImportItems] = useState<ImportItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncError, setSyncError] = useState('');
  const [libraryView, setLibraryView] = useState<'local' | 'server'>('local');
  const [onThisMac, setOnThisMac] = useState(true);
  const syncing = useRef(false);
  const cachedIds = useRef(new Set<string>());
  const fileInput = useRef<HTMLInputElement>(null);
  const playerSection = useRef<HTMLElement>(null);

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
    const readLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedId(params.get('play'));
      const kind = params.get('kind');
      if (kind === 'movie' || kind === 'tv') setFilter(kind);
    };
    readLocation();
    window.addEventListener('popstate', readLocation);
    return () => window.removeEventListener('popstate', readLocation);
  }, []);

  const selectEntry = useCallback((id: string | null) => {
    setSelectedId(id);
    const next = id ? `/library?play=${encodeURIComponent(id)}` : '/library';
    window.history.pushState(null, '', next);
    if (id) requestAnimationFrame(() => playerSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, []);

  const updateProgress = useCallback((id: string, position: number, duration: number) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, position, duration, lastPlayedAt: new Date().toISOString() } : item));
  }, []);

  const playCached = async (id: string) => {
    await refresh();
    setLibraryView('local');
    selectEntry(id);
  };

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
  const selected = items.find((item) => item.id === selectedId);
  const selectedEpisodes = selected?.kind === 'tv' ? orderedEpisodes(items.filter((item) => item.groupId === selected.groupId)) : selected ? [selected] : [];
  const movieCount = collections.filter(({ entry }) => entry.kind === 'movie').length;
  const tvCount = collections.filter(({ entry }) => entry.kind === 'tv').length;

  const chooseFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    const accepted = files.filter((file) => /\.(mp4|m4v|mov|webm)$/i.test(file.name));
    setImportError(accepted.length !== files.length ? '已跳过不支持的文件。请选择 MP4、M4V、MOV 或 WebM 视频。' : '');
    setImportItems(accepted.map((file) => ({ file, metadata: guessLibraryMetadata(file.name), progress: 0, state: 'ready' })));
  };

  const updateImport = (index: number, metadata: Partial<LibraryMetadata>) => {
    setImportItems((current) => current.map((item, at) => at === index ? { ...item, metadata: { ...item.metadata, ...metadata } } : item));
  };

  const startImport = async () => {
    setImporting(true);
    setImportError('');
    for (let index = 0; index < importItems.length; index++) {
      const item = importItems[index];
      if (item.state === 'done') continue;
      setImportItems((current) => current.map((row, at) => at === index ? { ...row, state: 'uploading', progress: 0, error: undefined } : row));
      try {
        await importLibraryFile(item.file, item.metadata, (progress) => {
          setImportItems((current) => current.map((row, at) => at === index ? { ...row, progress } : row));
        });
        setImportItems((current) => current.map((row, at) => at === index ? { ...row, progress: 100, state: 'done' } : row));
      } catch (cause) {
        setImportItems((current) => current.map((row, at) => at === index ? { ...row, state: 'error', error: cause instanceof Error ? cause.message : '导入失败' } : row));
      }
    }
    await refresh();
    setImporting(false);
  };

  return (
    <div className={styles.page}>
      <Header libraryNavigation={{ filter, onFilter: (value) => { setFilter(value); selectEntry(null); }, view: libraryView, onView: setLibraryView, hasServer: !!syncStatus?.enabled }} />
      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="library-title">
          <div>
            <h1 id="library-title">{libraryView === 'server' ? '服务器片库' : filter === 'movie' ? '电影' : filter === 'tv' ? '电视剧' : '全部影片'}</h1>
          </div>
          <div className={styles.heroAside}>
            <span className={styles.localBadge}><span /> {libraryView === 'server' ? syncStatus?.online ? '已连接' : '未连接' : onThisMac ? '本机' : '服务器'}</span>
            {verified && enabled && libraryView === 'local' && <button className={styles.primaryButton} onClick={() => fileInput.current?.click()}><LibraryIcon name="upload" />导入视频</button>}
          </div>
        </section>

        {verified && syncStatus?.enabled && <nav className={styles.locationTabs} aria-label="片库存储位置"><button aria-pressed={libraryView === 'local'} className={libraryView === 'local' ? styles.activeLocation : ''} onClick={() => setLibraryView('local')}>本地</button><button aria-pressed={libraryView === 'server'} className={libraryView === 'server' ? styles.activeLocation : ''} onClick={() => setLibraryView('server')}>服务器片库</button></nav>}

        <input className={styles.fileInput} ref={fileInput} type="file" accept=".mp4,.m4v,.mov,.webm,video/mp4,video/webm,video/quicktime" multiple onChange={chooseFiles} aria-label="选择要导入本地库的视频" />

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
            {libraryView === 'server' && syncStatus?.enabled ? <ServerLibrary status={syncStatus} onRefresh={refreshSync} onPlay={(id) => void playCached(id)} /> : <>
            {error && <div role="alert" className={styles.errorBanner}>{error}<button onClick={() => void refresh()}>重试</button></div>}

            {selected && <section ref={playerSection} className={styles.watchSection} aria-label="本地视频播放器">
              <div className={styles.watchTopline}><button className={styles.textButton} onClick={() => selectEntry(null)}><LibraryIcon name="arrow" />返回片库</button><span>{onThisMac ? '本地播放' : '服务器播放'} · {selected.format}</span></div>
              <LocalPlayer key={selected.id} entry={selected} episodes={selectedEpisodes} onSelect={selectEntry} onProgress={updateProgress} isLocalService={onThisMac} />
            </section>}
            {selectedId && !selected && !loading && <div className={styles.errorBanner}>这部视频尚未入库或已不在当前片库中。<button onClick={() => selectEntry(null)}>返回片库</button></div>}

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

              {items.length === 0 ? <StatePanel icon="film" title="暂无影片" description=""><button className={styles.primaryButton} onClick={() => fileInput.current?.click()}><LibraryIcon name="upload" />导入视频</button><Link className={styles.secondaryButton} href="/">发现影片<LibraryIcon name="arrow" className={styles.forwardArrow} /></Link></StatePanel> : shown.length === 0 ? <StatePanel icon="search" title={query ? `未找到“${query}”` : `暂无${filter === 'tv' ? '电视剧' : '电影'}`} description="" /> : <div className={styles.posterGrid}>{shown.map(({ id, entry, episodes }) => {
                const resume = [...episodes].filter(unfinished).sort((a, b) => (b.lastPlayedAt || '').localeCompare(a.lastPlayedAt || ''))[0];
                const target = resume || episodes[0];
                return <button key={id} className={styles.movieCard} onClick={() => selectEntry(target.id)} aria-label={`${resume ? '继续观看' : '播放'} ${entry.title}${entry.kind === 'tv' ? `，已存 ${episodes.length} 集` : ''}`}>
                  <div className={styles.posterWrap}><Poster entry={entry} /><span className={styles.formatBadge}>{entry.kind === 'tv' ? `${episodes.length} 集已存` : entry.format}</span><div className={styles.posterHover}><span className={styles.posterPlay}><LibraryIcon name="play" /></span><span>{resume ? '继续观看' : '立即播放'}</span></div>{percentPlayed(target) > 0 && <div className={styles.cardProgress}><i style={{ width: `${percentPlayed(target)}%` }} /></div>}</div>
                  <strong className={styles.movieTitle}>{entry.title}</strong><span className={styles.movieMeta}>{entry.year && `${entry.year} · `}{entry.kind === 'tv' ? `${new Set(episodes.map((episode) => episode.seasonNumber || 1)).size} 季 · 电视剧` : sizeLabel(entry.bytes)}{entry.kind === 'movie' && percentPlayed(entry) >= 98 ? ' · 已看完' : ''}</span>
                </button>;
              })}</div>}
              {items.length > 0 && <p className={styles.libraryFootnote}><LibraryIcon name="folder" /><span>{movieCount} 部电影，{tvCount} 部电视剧 · 共 {items.length} 个视频 · {sizeLabel(items.reduce((sum, item) => sum + item.bytes, 0))}</span><span className={styles.offlineNote}>{onThisMac ? '断网也可播放' : '保存到设备后可离线观看'}</span></p>}
            </section>
            </>}
          </>
        )}

        {importError && importItems.length === 0 && <p role="alert" className={styles.errorBanner}>{importError}</p>}
      </main>

      {importItems.length > 0 && <ImportDialog items={importItems} importing={importing} error={importError} onChange={updateImport} onStart={() => void startImport()} onClose={() => setImportItems([])} />}
    </div>
  );
}

function StatePanel({ icon, title, description, children }: { icon: LibraryIconName; title: string; description: string; children?: ReactNode }) {
  return <div className={styles.statePanel}><span className={styles.stateIcon}><LibraryIcon name={icon} /></span><h2>{title}</h2><p>{description}</p>{children && <div className={styles.stateActions}>{children}</div>}</div>;
}

function LocalPlayer({ entry, episodes, onSelect, onProgress, isLocalService }: { entry: LibraryEntry; episodes: LibraryEntry[]; onSelect: (id: string) => void; onProgress: (id: string, position: number, duration: number) => void; isLocalService: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const playback = useRef({ loaded: false, position: 0, duration: 0 });
  const lastSaved = useRef({ position: entry.position || 0, duration: entry.duration || 0, sequence: 0 });
  const savesInFlight = useRef(new Map<number, string>());
  const saveRequested = useRef(false);
  const saveSequence = useRef(0);
  const latestSave = useRef<(keepalive?: boolean) => void>(() => {});
  const [playError, setPlayError] = useState('');
  const [saveError, setSaveError] = useState(false);
  const [ended, setEnded] = useState(false);
  const [season, setSeason] = useState(entry.seasonNumber || 1);
  const currentIndex = episodes.findIndex((item) => item.id === entry.id);
  const previous = episodes[currentIndex - 1];
  const next = episodes[currentIndex + 1];
  const seasons = [...new Set(episodes.map((item) => item.seasonNumber || 1))].sort((a, b) => a - b);
  const downloadUrl = `${entry.mediaUrl}${entry.mediaUrl.includes('?') ? '&' : '?'}download=1`;

  const save = useCallback((keepalive = false) => {
    const state = playback.current;
    if (!state.loaded || !Number.isFinite(state.position) || !Number.isFinite(state.duration) || state.duration <= 0) return;
    const { position, duration } = state;
    // An idle player must not generate a new lastPlayedAt every five seconds.
    // A failed write leaves this snapshot unchanged, so the next event/timer retries it.
    const snapshotKey = `${position}:${duration}`;
    if ([...savesInFlight.current.values()].includes(snapshotKey)) return;
    if (!keepalive && savesInFlight.current.size > 0) { saveRequested.current = true; return; }
    if (!savesInFlight.current.size && position === lastSaved.current.position && duration === lastSaved.current.duration) return;
    saveRequested.current = false;
    const sequence = ++saveSequence.current;
    savesInFlight.current.set(sequence, snapshotKey);
    if (!keepalive) onProgress(entry.id, position, duration);
    let succeeded = false;
    void fetch(`/api/library/${encodeURIComponent(entry.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      // All writes are small. Keep an already in-flight final snapshot alive when the window closes.
      body: JSON.stringify({ position, duration }), keepalive: true,
    }).then((response) => {
      succeeded = response.ok;
      if (response.ok && sequence >= lastSaved.current.sequence) lastSaved.current = { position, duration, sequence };
      if (!keepalive) setSaveError(!response.ok);
    }).catch(() => { if (!keepalive) setSaveError(true); }).finally(() => {
      savesInFlight.current.delete(sequence);
      // Coalesce rapid seek/pause events, then persist the newest changed position after success.
      if (succeeded && !keepalive && saveRequested.current) {
        saveRequested.current = false;
        latestSave.current();
      }
    });
  }, [entry.id, onProgress]);
  useEffect(() => { latestSave.current = save; }, [save]);

  useEffect(() => {
    const media = video.current;
    const state = playback.current;
    const incoming = entry.position || 0;
    if (!media || !state.loaded || !media.paused || !Number.isFinite(media.duration) || media.duration <= 0
      || !Number.isFinite(incoming) || savesInFlight.current.size > 0 || saveRequested.current) return;
    // Preserve unsaved local work. A clean, paused player can adopt progress
    // received from a disk refresh without treating the remote seek as new viewing.
    if (state.position !== lastSaved.current.position || state.duration !== lastSaved.current.duration) return;
    const target = Math.max(0, Math.min(incoming, media.duration));
    if (Math.abs(target - media.currentTime) <= 1) return;
    media.currentTime = target;
    playback.current = { loaded: true, position: media.currentTime, duration: media.duration };
    lastSaved.current = { ...lastSaved.current, position: media.currentTime, duration: media.duration };
  }, [entry.position, entry.duration, entry.lastPlayedAt]);

  useEffect(() => {
    const interval = window.setInterval(() => save(), 5000);
    const onPageHide = () => save(true);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('pagehide', onPageHide);
      save(true);
    };
  }, [save]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || target?.closest('input, select, textarea, button, a, [contenteditable="true"]')) return;
      const media = video.current;
      if (!media) return;
      const consume = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.altKey && event.key === 'ArrowRight' && next) { consume(); onSelect(next.id); return; }
      if (event.altKey && event.key === 'ArrowLeft' && previous) { consume(); onSelect(previous.id); return; }
      if (event.altKey) return;
      if (event.code === 'Space') { consume(); if (!event.repeat) { if (media.paused) void media.play().catch(() => {}); else media.pause(); } }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { consume(); media.currentTime = Math.max(0, Math.min(media.duration || Infinity, media.currentTime + (event.key === 'ArrowRight' ? 5 : -5))); }
      if (event.key.toLowerCase() === 'f') { consume(); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); else void media.requestFullscreen?.().catch(() => {}); }
    };
    // Capture before native video controls; otherwise one key can be handled twice.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, previous, onSelect]);

  const syncPlayback = (element: HTMLVideoElement) => {
    playback.current = { loaded: playback.current.loaded, position: element.currentTime, duration: element.duration };
  };

  return <div className={styles.playerLayout}>
    <div className={styles.playerMain}>
      <div className={styles.videoFrame}>
        <video ref={video} className={styles.video} src={entry.mediaUrl} controls autoPlay playsInline preload="metadata" tabIndex={0}
          onLoadedMetadata={(event) => {
            const media = event.currentTarget;
            const saved = entry.position || 0;
            if (saved > 0 && saved < media.duration - 5) media.currentTime = saved;
            playback.current.loaded = true;
            syncPlayback(media);
            if (!document.activeElement?.closest('input, select, textarea, [contenteditable="true"], [role="dialog"]')) media.focus({ preventScroll: true });
          }}
          onTimeUpdate={(event) => syncPlayback(event.currentTarget)}
          onPause={(event) => { syncPlayback(event.currentTarget); save(); }}
          onSeeked={(event) => { syncPlayback(event.currentTarget); save(); }}
          onEnded={(event) => { syncPlayback(event.currentTarget); save(); setEnded(true); }}
          onPlaying={() => { setEnded(false); setPlayError(''); }}
          onError={() => setPlayError('此格式无法播放')}
          aria-label={`${entry.title} ${entry.kind === 'tv' ? episodeLabel(entry) : ''}`} />
        {playError && <div className={styles.videoMessage} role="alert"><LibraryIcon name="film" /><p>{playError}</p><a href={downloadUrl} download className={styles.secondaryButton}>保存视频到设备</a></div>}
        {ended && next && <div className={styles.endedMessage}><p>本集已播放完</p><button className={styles.primaryButton} onClick={() => onSelect(next.id)}><LibraryIcon name="next" />播放下一集</button></div>}
      </div>
      <div className={styles.playbackBar}><span>{entry.kind === 'tv' ? episodeLabel(entry) : '电影'} · {sizeLabel(entry.bytes)}</span>{entry.kind === 'tv' && <div><button disabled={!previous} onClick={() => previous && onSelect(previous.id)}><LibraryIcon name="previous" />上一集</button><button disabled={!next} onClick={() => next && onSelect(next.id)}>下一集<LibraryIcon name="next" /></button></div>}</div>
      {saveError && <p className={styles.progressError} role="status">进度保存失败</p>}

      <div className={styles.deviceDownload}><a href={downloadUrl} download className={styles.secondaryButton}><LibraryIcon name="folder" />保存视频到设备</a><p>Files / VLC 不同步进度</p></div>
    </div>
    <aside className={styles.playerDetails}>
      <p className={styles.smallEyebrow}>{entry.kind === 'tv' ? '电视剧' : '电影'}</p><h2>{entry.title}</h2>
      <p className={styles.detailMeta}>{[entry.year, entry.format, entry.kind === 'tv' ? `${episodes.length} 集已入库` : entry.duration ? timeLabel(entry.duration) : '本地收藏'].filter(Boolean).join(' · ')}</p>
      {entry.kind === 'tv' ? <div className={styles.episodeArea}>
        <div className={styles.episodeHeading}><h3>本地选集</h3>{seasons.length > 1 ? <select aria-label="选择季" value={season} onChange={(event) => setSeason(Number(event.target.value))}>{seasons.map((number) => <option key={number} value={number}>第 {number} 季</option>)}</select> : <span>第 {seasons[0]} 季</span>}</div>
        <div className={styles.episodeList}>{episodes.filter((item) => (item.seasonNumber || 1) === season).map((item, index) => <button key={item.id} className={item.id === entry.id ? styles.activeEpisode : ''} onClick={() => onSelect(item.id)} aria-current={item.id === entry.id ? 'true' : undefined}><span className={styles.episodeNumber}>{String(item.episodeNumber || index + 1).padStart(2, '0')}</span><span className={styles.episodeInfo}><strong>{item.episodeTitle || `第 ${item.episodeNumber || index + 1} 集`}</strong><small>{item.id === entry.id ? '正在播放' : percentPlayed(item) >= 98 ? '已看完' : unfinished(item) ? `已观看 ${timeLabel(item.position)}` : sizeLabel(item.bytes)}</small></span>{item.id === entry.id ? <span className={styles.equalizer}><i /><i /><i /></span> : <LibraryIcon name="play" />}</button>)}</div>
      </div> : <div className={styles.movieStorage}><LibraryIcon name="check" /><div><strong>{isLocalService ? '已保存到本地' : '已入库'}</strong></div></div>}
    </aside>
  </div>;
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
        <div className={styles.importFields}><label className={styles.titleField}>片名<input aria-label={`${item.file.name} 的片名`} value={item.metadata.title} maxLength={200} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { title: event.target.value })} /></label><label>分类<select aria-label={`${item.file.name} 的分类`} value={item.metadata.kind} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { kind: event.target.value as LibraryKind, ...(event.target.value === 'tv' ? { seasonNumber: item.metadata.seasonNumber || 1, episodeNumber: item.metadata.episodeNumber || index + 1 } : {}) })}><option value="movie">电影</option><option value="tv">电视剧</option></select></label>{item.metadata.kind === 'tv' && <><label className={styles.numberField}>季<input type="number" min="1" max="999" aria-label={`${item.file.name} 的季数`} value={item.metadata.seasonNumber || 1} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { seasonNumber: Math.max(1, Number(event.target.value) || 1) })} /></label><label className={styles.numberField}>集<input type="number" min="1" max="9999" aria-label={`${item.file.name} 的集数`} value={item.metadata.episodeNumber || index + 1} disabled={importing || item.state === 'done'} onChange={(event) => onChange(index, { episodeNumber: Math.max(1, Number(event.target.value) || 1) })} /></label></>}</div>
        {(item.state === 'uploading' || item.state === 'done') && <div className={styles.importProgress}><div className={styles.progressTrack}><i style={{ width: `${item.progress}%` }} /></div><span>{item.state === 'done' ? '已入库' : `${Math.round(item.progress)}%`}</span></div>}
        {item.error && <p className={styles.importRowError} role="alert">{item.error}</p>}
      </div>)}</div>
      <div className={styles.dialogFooter}><span>{items.filter((item) => item.state === 'done').length} / {items.length} 个视频已入库</span>{done ? <button className={styles.primaryButton} onClick={onClose}>打开片库<LibraryIcon name="arrow" className={styles.forwardArrow} /></button> : <button className={styles.primaryButton} disabled={importing || items.some((item) => !item.metadata.title.trim())} onClick={onStart}><LibraryIcon name="upload" />{importing ? '导入中…' : items.some((item) => item.state === 'error') ? '重试' : '确认导入'}</button>}</div>
    </div>
  </div>;
}
