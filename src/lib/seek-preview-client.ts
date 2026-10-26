'use client';

import Hls, { type HlsConfig } from 'hls.js';
import { createHlsLoader } from './hls-loader';
import { isNativeMediaUrl } from './playback-source';
import { formatTime } from './utils';

export interface SeekPreviewSource { url: string; blockAd?: boolean }
export interface SeekPreviewClient {
  /** Object URLs belong to this client and expire on eviction or disposal. */
  get(time: number, signal?: AbortSignal): Promise<string | undefined>;
  dispose(): void;
}

const BUCKET_SECONDS = 5;
const CACHE_ENTRIES = 12;
const FRAME_TIMEOUT_MS = 7000;
const WIDTH = 176;
const HEIGHT = 99;

class PreviewUnavailable extends Error {}

export function seekPreviewBucket(time: number): number {
  return Math.floor(Math.max(0, Number.isFinite(time) ? time : 0) / BUCKET_SECONDS) * BUCKET_SECONDS;
}

/** Independent media only: this module never receives the playing video. */
async function captureFrame(source: SeekPreviewSource, time: number, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  // A source without canvas-compatible CORS is a time-only preview. Do not
  // weaken the playing video's CORS mode or add a new server proxy fallback.
  video.crossOrigin = 'anonymous';
  video.disableRemotePlayback = true;
  const controller = new AbortController();
  let hls: Hls | undefined;
  const halt = () => {
    controller.abort(signal.reason);
    hls?.stopLoad();
    video.removeAttribute('src');
    video.load();
  };
  signal.addEventListener('abort', halt, { once: true });
  const waitForMedia = (ready: () => boolean): Promise<void> => new Promise((resolve, reject) => {
    const events = ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'durationchange'];
    const clear = () => {
      events.forEach((event) => video.removeEventListener(event, check));
      video.removeEventListener('error', fail);
      controller.signal.removeEventListener('abort', abort);
    };
    const check = () => { if (ready()) { clear(); resolve(); } };
    const fail = () => { clear(); reject(new PreviewUnavailable('Preview media unavailable')); };
    const abort = () => { clear(); reject(controller.signal.reason); };
    events.forEach((event) => video.addEventListener(event, check));
    video.addEventListener('error', fail);
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) abort();
    else check();
  });

  try {
    signal.throwIfAborted();
    if (!isNativeMediaUrl(source.url) && Hls.isSupported()) {
      hls = new Hls({
        autoStartLoad: false,
        enableWorker: false,
        startLevel: 0,
        backBufferLength: 0,
        maxBufferLength: 1,
        maxMaxBufferLength: 2,
        maxBufferSize: 2 * 1024 * 1024,
        manifestLoadingMaxRetry: 0,
        levelLoadingMaxRetry: 0,
        fragLoadingMaxRetry: 0,
        loader: createHlsLoader(Hls, { blockAd: source.blockAd }) as unknown as HlsConfig['loader'],
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) controller.abort(new PreviewUnavailable('Preview HLS unavailable'));
      });
      await new Promise<void>((resolve, reject) => {
        const clear = () => {
          hls?.off(Hls.Events.MANIFEST_PARSED, ready);
          controller.signal.removeEventListener('abort', abort);
        };
        const ready = () => { clear(); resolve(); };
        const abort = () => { clear(); reject(controller.signal.reason); };
        hls!.on(Hls.Events.MANIFEST_PARSED, ready);
        controller.signal.addEventListener('abort', abort, { once: true });
        hls!.attachMedia(video);
        hls!.loadSource(source.url);
      });
      controller.signal.throwIfAborted();
      const lowest = hls.levels.reduce((best, level, index, levels) =>
        (level.bitrate || Infinity) < (levels[best]?.bitrate || Infinity) ? index : best, 0);
      hls.loadLevel = lowest; // Manual selection: never run adaptive upgrades for thumbnails.
      hls.startLoad(time);
    } else {
      if (!isNativeMediaUrl(source.url) && !video.canPlayType('application/vnd.apple.mpegurl')) {
        throw new PreviewUnavailable('Preview HLS unsupported');
      }
      video.src = source.url;
      video.load();
    }
    await waitForMedia(() => video.readyState >= 1);
    const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(time, Math.max(0, video.duration - 0.1)) : time;
    video.currentTime = target;
    await waitForMedia(() => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - target) < 0.5);
    controller.signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    if (!context || !video.videoWidth || !video.videoHeight) throw new PreviewUnavailable('Preview frame unavailable');
    const scale = Math.min(WIDTH / video.videoWidth, HEIGHT / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.fillStyle = '#000';
    context.fillRect(0, 0, WIDTH, HEIGHT);
    context.drawImage(video, (WIDTH - width) / 2, (HEIGHT - height) / 2, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      canvas.toBlob((blob) => {
        controller.signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) reject(controller.signal.reason);
        else if (blob) resolve(blob);
        else reject(new PreviewUnavailable('Preview canvas unavailable'));
      }, 'image/jpeg', 0.65);
    });
  } finally {
    signal.removeEventListener('abort', halt);
    hls?.stopLoad();
    hls?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

/** At most one uncached frame request and twelve small JPEGs per source. */
export function createSeekPreviewClient(source: SeekPreviewSource): SeekPreviewClient {
  const cache = new Map<number, string>();
  const failed = new Set<number>();
  let active: AbortController | undefined;
  let disposed = false;
  let unavailable = false;
  return {
    async get(time, signal) {
      if (disposed || unavailable || signal?.aborted || !Number.isFinite(time) || time < 0) return undefined;
      active?.abort();
      const bucket = seekPreviewBucket(time);
      const hit = cache.get(bucket);
      if (hit) { cache.delete(bucket); cache.set(bucket, hit); return hit; }
      if (failed.has(bucket)) return undefined;
      const controller = new AbortController();
      active = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => controller.abort(new DOMException('Preview timed out', 'TimeoutError')), FRAME_TIMEOUT_MS);
      try {
        const blob = await captureFrame(source, bucket, controller.signal);
        if (disposed || controller.signal.aborted) return undefined;
        const url = URL.createObjectURL(blob);
        cache.set(bucket, url);
        if (cache.size > CACHE_ENTRIES) {
          const oldest = cache.keys().next().value!;
          URL.revokeObjectURL(cache.get(oldest)!);
          cache.delete(oldest);
        }
        return url;
      } catch (error) {
        if (!disposed && !signal?.aborted) {
          if (error instanceof PreviewUnavailable || (error instanceof Error && error.name === 'SecurityError')) unavailable = true;
          // Cancellation by a newer hover is not a failed frame.
          if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError') {
            failed.add(bucket);
            if (failed.size > CACHE_ENTRIES) failed.delete(failed.values().next().value!);
          }
        }
        return undefined;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (active === controller) active = undefined;
      }
    },
    dispose() {
      disposed = true;
      active?.abort();
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
      failed.clear();
    },
  };
}

export interface SeekPreviewPopover {
  setSource(source: SeekPreviewSource): void;
  dispose(): void;
}

/** Progress listeners are passive: dragging and clicking remain ArtPlayer's. */
export function attachSeekPreviewPopover(surface: HTMLElement, progress: HTMLElement, getDuration: () => number, initialSource: SeekPreviewSource): SeekPreviewPopover {
  const doc = surface.ownerDocument;
  const popover = doc.createElement('div');
  popover.className = 'seek-preview';
  popover.setAttribute('aria-hidden', 'true');
  popover.style.cssText = 'display:none;position:absolute;z-index:90;width:188px;max-width:calc(100% - 16px);padding:6px;border:1px solid rgba(255,255,255,.16);border-radius:10px;background:rgba(20,20,22,.96);box-shadow:0 6px 24px #0008;pointer-events:none;transform:translateY(-100%);';
  const image = doc.createElement('img');
  image.className = 'seek-preview__image';
  image.alt = '';
  image.style.cssText = 'display:none;width:100%;aspect-ratio:16/9;object-fit:contain;border-radius:5px;background:#000;';
  const label = doc.createElement('div');
  label.className = 'seek-preview__time';
  label.style.cssText = 'padding-top:3px;text-align:center;font:500 11px/16px ui-monospace,monospace;color:#fff;';
  popover.append(image, label);
  surface.appendChild(popover);
  const nativeTip = progress.querySelector<HTMLElement>('.art-progress-tip');
  const nativeTipVisibility = nativeTip?.style.visibility ?? '';
  let source = initialSource;
  let client: SeekPreviewClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let bucket = -1;
  let generation = 0;
  const hide = () => {
    generation++;
    clearTimeout(timer);
    request?.abort();
    request = undefined;
    bucket = -1;
    image.removeAttribute('src');
    image.style.display = 'none';
    popover.style.display = 'none';
    if (nativeTip) nativeTip.style.visibility = nativeTipVisibility;
  };
  const move = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const duration = getDuration();
    const bar = progress.getBoundingClientRect();
    const bounds = surface.getBoundingClientRect();
    if (!Number.isFinite(duration) || duration <= 0 || bar.width <= 0) { hide(); return; }
    const time = Math.max(0, Math.min(duration, (event.clientX - bar.left) / bar.width * duration));
    label.textContent = formatTime(time);
    const width = Math.min(188, Math.max(0, bounds.width - 16));
    popover.style.left = `${Math.max(8, Math.min(bounds.width - width - 8, event.clientX - bounds.left - width / 2))}px`;
    popover.style.top = `${Math.max(0, bar.top - bounds.top - 12)}px`;
    popover.style.display = 'block';
    if (nativeTip) nativeTip.style.visibility = 'hidden';
    const nextBucket = seekPreviewBucket(time);
    if (bucket === nextBucket) return;
    bucket = nextBucket;
    clearTimeout(timer);
    request?.abort();
    image.removeAttribute('src');
    image.style.display = 'none';
    const current = ++generation;
    timer = setTimeout(() => {
      client ??= createSeekPreviewClient(source);
      request = new AbortController();
      void client.get(time, request.signal).then((url) => {
        if (current !== generation || !url) return;
        image.src = url;
        image.style.display = 'block';
      });
    }, 180);
  };
  const hidden = () => { if (doc.visibilityState === 'hidden') hide(); };
  progress.addEventListener('pointermove', move, { passive: true });
  progress.addEventListener('pointerenter', move, { passive: true });
  progress.addEventListener('pointerleave', hide);
  progress.addEventListener('pointercancel', hide);
  doc.addEventListener('visibilitychange', hidden);
  doc.defaultView?.addEventListener('blur', hide);
  return {
    setSource(next) {
      if (next.url === source.url && next.blockAd === source.blockAd) return;
      hide();
      client?.dispose();
      client = undefined;
      source = next;
    },
    dispose() {
      hide();
      client?.dispose();
      popover.remove();
      progress.removeEventListener('pointermove', move);
      progress.removeEventListener('pointerenter', move);
      progress.removeEventListener('pointerleave', hide);
      progress.removeEventListener('pointercancel', hide);
      doc.removeEventListener('visibilitychange', hidden);
      doc.defaultView?.removeEventListener('blur', hide);
    },
  };
}
