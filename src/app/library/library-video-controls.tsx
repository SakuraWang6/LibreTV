'use client';

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react';
import { formatTime } from '@/lib/utils';
import { createLibraryPreviewClient } from './library-preview-client';
import { createControlAutoHide } from './library-control-visibility';
import styles from './library.module.css';

const fullscreenOverflow = new WeakMap<HTMLElement, string>();
const fullscreenRequests = new WeakMap<HTMLElement, symbol>();
const FULLSCREEN_EVENT = 'library-fullscreen-change';

export function releaseLibraryFullscreen(frame: HTMLElement) {
  fullscreenRequests.delete(frame);
  if (frame.dataset.fullscreen === 'true') {
    delete frame.dataset.fullscreen;
    frame.ownerDocument.body.style.overflow = fullscreenOverflow.get(frame) ?? '';
    fullscreenOverflow.delete(frame);
    frame.dispatchEvent(new Event(FULLSCREEN_EVENT));
  }
  if (frame.ownerDocument.fullscreenElement === frame) void frame.ownerDocument.exitFullscreen().catch(() => {});
}

export async function toggleLibraryFullscreen(frame: HTMLElement) {
  if (!frame.isConnected) return;
  if (frame.ownerDocument.fullscreenElement === frame || frame.dataset.fullscreen === 'true' || fullscreenRequests.has(frame)) {
    releaseLibraryFullscreen(frame);
    return;
  }
  if (frame.requestFullscreen) {
    const request = Symbol();
    fullscreenRequests.set(frame, request);
    try {
      await frame.requestFullscreen();
      if (fullscreenRequests.get(frame) !== request || !frame.isConnected) releaseLibraryFullscreen(frame);
      return;
    } catch {
      if (fullscreenRequests.get(frame) !== request || !frame.isConnected) return;
    } finally { if (fullscreenRequests.get(frame) === request) fullscreenRequests.delete(frame); }
  }
  fullscreenOverflow.set(frame, frame.ownerDocument.body.style.overflow);
  frame.ownerDocument.body.style.overflow = 'hidden';
  frame.dataset.fullscreen = 'true';
  frame.dispatchEvent(new Event(FULLSCREEN_EVENT));
}

type MediaState = { position: number; duration: number; buffered: number; paused: boolean; muted: boolean; volume: number; rate: number };
type Hover = { time: number; bucket: number; left: number };
const INITIAL_MEDIA: MediaState = { position: 0, duration: 0, buffered: 0, paused: true, muted: false, volume: 1, rate: 1 };

function ControlIcon({ name }: { name: 'play' | 'pause' | 'back' | 'forward' | 'volume' | 'mute' | 'fullscreen' | 'exit' }) {
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'play' ? <path d="m8 5 11 7-11 7V5Z" /> : name === 'pause' ? <path d="M8 5v14M16 5v14" />
      : name === 'back' || name === 'forward' ? <><path d={name === 'back' ? 'M7 7H3V3m0 4a9 9 0 1 1 0 10' : 'M17 7h4V3m0 4a9 9 0 1 0 0 10'} /><text x="12" y="16" textAnchor="middle" fill="currentColor" stroke="none" fontSize="11" fontWeight="600">5</text></>
      : name === 'volume' || name === 'mute' ? <><path d="m11 4-6 5H2v6h3l6 5V4Z" />{name === 'mute' ? <path d="m16 9 6 6m0-6-6 6" /> : <><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>}</>
      : <path d={name === 'fullscreen' ? 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5' : 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5'} />}
  </svg>;
}

function usePreview(libraryId: string, bucket?: number) {
  const client = useRef<ReturnType<typeof createLibraryPreviewClient> | null>(null);
  const [preview, setPreview] = useState<{ libraryId: string; bucket: number; url: string }>();
  useEffect(() => {
    const current = createLibraryPreviewClient(libraryId);
    client.current = current;
    return () => { current.dispose(); if (client.current === current) client.current = null; };
  }, [libraryId]);
  useEffect(() => {
    setPreview(undefined);
    if (bucket === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void client.current?.get(bucket, controller.signal).then((url) => {
        if (url && !controller.signal.aborted) setPreview({ libraryId, bucket, url });
      });
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [libraryId, bucket]);
  return preview?.libraryId === libraryId && preview.bucket === bucket ? preview.url : undefined;
}

/** Video clocks stay inside this component rather than rerendering the library page. */
export function LibraryVideoControls({ libraryId, video, frame }: { libraryId: string; video: RefObject<HTMLVideoElement | null>; frame: RefObject<HTMLDivElement | null> }) {
  const [state, setState] = useState(INITIAL_MEDIA);
  const [fullscreen, setFullscreen] = useState(false);
  const [hover, setHover] = useState<Hover>();
  const [imageFailed, setImageFailed] = useState(false);
  const rail = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const preview = usePreview(libraryId, hover?.bucket);
  useEffect(() => setImageFailed(false), [preview]);

  useEffect(() => {
    const media = video.current;
    const surface = frame.current;
    if (!media || !surface) return;
    setHover(undefined);
    dragging.current = false;
    const sync = () => {
      const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
      let buffered = 0;
      for (let index = 0; index < media.buffered.length; index++) {
        if (media.buffered.start(index) <= media.currentTime && media.buffered.end(index) >= media.currentTime) buffered = media.buffered.end(index);
      }
      const next = { position: Number.isFinite(media.currentTime) ? media.currentTime : 0, duration, buffered, paused: media.paused, muted: media.muted, volume: media.volume, rate: media.playbackRate };
      setState((previous) => Object.keys(next).every((key) => next[key as keyof MediaState] === previous[key as keyof MediaState]) ? previous : next);
    };
    const syncFullscreen = () => setFullscreen(surface.ownerDocument.fullscreenElement === surface || surface.dataset.fullscreen === 'true');
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && surface.dataset.fullscreen === 'true') releaseLibraryFullscreen(surface); };
    const endDrag = (event: globalThis.PointerEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      const bounds = rail.current?.getBoundingClientRect();
      if (event.type === 'pointercancel' || event.pointerType !== 'mouse' || !bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setHover(undefined);
    };
    const cancelInteraction = () => { dragging.current = false; setHover(undefined); };
    const hidden = () => { if (surface.ownerDocument.visibilityState === 'hidden') cancelInteraction(); };
    const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'progress', 'play', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied'] as const;
    for (const event of events) media.addEventListener(event, sync);
    surface.ownerDocument.addEventListener('fullscreenchange', syncFullscreen);
    surface.ownerDocument.addEventListener('keydown', escape);
    surface.ownerDocument.addEventListener('pointerup', endDrag);
    surface.ownerDocument.addEventListener('pointercancel', endDrag);
    surface.ownerDocument.addEventListener('visibilitychange', hidden);
    surface.ownerDocument.defaultView?.addEventListener('blur', cancelInteraction);
    surface.addEventListener(FULLSCREEN_EVENT, syncFullscreen);
    sync(); syncFullscreen();
    return () => {
      for (const event of events) media.removeEventListener(event, sync);
      surface.ownerDocument.removeEventListener('fullscreenchange', syncFullscreen);
      surface.ownerDocument.removeEventListener('keydown', escape);
      surface.ownerDocument.removeEventListener('pointerup', endDrag);
      surface.ownerDocument.removeEventListener('pointercancel', endDrag);
      surface.ownerDocument.removeEventListener('visibilitychange', hidden);
      surface.ownerDocument.defaultView?.removeEventListener('blur', cancelInteraction);
      surface.removeEventListener(FULLSCREEN_EVENT, syncFullscreen);
    };
  }, [video, frame, libraryId]);

  useEffect(() => {
    const media = video.current;
    const surface = frame.current;
    const panel = controls.current;
    if (!media || !surface || !panel) return;
    const document = surface.ownerDocument;
    const window = document.defaultView;
    let keyboardFocus = false;
    let windowActive = true;
    const idle = createControlAutoHide((visible) => {
      if (visible) delete surface.dataset.controlsHidden;
      else surface.dataset.controlsHidden = 'true';
    });
    const focus = () => idle.hold('focus', windowActive && keyboardFocus && panel.contains(document.activeElement));
    const activity = () => idle.activity();
    const pointerActivity = (event: globalThis.PointerEvent) => {
      idle.activity();
      if (event.pointerType === 'mouse') {
        const bounds = panel.getBoundingClientRect();
        idle.hold('hover', event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
      }
    };
    const playback = () => idle.setPaused(media.paused || media.ended);
    const pointerMode = () => { keyboardFocus = false; focus(); };
    const down = (event: globalThis.PointerEvent) => {
      idle.activity();
      if (panel.contains(event.target as Node)) idle.hold('pointer', true);
    };
    const enter = (event: globalThis.PointerEvent) => { if (event.pointerType === 'mouse') idle.hold('hover', true); };
    const leave = () => idle.hold('hover', false);
    const release = (event: globalThis.PointerEvent) => {
      idle.hold('pointer', false);
      const bounds = panel.getBoundingClientRect();
      if (event.type === 'pointercancel' || event.pointerType !== 'mouse' || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) leave();
    };
    const key = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (event.key === 'Tab' || panel.contains(target)) keyboardFocus = true;
      if (surface.contains(target) || panel.contains(document.activeElement)) { focus(); idle.activity(); }
    };
    const focusOut = () => queueMicrotask(focus);
    const blur = () => { windowActive = false; idle.hold('pointer', false); leave(); focus(); idle.activity(); };
    const resume = () => { windowActive = true; focus(); idle.activity(); };
    const visibility = () => idle.hold('hidden', document.visibilityState === 'hidden');
    const waiting = () => idle.hold('waiting', true);
    const ready = () => idle.hold('waiting', false);
    surface.addEventListener('pointermove', pointerActivity);
    surface.addEventListener('pointerdown', down);
    surface.addEventListener(FULLSCREEN_EVENT, activity);
    panel.addEventListener('pointerenter', enter);
    panel.addEventListener('pointerleave', leave);
    panel.addEventListener('focusin', focus);
    panel.addEventListener('focusout', focusOut);
    document.addEventListener('pointerdown', pointerMode, true);
    document.addEventListener('pointerup', release);
    document.addEventListener('pointercancel', release);
    document.addEventListener('fullscreenchange', activity);
    document.addEventListener('visibilitychange', visibility);
    window?.addEventListener('keydown', key, true);
    window?.addEventListener('blur', blur);
    window?.addEventListener('focus', resume);
    for (const event of ['play', 'pause', 'ended'] as const) media.addEventListener(event, playback);
    media.addEventListener('seeking', activity);
    media.addEventListener('waiting', waiting);
    media.addEventListener('playing', ready);
    media.addEventListener('canplay', ready);
    playback(); visibility();
    return () => {
      idle.dispose();
      delete surface.dataset.controlsHidden;
      surface.removeEventListener('pointermove', pointerActivity);
      surface.removeEventListener('pointerdown', down);
      surface.removeEventListener(FULLSCREEN_EVENT, activity);
      panel.removeEventListener('pointerenter', enter);
      panel.removeEventListener('pointerleave', leave);
      panel.removeEventListener('focusin', focus);
      panel.removeEventListener('focusout', focusOut);
      document.removeEventListener('pointerdown', pointerMode, true);
      document.removeEventListener('pointerup', release);
      document.removeEventListener('pointercancel', release);
      document.removeEventListener('fullscreenchange', activity);
      document.removeEventListener('visibilitychange', visibility);
      window?.removeEventListener('keydown', key, true);
      window?.removeEventListener('blur', blur);
      window?.removeEventListener('focus', resume);
      for (const event of ['play', 'pause', 'ended'] as const) media.removeEventListener(event, playback);
      media.removeEventListener('seeking', activity);
      media.removeEventListener('waiting', waiting);
      media.removeEventListener('playing', ready);
      media.removeEventListener('canplay', ready);
    };
  }, [video, frame, libraryId]);

  const seek = (position: number) => {
    const media = video.current;
    if (media && state.duration > 0) media.currentTime = Math.max(0, Math.min(state.duration, position));
  };
  const activate = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    action();
    // Pointer use should not strand transport shortcuts on a button. Tab stays on controls.
    if (event.detail > 0) video.current?.focus({ preventScroll: true });
  };
  const showPreview = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!state.duration || !bounds.width) return;
    const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
    const time = Math.min(Math.max(0, state.duration - 0.01), x / bounds.width * state.duration);
    setHover({ time, bucket: Math.floor(time / 5) * 5, left: Math.max(84, Math.min(bounds.width - 84, x)) });
  };
  const onSeekKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 0;
    if (direction) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) seek((video.current?.currentTime || 0) + direction * 5); }
  };
  const progress = state.duration > 0 ? Math.min(100, state.position / state.duration * 100) : 0;
  const buffered = state.duration > 0 ? Math.min(100, state.buffered / state.duration * 100) : 0;
  const rates = [...new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 3, state.rate])].sort((a, b) => a - b);

  return <div ref={controls} className={styles.videoControls} data-paused={state.paused} role="group" aria-label="播放控制">
    <div ref={rail} className={styles.seekRail} onPointerMove={showPreview} onPointerDown={(event) => { dragging.current = true; showPreview(event); }} onPointerLeave={() => { if (!dragging.current) setHover(undefined); }}>
      <input type="range" min={0} max={state.duration || 1} step={0.1} value={Math.min(state.position, state.duration || 0)} disabled={!state.duration}
        className={styles.seekInput} style={{ '--played': `${progress}%`, '--buffered': `${buffered}%` } as CSSProperties}
        aria-label="播放进度" aria-valuetext={`${formatTime(state.position)} / ${formatTime(state.duration)}`}
        onChange={(event) => seek(Number(event.target.value))} onKeyDown={onSeekKey}
        onBlur={() => { if (!dragging.current) setHover(undefined); }} />
      {hover && <div className={styles.seekPreview} style={{ left: hover.left }} aria-hidden="true">
        {preview && !imageFailed && (
          // eslint-disable-next-line @next/next/no-img-element -- The frame is a short-lived local Blob URL.
          <img src={preview} width="160" height="90" alt="" onError={() => setImageFailed(true)} />
        )}
        <span>{formatTime(hover.time)}</span>
      </div>}
    </div>
    <div className={styles.controlButtons}>
      <button type="button" className={styles.controlButton} onClick={(event) => activate(event, () => { const media = video.current; if (media) { if (media.paused) void media.play().catch(() => {}); else media.pause(); } })} aria-label={state.paused ? '播放' : '暂停'} title={state.paused ? '播放' : '暂停'}><ControlIcon name={state.paused ? 'play' : 'pause'} /></button>
      <button type="button" className={styles.controlButton} onClick={(event) => activate(event, () => seek((video.current?.currentTime || 0) - 5))} aria-label="后退 5 秒" title="后退 5 秒"><ControlIcon name="back" /></button>
      <button type="button" className={styles.controlButton} onClick={(event) => activate(event, () => seek((video.current?.currentTime || 0) + 5))} aria-label="前进 5 秒" title="前进 5 秒"><ControlIcon name="forward" /></button>
      <span className={styles.controlTime}>{formatTime(state.position)}<span> / {formatTime(state.duration)}</span></span>
      <div className={styles.controlSpacer} />
      <button type="button" className={styles.controlButton} onClick={(event) => activate(event, () => { if (video.current) video.current.muted = !video.current.muted; })} aria-label={state.muted ? '取消静音' : '静音'} title={state.muted ? '取消静音' : '静音'}><ControlIcon name={state.muted || !state.volume ? 'mute' : 'volume'} /></button>
      <input type="range" min={0} max={1} step={0.05} value={state.muted ? 0 : state.volume} className={styles.volumeInput} aria-label="音量" onChange={(event) => { if (video.current) { video.current.volume = Number(event.target.value); video.current.muted = false; } }} />
      <select className={styles.rateSelect} value={state.rate} aria-label="播放速度" onChange={(event) => { if (video.current) video.current.playbackRate = Number(event.target.value); }}>{rates.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}</select>
      <button type="button" className={styles.controlButton} onClick={(event) => activate(event, () => { if (frame.current) void toggleLibraryFullscreen(frame.current); })} aria-label={fullscreen ? '退出全屏' : '全屏'} title={fullscreen ? '退出全屏' : '全屏'}><ControlIcon name={fullscreen ? 'exit' : 'fullscreen'} /></button>
    </div>
  </div>;
}
