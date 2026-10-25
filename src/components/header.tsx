'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ThemeToggle } from './theme';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon, type IconName } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';
import { fetchLibrarySync } from '@/lib/library-sync-client';
import { useAuth } from './auth';
import { APP_NAME } from '@/lib/brand';

interface LibraryNavigation {
  filter: 'all' | 'movie' | 'tv';
  onFilter: (filter: 'all' | 'movie' | 'tv') => void;
  view: 'local' | 'server';
  onView: (view: 'local' | 'server') => void;
  hasServer: boolean;
}

export function Header({ showSearch = false, libraryNavigation }: { showSearch?: boolean; libraryNavigation?: LibraryNavigation }) {
  const router = useRouter();
  const pathname = usePathname();
  const { verified } = useAuth();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchHistory = useSearchHistory(query);
  const serverCapability = useQuery({
    queryKey: ['library-server-capability'],
    queryFn: fetchLibrarySync,
    enabled: verified && !libraryNavigation,
    staleTime: 60_000,
    retry: false,
  });
  const hasServer = verified && (libraryNavigation?.hasServer ?? serverCapability.data?.enabled ?? false);
  const inLibrary = pathname === '/library';
  const inLibraryPlayer = pathname.startsWith('/library/play/');
  const title = inLibraryPlayer || pathname === '/watch' ? '播放' : inLibrary ? '影视库' : pathname === '/' ? '发现' : pathname === '/live' ? '直播' : APP_NAME;

  useEffect(() => {
    if (!sidebarOpen) return;
    const sidebar = document.getElementById('app-sidebar');
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
      if (event.key !== 'Tab') return;
      const controls = sidebar?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !sidebar?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !sidebar?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const media = window.matchMedia('(max-width: 760px)');
    const onResize = () => { if (!media.matches) setSidebarOpen(false); };
    media.addEventListener('change', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      media.removeEventListener('change', onResize);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [sidebarOpen]);

  useEffect(() => {
    const onShowSettings = () => setSettingsOpen(true);
    window.addEventListener('libretv:show-settings', onShowSettings);
    return () => window.removeEventListener('libretv:show-settings', onShowSettings);
  }, []);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    searchHistory.record(q);
  };
  const pickHistory = (text: string) => { setQuery(text); submitSearch(text); };
  const selectFilter = (filter: 'all' | 'movie' | 'tv') => {
    setSidebarOpen(false);
    if (libraryNavigation) { libraryNavigation.onView('local'); libraryNavigation.onFilter(filter); }
    else router.push(`/library${filter === 'all' ? '' : `?kind=${filter}`}`);
  };
  const selectServer = () => {
    if (libraryNavigation) libraryNavigation.onView('server');
    else router.push('/library?view=server');
  };
  const navButton = (label: string, icon: IconName, onClick: () => void, active?: boolean) => <button type="button" className={cn('mac-nav-item', active && 'is-active')} onClick={() => { onClick(); setSidebarOpen(false); }} aria-pressed={active}><Icon name={icon} /><span>{label}</span></button>;

  return <>
    {sidebarOpen && <button type="button" className="mac-sidebar-overlay" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
    <aside id="app-sidebar" className={cn('mac-sidebar', sidebarOpen && 'is-open')} aria-label="主导航" role={sidebarOpen ? 'dialog' : undefined} aria-modal={sidebarOpen || undefined}>
      <Link href="/library" className="mac-brand" onClick={() => setSidebarOpen(false)}><Image className="mac-brand-icon" src="/icons/mark.svg" width={32} height={32} alt="" priority /><strong>{APP_NAME}</strong></Link>
      <nav className="mac-sidebar-nav">
        <p className="mac-nav-label">浏览</p>
        <Link href="/" className={cn('mac-nav-item', pathname === '/' && 'is-active')} onClick={() => setSidebarOpen(false)}><Icon name="search" /><span>发现</span></Link>
        <p className="mac-nav-label">资料库</p>
        {navButton('全部影片', 'library', () => selectFilter('all'), inLibrary && libraryNavigation?.view !== 'server' && (!libraryNavigation || libraryNavigation.filter === 'all'))}
        {navButton('电影', 'film', () => selectFilter('movie'), inLibrary && libraryNavigation?.view !== 'server' && libraryNavigation?.filter === 'movie')}
        {navButton('电视剧', 'tv', () => selectFilter('tv'), inLibrary && libraryNavigation?.view !== 'server' && libraryNavigation?.filter === 'tv')}
        {hasServer && navButton('服务器片库', 'server', selectServer, inLibrary && libraryNavigation?.view === 'server')}
        {navButton('下载', 'download', requestShowDownloadManager)}
        {navButton('观看历史', 'clock', () => setHistoryOpen(true))}
        <p className="mac-nav-label">更多</p>
        <Link href="/live" className={cn('mac-nav-item', pathname === '/live' && 'is-active')} onClick={() => setSidebarOpen(false)}><Icon name="bolt" /><span>直播</span></Link>
      </nav>
      <div className="mac-sidebar-bottom">{navButton('设置', 'gear', () => setSettingsOpen(true))}<Link href="/about" className="mac-about">关于{APP_NAME}</Link></div>
    </aside>
    <header className="mac-appbar">
      <div className="mac-toolbar-leading"><IconButton label="显示侧栏" onClick={() => setSidebarOpen(!sidebarOpen)} expanded={sidebarOpen} className="mac-sidebar-toggle"><Icon name="sidebar" /></IconButton><span className="mac-toolbar-title">{title}</span></div>
      {(showSearch || (!inLibrary && !inLibraryPlayer)) && pathname !== '/' && <form className="mac-toolbar-search" onSubmit={(event) => { event.preventDefault(); submitSearch(query); }}><div ref={searchHistory.containerRef} className="relative"><Icon name="search" /><input value={query} onChange={(event) => { setQuery(event.target.value); searchHistory.resetActive(); }} onFocus={searchHistory.onFocus} onKeyDown={(event) => searchHistory.onKeyDown(event, pickHistory)} placeholder="搜索影片" aria-label="搜索影片" role="combobox" aria-expanded={searchHistory.visible} aria-controls="header-search-history" aria-autocomplete="list" aria-activedescendant={searchHistory.visible && searchHistory.activeIndex >= 0 ? `header-search-history-${searchHistory.activeIndex}` : undefined} />{searchHistory.visible && <SearchHistoryDropdown id="header-search-history" matches={searchHistory.matches} activeIndex={searchHistory.activeIndex} onPick={pickHistory} onRemove={searchHistory.remove} onClearAll={searchHistory.clearAll} />}</div></form>}
      <div className="mac-toolbar-actions"><ThemeToggle /><IconButton label="下载管理" onClick={requestShowDownloadManager}><Icon name="download" /></IconButton><IconButton label="设置" onClick={() => setSettingsOpen(true)}><Icon name="gear" /></IconButton></div>
    </header>
    <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
  </>;
}

export function requestShowSettings(): void {
  window.dispatchEvent(new CustomEvent('libretv:show-settings'));
}

function IconButton({ label, onClick, children, expanded, className }: { label: string; onClick: () => void; children: ReactNode; expanded?: boolean; className?: string }) {
  return <button type="button" className={cn('mac-icon-button', className)} title={label} aria-label={label} aria-expanded={expanded} aria-controls={expanded !== undefined ? 'app-sidebar' : undefined} onClick={onClick}>{children}</button>;
}
