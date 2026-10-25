import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
const { superviseBrowser } = createRequire(import.meta.url)('../../scripts/macos/optional-browser.cjs');

describe('optional browser supervision', () => {
  it('retries only the optional child once after an error followed by exit', () => {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn> }> = [];
    const spawn = vi.fn(() => { const child = Object.assign(new EventEmitter(), { kill: vi.fn() }); children.push(child); return child; });
    let restart: (() => void) | undefined;
    const onSpawn = vi.fn(), onExit = vi.fn();
    const stop = superviseBrowser({ spawn, executable: 'node', args: ['browser'], options: {}, onSpawn, onExit, log: vi.fn(),
      schedule: (fn: () => void) => { restart = fn; return 1; }, cancel: vi.fn() });
    children[0].emit('error', new Error('closed'));
    children[0].emit('exit', 1);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
    restart!();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[0].kill).not.toHaveBeenCalled();
    stop();
    expect(children[1].kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('does not restart after the owning service stops', () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const schedule = vi.fn();
    const stop = superviseBrowser({ spawn: () => child, executable: 'node', args: [], options: {}, onSpawn: vi.fn(), onExit: vi.fn(), log: vi.fn(), schedule, cancel: vi.fn() });
    stop(); child.emit('exit', 0);
    expect(schedule).not.toHaveBeenCalled();
  });
  it('lets the owner wait for a browser that ignores SIGTERM before clearing its kill deadline', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const stop = superviseBrowser({ spawn: () => child, executable: 'node', args: [], options: {}, onSpawn: vi.fn(), onExit: vi.fn(), log: vi.fn() });
    let finished = false;
    const stopped = stop().then(() => { finished = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(finished).toBe(false);
    // The owner's existing eight-second fallback may now kill this child.
    child.emit('exit', null, 'SIGKILL');
    await stopped;
    expect(finished).toBe(true);
  });
});
