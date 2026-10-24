import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface Owner { pid: number; hostname: string; token: string }
const LEASE = 30_000;
const HOST = os.hostname();
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));

async function ownerOf(directory: string): Promise<Owner | undefined> {
  return fs.readFile(path.join(directory, 'owner'), 'utf8').then((value) => JSON.parse(value) as Owner).catch(() => undefined);
}

async function stale(directory: string): Promise<boolean> {
  const stat = await fs.lstat(directory).catch(() => undefined);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('影视库同步锁不可用');
  // Heartbeats, not PIDs alone, detect container restarts where PID 1 is reused.
  if (Date.now() - stat.mtimeMs > LEASE) return true;
  const owner = await ownerOf(directory);
  if (owner?.hostname === HOST && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try { process.kill(owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
  }
  return false;
}

async function reclaim(directory: string): Promise<void> {
  // Only one contender may recheck and move a stale lock. Without this guard,
  // two recoverers could remove a new owner's freshly recreated directory.
  const reaper = `${directory}.reap`;
  try { await fs.mkdir(reaper, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.lstat(reaper).catch(() => undefined);
    if (stat?.isDirectory() && Date.now() - stat.mtimeMs > LEASE) await fs.rm(reaper, { recursive: true, force: true });
    return;
  }
  try {
    if (!await stale(directory)) return;
    const quarantine = `${directory}.stale-${crypto.randomBytes(8).toString('hex')}`;
    try { await fs.rename(directory, quarantine); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await fs.rm(quarantine, { recursive: true, force: true });
  } finally { await fs.rm(reaper, { recursive: true, force: true }); }
}

/** Library disk mutex with a renewable lease and token-checked release. */
export async function withFileLock<T>(directory: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const token = crypto.randomBytes(16).toString('hex');
  const deadline = Date.now() + 35_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(path.join(directory, 'owner'), JSON.stringify({ pid: process.pid, hostname: HOST, token }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await stale(directory)) { await reclaim(directory); continue; }
      if (Date.now() >= deadline) throw new Error('影视库同步繁忙，请稍后重试');
      await pause();
    }
  }
  const heartbeat = setInterval(() => {
    void ownerOf(directory).then(async (owner) => {
      if (owner?.token === token) { const now = new Date(); await fs.utimes(directory, now, now); }
    }).catch(() => undefined);
  }, 3000);
  try { signal?.throwIfAborted(); return await action(); }
  finally {
    clearInterval(heartbeat);
    if ((await ownerOf(directory))?.token === token) await fs.rm(directory, { recursive: true, force: true });
  }
}
