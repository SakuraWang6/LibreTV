import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlAutoHide } from './library-control-visibility';

describe('library controls idle lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hides after playback idles and gives movement a fresh full deadline', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    vi.advanceTimersByTime(2000);
    controls.activity();
    vi.advanceTimersByTime(2499);
    expect(visible).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(visible).toHaveBeenLastCalledWith(false);
    controls.activity();
    expect(visible).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(1);
    controls.dispose();
  });

  it('cancels the old deadline on pause and keeps paused playback visible', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    vi.advanceTimersByTime(2000);
    controls.setPaused(true);
    vi.advanceTimersByTime(60_000);
    expect(visible).not.toHaveBeenCalledWith(false);
    expect(vi.getTimerCount()).toBe(0);
    controls.setPaused(false);
    vi.advanceTimersByTime(2499);
    expect(visible).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(visible).toHaveBeenLastCalledWith(false);
    controls.dispose();
  });

  it('keeps a drag and keyboard focus independently visible until both finish', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    controls.hold('pointer', true);
    controls.hold('focus', true);
    controls.hold('pointer', false);
    vi.advanceTimersByTime(60_000);
    expect(visible).not.toHaveBeenCalledWith(false);
    controls.hold('focus', false);
    vi.advanceTimersByTime(2500);
    expect(visible).toHaveBeenLastCalledWith(false);
    controls.dispose();
  });

  it('reveals hidden controls for an interaction without accumulating timers', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    vi.advanceTimersByTime(2500);
    controls.hold('hover', true);
    expect(visible).toHaveBeenLastCalledWith(true);
    for (let index = 0; index < 50; index++) controls.activity();
    expect(vi.getTimerCount()).toBe(0);
    controls.hold('hover', false);
    for (let index = 0; index < 50; index++) controls.activity();
    expect(vi.getTimerCount()).toBe(1);
    controls.dispose();
  });

  it('resumes the idle deadline after blur releases pointer and focus locks', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    controls.hold('pointer', true);
    controls.hold('focus', true);
    controls.hold('pointer', false);
    controls.hold('focus', false);
    controls.activity();
    vi.advanceTimersByTime(2499);
    expect(visible).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(1);
    expect(visible).toHaveBeenLastCalledWith(false);
    controls.dispose();
  });

  it('does not fire stale timers or callbacks after unmount', () => {
    const visible = vi.fn();
    const controls = createControlAutoHide(visible);
    controls.setPaused(false);
    controls.dispose();
    controls.activity(); controls.setPaused(true); controls.hold('focus', true);
    vi.runAllTimers();
    expect(visible.mock.calls).toEqual([[true]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
