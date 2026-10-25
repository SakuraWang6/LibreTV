import type { ReactNode } from 'react';
import type { LibraryEntry } from '@/lib/local-library/types';

export type LibraryIconName = 'play' | 'folder' | 'search' | 'upload' | 'close' | 'arrow' | 'next' | 'previous' | 'check' | 'film';

export function LibraryIcon({ name, className = '' }: { name: LibraryIconName; className?: string }) {
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

export function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function timeLabel(seconds = 0): string {
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${minutes} 分钟`;
}

export function episodeLabel(entry: LibraryEntry): string {
  if (entry.kind !== 'tv') return entry.year || '电影';
  const season = entry.seasonNumber ? `第 ${entry.seasonNumber} 季 · ` : '';
  return `${season}${entry.episodeNumber ? `第 ${entry.episodeNumber} 集` : entry.episodeTitle || '剧集'}`;
}

export function percentPlayed(entry: LibraryEntry): number {
  return entry.duration ? Math.min(100, Math.max(0, ((entry.position || 0) / entry.duration) * 100)) : 0;
}

export function unfinished(entry: LibraryEntry): boolean {
  return (entry.position || 0) > 3 && (!entry.duration || (entry.position || 0) < entry.duration - 10);
}

export function plainDescription(description: string): string {
  return description.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

export function orderedEpisodes(items: LibraryEntry[]): LibraryEntry[] {
  return [...items].sort((a, b) => (a.seasonNumber || 1) - (b.seasonNumber || 1) || (a.episodeNumber || 0) - (b.episodeNumber || 0) || a.createdAt.localeCompare(b.createdAt));
}

