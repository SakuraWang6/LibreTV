export interface TemporaryPlaybackRateOptions {
  delayMs?: number;
  moveTolerance?: number;
  /** Native video controls live in a shadow tree and retarget events to video. */
  ignoreBottom?: number;
  onChange?: (active: boolean, originalRate: number) => void;
}

export interface TemporaryPlaybackRateHandle {
  (): void;
  beginKeyboardHold(): void;
  endKeyboardHold(): void;
}

interface Press { id: number | 'keyboard'; x: number; y: number; timer?: ReturnType<typeof setTimeout>; originalRate?: number }

const CONTROLS = 'button,a,input,select,textarea,[role="button"],[role="slider"],[contenteditable]:not([contenteditable="false"]),.art-bottom,.art-settings,.art-contextmenus,.art-info,.art-state,.art-selector-list';

/** Temporarily boost only a stationary press on the picture; ordinary clicks stay native. */
export function attachTemporaryPlaybackRate(surface: HTMLElement, video: HTMLVideoElement, options: TemporaryPlaybackRateOptions = {}): TemporaryPlaybackRateHandle {
  const document = surface.ownerDocument;
  const window = document.defaultView;
  let press: Press | undefined;
  let suppressClickUntil = 0;

  const stop = (notify = true) => {
    const previous = press;
    press = undefined;
    if (!previous) return;
    clearTimeout(previous.timer);
    if (previous.originalRate === undefined) return;
    // A touch release may synthesize a mouse click after pointerup. Keep its
    // suppression alive until that click arrives, without changing short taps.
    if (previous.id !== 'keyboard') suppressClickUntil = Date.now() + 700;
    try { video.playbackRate = previous.originalRate; } catch { /* The media may already be gone. */ }
    if (notify) options.onChange?.(false, previous.originalRate);
  };

  const begin = (id: Press['id'], x = 0, y = 0) => {
    if (press || video.paused || video.ended) return;
    const current: Press = { id, x, y };
    press = current;
    current.timer = setTimeout(() => {
      if (press !== current) return;
      if (video.paused || video.ended) { stop(); return; }
      const original = video.playbackRate;
      if (!Number.isFinite(original) || original <= 0) { stop(); return; }
      try { video.playbackRate = 2; }
      catch { stop(); return; }
      current.originalRate = original;
      options.onChange?.(true, original);
    }, options.delayMs ?? 350);
  };
  const start = (event: PointerEvent) => {
    if (press) { stop(); return; }
    if (!event.isPrimary || event.button !== 0) return;
    suppressClickUntil = 0; // A new deliberate press is never the old synthetic click.
    if (video.paused || video.ended) return;
    const target = event.target as Element | null;
    if (target?.closest?.(CONTROLS)) return;
    if (options.ignoreBottom) {
      const bounds = video.getBoundingClientRect();
      const strip = Math.min(options.ignoreBottom, bounds.height / 4);
      if (event.clientY >= bounds.bottom - strip) return;
    }
    begin(event.pointerId, event.clientX, event.clientY);
  };
  const move = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > (options.moveTolerance ?? 12)) stop();
    else if (press.originalRate !== undefined && event.cancelable) event.preventDefault();
  };
  const end = (event: PointerEvent) => { if (event.pointerId === press?.id) stop(); };
  const otherPointer = (event: PointerEvent) => { if (press && event.pointerId !== press.id) stop(); };
  const cancel = () => stop();
  const leavePicture = () => { if (press && press.id !== 'keyboard') stop(); };
  const endKeyboardHold = () => { if (press?.id === 'keyboard') stop(); };
  const keyup = (event: KeyboardEvent) => { if (event.key === 'ArrowRight') endKeyboardHold(); };
  const hidden = () => { if (document.visibilityState === 'hidden') stop(); };
  const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') stop(); };
  const consumeClick = (event: MouseEvent) => {
    if ((press?.id === 'keyboard' || press?.originalRate === undefined) && Date.now() >= suppressClickUntil) return;
    // Do not intercept a separate control button clicked immediately afterwards.
    if ((event.target as Element | null)?.closest?.(CONTROLS)) return;
    suppressClickUntil = 0;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const contextMenu = (event: Event) => { if (press) event.preventDefault(); };
  const mediaEvents = ['pause', 'ended', 'emptied', 'loadstart'] as const;

  // Never capture the pointer on a short press: that retargets the eventual
  // click away from ArtPlayer's video handler. Document listeners own release.
  surface.addEventListener('pointerdown', start);
  surface.addEventListener('pointerleave', leavePicture);
  surface.addEventListener('lostpointercapture', end);
  surface.addEventListener('click', consumeClick, true);
  surface.addEventListener('contextmenu', contextMenu);
  document.addEventListener('pointerdown', otherPointer, true);
  document.addEventListener('pointermove', move, { capture: true, passive: false });
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('visibilitychange', hidden);
  document.addEventListener('keydown', escape, true);
  document.addEventListener('keyup', keyup, true);
  window?.addEventListener('blur', cancel);
  window?.addEventListener('pagehide', cancel);
  for (const event of mediaEvents) video.addEventListener(event, cancel);

  const cleanup = () => {
    stop(false);
    surface.removeEventListener('pointerdown', start);
    surface.removeEventListener('pointerleave', leavePicture);
    surface.removeEventListener('lostpointercapture', end);
    surface.removeEventListener('click', consumeClick, true);
    surface.removeEventListener('contextmenu', contextMenu);
    document.removeEventListener('pointerdown', otherPointer, true);
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', end, true);
    document.removeEventListener('pointercancel', end, true);
    document.removeEventListener('visibilitychange', hidden);
    document.removeEventListener('keydown', escape, true);
    document.removeEventListener('keyup', keyup, true);
    window?.removeEventListener('blur', cancel);
    window?.removeEventListener('pagehide', cancel);
    for (const event of mediaEvents) video.removeEventListener(event, cancel);
  };
  return Object.assign(cleanup, { beginKeyboardHold: () => begin('keyboard'), endKeyboardHold });
}
