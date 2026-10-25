'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryEntry } from '@/lib/local-library/types';
import { LibraryIcon, episodeLabel, percentPlayed, plainDescription, timeLabel, unfinished } from './library-ui';
import styles from './library.module.css';

export function LibraryPlayer({ entry, episodes, onSelect, onProgress }: { entry: LibraryEntry; episodes: LibraryEntry[]; onSelect: (id: string) => void; onProgress: (id: string, position: number, duration: number) => void }) {
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
      <div className={styles.playbackBar}>
        {entry.kind === 'tv' && <div><button disabled={!previous} onClick={() => previous && onSelect(previous.id)}><LibraryIcon name="previous" />上一集</button><button disabled={!next} onClick={() => next && onSelect(next.id)}>下一集<LibraryIcon name="next" /></button></div>}
        <a href={downloadUrl} download className={styles.secondaryButton} title="Files / VLC 中的播放进度不会同步"><LibraryIcon name="folder" />保存视频到设备</a>
      </div>
      {saveError && <p className={styles.progressError} role="status">进度保存失败</p>}
    </div>
    <aside className={styles.playerDetails}>
      <p className={styles.smallEyebrow}>{entry.kind === 'tv' ? '电视剧' : '电影'}</p><h1>{entry.title}</h1>
      <p className={styles.detailMeta}>{[entry.year, entry.kind === 'tv' ? episodeLabel(entry) : entry.duration ? timeLabel(entry.duration) : ''].filter(Boolean).join(' · ')}</p>
      {entry.episodeTitle && <p className={styles.episodeTitle}>{entry.episodeTitle}</p>}
      {entry.description && <p className={styles.synopsis}>{plainDescription(entry.description)}</p>}
    </aside>
    {entry.kind === 'tv' && <section className={`${styles.episodeArea} ${styles.playerEpisodes}`} aria-label="剧集选择">
      <div className={styles.episodeHeading}><h2>选集</h2>{seasons.length > 1 ? <select aria-label="选择季" value={season} onChange={(event) => setSeason(Number(event.target.value))}>{seasons.map((number) => <option key={number} value={number}>第 {number} 季</option>)}</select> : <span>第 {seasons[0]} 季</span>}</div>
      <div className={styles.episodeList}>{episodes.filter((item) => (item.seasonNumber || 1) === season).map((item, index) => <button key={item.id} className={item.id === entry.id ? styles.activeEpisode : ''} onClick={() => item.id !== entry.id && onSelect(item.id)} aria-current={item.id === entry.id ? 'true' : undefined}><span className={styles.episodeNumber}>{String(item.episodeNumber || index + 1).padStart(2, '0')}</span><span className={styles.episodeInfo}><strong>{item.episodeTitle || `第 ${item.episodeNumber || index + 1} 集`}</strong>{(item.id === entry.id || percentPlayed(item) >= 98 || unfinished(item)) && <small>{item.id === entry.id ? '正在播放' : percentPlayed(item) >= 98 ? '已看完' : `已观看 ${timeLabel(item.position)}`}</small>}</span>{item.id === entry.id ? <span className={styles.equalizer}><i /><i /><i /></span> : <LibraryIcon name="play" />}</button>)}</div>
    </section>}
  </div>;
}

