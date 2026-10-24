import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFileLock } from './file-lock';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-lock-test-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('renewable library filesystem lock', () => {
  it('recovers an expired container lock even when its old PID has been reused', async () => {
    const lock = path.join(root, 'item.lock');
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: 'old-container-token' }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    expect(await withFileLock(lock, async () => 'recovered')).toBe('recovered');
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent recoverers instead of deleting a new owner after a stale lease', async () => {
    const lock = path.join(root, 'item.lock');
    await fs.mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 8 }, () => withFileLock(lock, async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    })));
    expect(maximum).toBe(1);
  });

  it('releases only its own token and promptly aborts a wait for another active process', async () => {
    const lock = path.join(root, 'item.lock');
    await withFileLock(lock, async () => {
      await fs.writeFile(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, hostname: os.hostname(), token: 'new-owner-token' }));
    });
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
    const stopping = new AbortController();
    const waiting = withFileLock(lock, async () => undefined, stopping.signal);
    stopping.abort(new Error('stopping'));
    await expect(waiting).rejects.toThrow('stopping');
    expect((await fs.stat(lock)).isDirectory()).toBe(true);
  });
});
