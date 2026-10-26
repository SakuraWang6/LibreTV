import { afterEach, describe, expect, it, vi } from 'vitest';
import type Artplayer from 'artplayer';
import { keepArtplayerControlsAccessible } from './player-shell';

function fixture(paused = false) {
  const video = { paused, ended: false };
  const document = { activeElement: video as unknown };
  const surface = Object.assign(new EventTarget(), {
    ownerDocument: document,
    contains: (element: unknown) => element === video || element === surface || element === control,
  });
  const control = {};
  const events = new Map<string, Set<(...values: unknown[]) => void>>();
  const emit = (name: string, ...values: unknown[]) => events.get(name)?.forEach((listener) => listener(...values));
  let visible = false;
  const art = {
    template: { $player: surface, $video: video },
    controls: {
      get show() { return visible; },
      set show(next: boolean) { visible = next; emit('control', next); },
    },
    setting: { show: false },
    on(name: string, listener: (...values: unknown[]) => void) { const listeners = events.get(name) ?? new Set(); listeners.add(listener); events.set(name, listeners); },
    off(name: string, listener: (...values: unknown[]) => void) { events.get(name)?.delete(listener); },
  };
  const hidePreview = vi.fn();
  const dispose = keepArtplayerControlsAccessible(art as unknown as Artplayer, hidePreview);
  return { art, surface, document, control, video, emit, hidePreview, dispose };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ArtPlayer native control visibility integration', () => {
  it('lets the native idle clock hide playing controls and removes the detached hover preview', () => {
    const { art, hidePreview, dispose } = fixture();
    art.controls.show = true;
    art.controls.show = false; // Native timeupdate clock, including native cursor class changes.
    expect(art.controls.show).toBe(false);
    expect(hidePreview).toHaveBeenCalledOnce();
    dispose();
  });

  it('shows paused and ended controls and cannot leave their cursor hidden', () => {
    const { art, video, emit, hidePreview, dispose } = fixture(true);
    expect(art.controls.show).toBe(true);
    art.controls.show = false;
    expect(art.controls.show).toBe(true);
    video.paused = false;
    art.controls.show = false;
    expect(art.controls.show).toBe(false);
    video.paused = true;
    emit('video:pause');
    expect(art.controls.show).toBe(true);
    video.paused = false; video.ended = true;
    emit('video:ended'); art.controls.show = false;
    expect(art.controls.show).toBe(true);
    expect(hidePreview).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('keeps focused controls and settings accessible, without pinning a focused playing video', () => {
    const { art, surface, document, control, hidePreview, dispose } = fixture();
    document.activeElement = control;
    surface.dispatchEvent(new Event('focusin'));
    art.controls.show = false;
    expect(art.controls.show).toBe(true);
    expect(hidePreview).not.toHaveBeenCalled();
    document.activeElement = {};
    art.setting.show = true;
    art.controls.show = false;
    expect(art.controls.show).toBe(true);
    art.setting.show = false;
    art.controls.show = false;
    expect(art.controls.show).toBe(false);
    dispose();
  });

  it('detaches listeners without adding a parallel hide timer', () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const { art, video, emit, surface, dispose } = fixture();
    expect(timer).not.toHaveBeenCalled();
    dispose();
    video.paused = true;
    emit('video:pause'); surface.dispatchEvent(new Event('focusin'));
    art.controls.show = false;
    expect(art.controls.show).toBe(false);
  });
});
