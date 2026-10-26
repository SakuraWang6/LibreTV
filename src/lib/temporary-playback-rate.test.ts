import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTemporaryPlaybackRate, type TemporaryPlaybackRateHandle } from './temporary-playback-rate';

class Surface extends EventTarget {
  closest = vi.fn(() => null as Element | null);
  ownerDocument = Object.assign(new EventTarget(), { defaultView: new EventTarget(), visibilityState: 'visible' });
}
class Video extends EventTarget {
  paused = false;
  ended = false;
  playbackRate = 1.25;
  getBoundingClientRect() { return { bottom: 400, height: 400 }; }
}
const cleanups: TemporaryPlaybackRateHandle[] = [];
function fixture(ignoreBottom?: number) {
  const surface = new Surface();
  const video = new Video();
  const onChange = vi.fn();
  const handle = attachTemporaryPlaybackRate(surface as unknown as HTMLElement, video as unknown as HTMLVideoElement, { ignoreBottom, onChange });
  cleanups.push(handle);
  return { surface, video, handle, onChange, document: surface.ownerDocument, window: surface.ownerDocument.defaultView };
}
function pointer(target: EventTarget, type: string, data: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, isPrimary: true, button: 0, clientX: 100, clientY: 100, ...data });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

describe('temporary picture and keyboard playback rate', () => {
  it('boosts a stationary mouse hold, restores the rate at activation and suppresses only its release click', () => {
    const { surface, video, document, onChange } = fixture();
    const clicked = vi.fn();
    surface.addEventListener('click', clicked);
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(200);
    video.playbackRate = 1.5;
    vi.advanceTimersByTime(150);
    expect(video.playbackRate).toBe(2);
    pointer(document, 'pointerup'); // Releasing outside the picture also restores.
    expect(video.playbackRate).toBe(1.5);
    expect(pointer(surface, 'click').defaultPrevented).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(100);
    pointer(document, 'pointerup');
    expect(pointer(surface, 'click').defaultPrevented).toBe(false);
    expect(clicked).toHaveBeenCalledOnce();
    expect(onChange.mock.calls).toEqual([[true, 1.5], [false, 1.5]]);
  });

  it('does not accelerate a drag and restores immediately if an active hold starts moving', () => {
    const { surface, video, document } = fixture();
    pointer(surface, 'pointerdown');
    pointer(document, 'pointermove', { clientX: 113 });
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(350);
    expect(video.playbackRate).toBe(2);
    pointer(document, 'pointermove', { clientY: 113 });
    expect(video.playbackRate).toBe(1.25);
  });

  it('cancels touch holds on pointer cancellation and a second finger without capturing 2x as the original rate', () => {
    const { surface, video, document } = fixture();
    pointer(surface, 'pointerdown', { pointerType: 'touch' });
    vi.advanceTimersByTime(350);
    pointer(document, 'pointerdown', { pointerId: 2, isPrimary: false, pointerType: 'touch' });
    pointer(surface, 'pointerdown', { pointerId: 2, isPrimary: false, pointerType: 'touch' });
    pointer(document, 'pointerup');
    expect(pointer(surface, 'click').defaultPrevented).toBe(true);
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
    pointer(surface, 'pointerdown', { pointerType: 'touch' });
    vi.advanceTimersByTime(350);
    expect(video.playbackRate).toBe(2);
    pointer(document, 'pointercancel');
    expect(video.playbackRate).toBe(1.25);
  });

  it('leaves controls, native control strip, paused video and non-primary mouse buttons alone', () => {
    const { surface, video } = fixture(56);
    surface.closest.mockReturnValue({} as Element);
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
    surface.closest.mockReturnValue(null);
    for (const properties of [{ clientY: 380 }, { button: 2 }, { isPrimary: false }]) {
      pointer(surface, 'pointerdown', properties);
      vi.advanceTimersByTime(500);
      expect(video.playbackRate).toBe(1.25);
    }
    video.paused = true;
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
  });

  it.each(['blur', 'pagehide', 'visibilitychange', 'pause', 'emptied', 'pointerleave'])('restores after %s and clears pending work', (type) => {
    const { surface, video, document, window } = fixture();
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(350);
    if (type === 'visibilitychange') document.visibilityState = 'hidden';
    const target = type === 'blur' || type === 'pagehide' ? window
      : type === 'visibilitychange' ? document : type === 'pointerleave' ? surface : video;
    target.dispatchEvent(new Event(type));
    expect(video.playbackRate).toBe(1.25);
    vi.advanceTimersByTime(1000);
    expect(video.playbackRate).toBe(1.25);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one original rate with keyboard holds and restores on keyup, including a short key press', () => {
    const { surface, video, document, handle } = fixture();
    handle.beginKeyboardHold();
    vi.advanceTimersByTime(100);
    document.dispatchEvent(Object.assign(new Event('keyup'), { key: 'ArrowRight' }));
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
    handle.beginKeyboardHold();
    vi.advanceTimersByTime(350);
    expect(video.playbackRate).toBe(2);
    handle.beginKeyboardHold(); // Repeated keydown cannot replace the saved rate.
    pointer(surface, 'pointerdown'); // A competing input restores before starting over.
    expect(video.playbackRate).toBe(1.25);
    handle.beginKeyboardHold();
    vi.advanceTimersByTime(350);
    document.dispatchEvent(Object.assign(new Event('keyup'), { key: 'ArrowRight' }));
    expect(video.playbackRate).toBe(1.25);
  });

  it('restores on disposal without notifying an unmounting UI and detaches its listeners', () => {
    const { surface, video, handle, onChange } = fixture();
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(350);
    expect(video.playbackRate).toBe(2);
    handle();
    expect(video.playbackRate).toBe(1.25);
    expect(onChange).toHaveBeenCalledTimes(1);
    pointer(surface, 'pointerdown');
    vi.advanceTimersByTime(500);
    expect(video.playbackRate).toBe(1.25);
    expect(vi.getTimerCount()).toBe(0);
  });
});
