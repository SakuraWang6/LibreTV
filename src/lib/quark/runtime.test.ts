import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const children = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), spawn: children.spawn }));
import { completeQuarkLogin, deleteQuarkDownloadRecord, listQuarkDownloadRecords, quarkAccountKey, quarkConfigured, quarkStatus, runQuarkCommand, startQuarkLogin } from './runtime';

let root: string;
const originalHash = crypto.createHash;
const digests: Record<string, string> = {
  'fixture-official-cli': 'b19755822486bd812c76e15de31e9213bccfa2cc6ed1e639c43201e5cf2e07b5',
  'fixture-official-worker': 'b0d886c4835af1cd426cf7519a267d7db7311d403984a965d07e2227de7a40a2',
  'fixture-isolation-preload': '5427cdd2686568a3b6ae8977396e1336d7a29dcad55ee8e29eea5468cd389e6b',
};

class MockChild extends EventEmitter {
  pid = process.pid;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close', 130)); return true; });
  finish(value: unknown, exitCode = 0) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
    this.emit('close', exitCode);
  }
}

async function waitForSpawn(): Promise<MockChild> {
  await vi.waitFor(() => expect(children.spawn).toHaveBeenCalled());
  return children.spawn.mock.results.at(-1)!.value as MockChild;
}

async function config(userId: string): Promise<void> {
  await fs.mkdir(path.join(root, 'codex'), { recursive: true });
  await fs.writeFile(path.join(root, 'codex/config.json'), JSON.stringify({
    agent_auth: { codex: { userId } }, [userId]: { userId, accessToken: 'private-token-must-not-escape' },
  }));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-quark-runtime-test-'));
  vi.stubEnv('QUARK_RUNTIME_DIR', root);
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'scripts/quark-drive.cjs'), 'fixture-official-cli');
  await fs.writeFile(path.join(root, 'scripts/hash-worker.cjs'), 'fixture-official-worker');
  await fs.writeFile(path.join(root, 'isolate.cjs'), 'fixture-isolation-preload');
  // Substitute digests only for explicit test fixtures; all other inputs use
  // real SHA256, including changed runtime code and private account identities.
  vi.spyOn(crypto, 'createHash').mockImplementation((algorithm, options) => {
    let fixture: string | undefined;
    const real = originalHash(algorithm, options);
    const adapter = {
      update(value: crypto.BinaryLike) { fixture = digests[String(value)]; real.update(value); return adapter; },
      digest(encoding: crypto.BinaryToTextEncoding) { return fixture && encoding === 'hex' ? fixture : real.digest(encoding); },
    };
    return adapter as unknown as crypto.Hash;
  });
  children.spawn.mockReset();
  children.spawn.mockImplementation(() => new MockChild());
});

afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('private official Quark runtime', () => {
  it('requires absolute configuration and all trusted code, rejecting symlinked code directories', async () => {
    expect(quarkConfigured()).toBe(true);
    await fs.writeFile(path.join(root, 'scripts/quark-drive.cjs'), 'tampered');
    expect(quarkConfigured()).toBe(false);
    await fs.writeFile(path.join(root, 'scripts/quark-drive.cjs'), 'fixture-official-cli');
    await fs.rename(path.join(root, 'scripts'), path.join(root, 'elsewhere'));
    await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'scripts'));
    expect(quarkConfigured()).toBe(false);
    vi.stubEnv('QUARK_RUNTIME_DIR', 'relative');
    expect(await quarkStatus()).toEqual({ enabled: false, connected: false, pending: false });
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('reads cached public status without invoking CLI and never returns account identifiers', async () => {
    await config('secret-user-id');
    await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ connected: true, accountLabel: '昵称', pending: false, userId: 'secret-user-id', accessToken: 'private-token' }));
    expect(await quarkStatus()).toEqual({ enabled: true, connected: true, pending: false, accountLabel: '昵称' });
    expect(children.spawn).not.toHaveBeenCalled();
    const first = await quarkAccountKey();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('secret-user-id');
    expect((await fs.stat(path.join(root, 'codex/config.json'))).mode & 0o777).toBe(0o600);
    await config('different-user-id');
    expect(await quarkAccountKey()).not.toEqual(first);
  });

  it('runs a pinned child with isolated environment, parses progress and persists only public account status', async () => {
    vi.stubEnv('UNRELATED_API_TOKEN', 'do-not-inherit');
    vi.stubEnv('NODE_OPTIONS', '--inspect=9229');
    const onProgress = vi.fn();
    const pending = runQuarkCommand(['get-user-info'], { onProgress });
    const child = await waitForSpawn();
    const [, args, options] = children.spawn.mock.calls[0];
    expect(args).toEqual(['--require', path.join(root, 'isolate.cjs'), path.join(root, 'scripts/quark-drive.cjs'), 'get-user-info']);
    expect(options.env).not.toHaveProperty('HOME');
    expect(options.env).not.toHaveProperty('UNRELATED_API_TOKEN');
    expect(options.env).not.toHaveProperty('NODE_OPTIONS');
    expect(options.env.LIBRETV_QUARK_PRIVATE_HOME).toBe(path.join(root, 'private-home'));
    expect(options.env.AI_AGENT).toBe('codex');
    expect(options.cwd).toBe(path.join(root, 'cwd'));
    child.stdout.write(`${JSON.stringify({ type: 'progress', data: { current: 20, total: 100 } })}\n`);
    child.finish({ type: 'result', code: 0, msg: '成功', data: { userInfo: { nickname: '用户' } } });
    await expect(pending).resolves.toMatchObject({ code: 0 });
    expect(onProgress).toHaveBeenCalledWith(20, 100);
    expect(await quarkStatus()).toMatchObject({ connected: true, accountLabel: '用户' });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves split UTF8 JSON and returns bounded list records for download recovery', async () => {
    const pending = runQuarkCommand(['download', 'list']);
    const child = await waitForSpawn();
    const line = Buffer.from(`${JSON.stringify({ type: 'list', data: { fileName: '电影.mp4', recordId: 'record-1' } })}\n`);
    const boundary = line.indexOf(Buffer.from('电')) + 1;
    child.stdout.write(line.subarray(0, boundary));
    child.stdout.write(line.subarray(boundary));
    child.finish({ type: 'result', code: 0, msg: '成功', data: { totalCount: 1 } });
    await expect(pending).resolves.toMatchObject({ records: [{ fileName: '电影.mp4', recordId: 'record-1' }] });
  });

  it('does not steal an old live-owner lock and rejects concurrent commands quickly', async () => {
    const first = runQuarkCommand(['download', '--fid', 'file-id']);
    const child = await waitForSpawn();
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(path.join(root, '.command-lock'), old, old);
    await expect(runQuarkCommand(['share-detail', '--url', 'https://pan.quark.cn/s/abc'])).rejects.toMatchObject({ status: 409 });
    expect(children.spawn).toHaveBeenCalledTimes(1);
    child.finish({ type: 'result', code: 0, data: { fileName: 'movie.mp4' } });
    await first;
  });

  it('recovers a demonstrably dead local owner, preserving a surviving child owner', async () => {
    const lock = path.join(root, '.command-lock');
    await fs.mkdir(lock);
    const owner = { pid: 2_147_483_647, hostname: os.hostname(), token: 'a'.repeat(48), childPid: process.pid };
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    await expect(runQuarkCommand(['get-user-info'])).rejects.toMatchObject({ status: 409 });
    delete (owner as { childPid?: number }).childPid;
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner));
    const pending = runQuarkCommand(['get-user-info']);
    const child = await waitForSpawn();
    child.finish({ type: 'result', code: 0, data: { userInfo: { nickname: '用户' } } });
    await expect(pending).resolves.toMatchObject({ code: 0 });
  });

  it('sanitizes credential-bearing failures, invalidates cached authentication, and releases its lock', async () => {
    const pending = runQuarkCommand(['share-detail', '--url', 'https://pan.quark.cn/s/abc']);
    const child = await waitForSpawn();
    child.finish({ type: 'result', code: -1408, msg: 'access_token=private-secret https://example.com/token /Users/private/file', data: {} }, 1);
    await expect(pending).rejects.toMatchObject({ status: 401, message: '夸克授权已失效，请重新连接账号' });
    const state = JSON.stringify(await quarkStatus());
    expect(state).not.toContain('private-secret');
    expect(state).not.toContain('example.com');
    expect(state).not.toContain('/Users');
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps the real server file-size restriction without marketing or clearing the current account', async () => {
    await config('fixture-user');
    const account = await quarkAccountKey();
    await fs.writeFile(path.join(root, 'status.json'), JSON.stringify({ connected: true, accountLabel: '用户', pending: false }));
    for (const [raw, expected] of [
      ['download file size limit[52428800]', '夸克当前下载接口限制单个文件不超过 50 MiB'],
      ['provider rejected: download file size limit[1048576] https://example.com/offer 请购买套餐', '夸克当前下载接口限制单个文件不超过 1 MiB'],
      ['download file size limit[512]', '夸克当前下载接口限制单个文件不超过 512 字节'],
      ['download file size limit[99999999999999999999999999999]', '夸克当前下载接口限制单个文件大小'],
    ]) {
      children.spawn.mockClear();
      const pending = runQuarkCommand(['download', '--fid', 'saved-file']);
      const child = await waitForSpawn();
      child.finish({ type: 'result', code: 23018, msg: raw, action: 'download', data: {} }, 1);
      await expect(pending).rejects.toMatchObject({ status: 502, message: expected });
      expect(await quarkStatus()).toEqual({ enabled: true, connected: true, pending: false, accountLabel: '用户' });
      expect(await quarkAccountKey()).toBe(account);
    }
  });

  it('uses SIGINT for cancellation and waits for child exit before releasing the lock', async () => {
    const controller = new AbortController();
    const pending = runQuarkCommand(['download', '--fid', 'file'], { signal: controller.signal });
    const child = await waitForSpawn();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the lock while a child is saving its checkpoint and grants a five-second shutdown grace', async () => {
    const controller = new AbortController();
    const pending = runQuarkCommand(['download', '--fid', 'file'], { signal: controller.signal });
    const child = await waitForSpawn();
    child.kill.mockImplementation(() => true);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(timers.mock.calls.some(([, milliseconds]) => milliseconds === 5000)).toBe(true);
    expect((await fs.stat(path.join(root, '.command-lock'))).isDirectory()).toBe(true);
    child.emit('close', 130);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects secret or unrecognized command arguments before running any child', async () => {
    for (const args of [['remove', 'all'], ['login', '--token', 'secret'], ['get-user-info', '--session-input', 'private chat'], ['get-user-info', '--verbose']]) {
      await expect(runQuarkCommand(args)).rejects.toMatchObject({ status: 400 });
    }
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('starts one asynchronous Mac login and keeps repeated connection requests pending', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(await startQuarkLogin()).toEqual({ enabled: true, connected: false, pending: true });
    const child = await waitForSpawn();
    expect(await startQuarkLogin()).toMatchObject({ pending: true });
    expect(children.spawn).toHaveBeenCalledTimes(1);
    child.finish({ type: 'result', code: 0, data: { userId: 'must-not-be-public', status: 'confirmed' } });
    await vi.waitFor(async () => expect(await quarkStatus()).toMatchObject({ connected: true, pending: false }));
    expect(JSON.stringify(await quarkStatus())).not.toContain('must-not-be-public');
  });

  it('only accepts typed official completion codes and keeps generic token commands prohibited', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    for (const invalid of ['invalid', 'AAC-short', `AAC-${'a'.repeat(32)} extra`, ` AAC-${'a'.repeat(32)}`, `https://example.com/AAC-${'a'.repeat(32)}`]) {
      await expect(completeQuarkLogin(invalid)).rejects.toMatchObject({ status: 400, message: '授权码无效或已过期，请重新登录' });
    }
    await expect(runQuarkCommand(['login', '--token', `AAC-${'a'.repeat(32)}`])).rejects.toMatchObject({ status: 400 });
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('completes a grant through private stdin without returning or spawning with the authorization code', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const code = `AAC-${'a'.repeat(32)}`;
    const pending = completeQuarkLogin(code);
    const child = await waitForSpawn();
    const [, args, options] = children.spawn.mock.calls[0];
    expect(JSON.stringify(args)).not.toContain(code);
    expect(JSON.stringify(options.env)).not.toContain(code);
    expect(options.env.LIBRETV_QUARK_AUTH_STDIN).toBe('1');
    expect(child.stdin.read().toString()).toBe(code);
    child.finish({ type: 'result', code: 0, data: { userId: 'private-user', accessToken: 'private-token', status: 'confirmed' } });
    await expect(pending).resolves.toEqual({ enabled: true, connected: true, pending: false, accountLabel: '夸克账号' });
    const state = JSON.stringify(await quarkStatus());
    expect(state).not.toContain(code);
    expect(state).not.toContain('private-user');
    expect(state).not.toContain('private-token');
  });

  it('replaces completion failures and vendor marketing with a fixed short public error', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const code = `AAC-${'b'.repeat(32)}`;
    const pending = completeQuarkLogin(code);
    const child = await waitForSpawn();
    child.finish({ type: 'result', code: -1408, msg: `请粘贴到对话框并购买套餐 ${code} https://private.example/offer /Users/private/file`, data: {} }, 1);
    await expect(pending).rejects.toMatchObject({ status: 401, message: '授权码无效或已过期，请重新登录' });
    expect(await quarkStatus()).toEqual({ enabled: true, connected: false, pending: false, error: '授权码无效或已过期，请重新登录' });
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('shows a short timeout action instead of vendor browser-login instructions', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    await startQuarkLogin();
    const child = await waitForSpawn();
    child.finish({ type: 'result', code: -1408, msg: '请粘贴到对话框并购买套餐 https://example.com/offer', data: {} }, 1);
    await vi.waitFor(async () => expect(await quarkStatus()).toEqual({ enabled: true, connected: false, pending: false, error: '授权未完成或已超时，请重新点击登录夸克' }));
  });

  it('reads provider-format local checkpoints offline without exposing signed URLs or account IDs', async () => {
    await config('fixture-user');
    const key = await quarkAccountKey();
    await fs.mkdir(path.join(root, 'codex/download'));
    const record = { recordId: 'record-1', fid: 'saved-file-1', fileName: '影片.mp4', fileSize: 42, state: 'paused', createdAt: 1, updatedAt: 2 };
    await fs.writeFile(path.join(root, 'codex/download/storage.json'), JSON.stringify({
      qkop_qkop_download_index_fixture_user_unused: JSON.stringify([]),
      'qkop_qkop_download_index_fixture-user': JSON.stringify([record]),
      'qkop_qkop_download_checkpoint_fixture-user_record-1': JSON.stringify({ fid: 'saved-file-1', downloadUrl: 'https://private.example/signed?token=private', downloadedSize: 20 }),
    }));
    expect(await listQuarkDownloadRecords(key)).toEqual([{ recordId: 'record-1', fid: 'saved-file-1', fileName: '影片.mp4', fileSize: 42, state: 'paused' }]);
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('deletes one exact local checkpoint idempotently while preserving unrelated users and index metadata', async () => {
    await config('fixture-user');
    const key = await quarkAccountKey();
    await fs.mkdir(path.join(root, 'codex/download'));
    const retained = { recordId: 'record-2', fid: 'saved-file-2', fileName: '保留.mp4', fileSize: 99, state: 'failed', createdAt: 10, updatedAt: 11, customSdkField: 'keep' };
    const storage = {
      'qkop_qkop_download_index_fixture-user': JSON.stringify([{ recordId: 'record-1', fid: 'saved-file-1', fileName: '影片.mp4', fileSize: 42, state: 'paused' }, retained]),
      'qkop_qkop_download_checkpoint_fixture-user_record-1': JSON.stringify({ fid: 'saved-file-1', downloadUrl: 'https://private.example/signed' }),
      'qkop_qkop_download_checkpoint_fixture-user_record-2': JSON.stringify({ fid: 'saved-file-2' }),
      'qkop_qkop_download_index_another-user': JSON.stringify([{ untouched: true }]),
      unrelated: 'unchanged',
    };
    const target = path.join(root, 'codex/download/storage.json');
    await fs.writeFile(target, JSON.stringify(storage));
    await expect(deleteQuarkDownloadRecord(key, 'record-1', 'wrong-file')).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual(storage);
    await deleteQuarkDownloadRecord(key, 'record-1', 'saved-file-1');
    const after = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(after['qkop_qkop_download_index_fixture-user']).toBe(JSON.stringify([retained]));
    expect(after).not.toHaveProperty('qkop_qkop_download_checkpoint_fixture-user_record-1');
    expect(after['qkop_qkop_download_checkpoint_fixture-user_record-2']).toBe(storage['qkop_qkop_download_checkpoint_fixture-user_record-2']);
    expect(after['qkop_qkop_download_index_another-user']).toBe(storage['qkop_qkop_download_index_another-user']);
    expect(after.unrelated).toBe('unchanged');
    await expect(deleteQuarkDownloadRecord(key, 'record-1', 'saved-file-1')).resolves.toBeUndefined();
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('rejects account mismatches and unsafe local record paths without touching other files', async () => {
    await config('fixture-user');
    const key = await quarkAccountKey();
    expect(await listQuarkDownloadRecords('a'.repeat(64))).toEqual([]);
    await expect(deleteQuarkDownloadRecord(key, '../record', 'saved-file')).rejects.toMatchObject({ status: 409 });
    await fs.writeFile(path.join(root, 'protected.json'), JSON.stringify({ protected: true }));
    await fs.symlink(path.join(root, 'protected.json'), path.join(root, 'codex/download/storage.json'));
    await expect(listQuarkDownloadRecords(key)).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(await fs.readFile(path.join(root, 'protected.json'), 'utf8'))).toEqual({ protected: true });
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('shares the download mutex with offline record cleanup', async () => {
    await config('fixture-user');
    const key = await quarkAccountKey();
    const pending = runQuarkCommand(['download', '--fid', 'saved-file']);
    const child = await waitForSpawn();
    await expect(listQuarkDownloadRecords(key)).rejects.toMatchObject({ status: 409 });
    await expect(deleteQuarkDownloadRecord(key, 'record-1', 'saved-file')).rejects.toMatchObject({ status: 409 });
    child.finish({ type: 'result', code: 0, data: {} });
    await pending;
    expect(await listQuarkDownloadRecords(key)).toEqual([]);
  });

  it('cleans only the matching account index after authorization configuration has been removed', async () => {
    await config('fixture-user');
    const key = await quarkAccountKey();
    await fs.rm(path.join(root, 'codex/config.json'));
    await fs.mkdir(path.join(root, 'codex/download'));
    const target = path.join(root, 'codex/download/storage.json');
    const record = { recordId: 'record-1', fid: 'saved-file-1', fileName: '影片.mp4', fileSize: 42, state: 'paused' };
    await fs.writeFile(target, JSON.stringify({
      'qkop_qkop_download_index_fixture-user': JSON.stringify([record]),
      'qkop_qkop_download_checkpoint_fixture-user_record-1': JSON.stringify({ fid: 'saved-file-1', downloadUrl: 'https://private.example/signed' }),
      'qkop_qkop_download_index_someone-else': 'malformed unrelated account index remains unread',
    }));
    expect(await listQuarkDownloadRecords(key)).toEqual([record]);
    await deleteQuarkDownloadRecord(key, 'record-1', 'saved-file-1');
    const after = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(after['qkop_qkop_download_index_fixture-user']).toBe('[]');
    expect(after['qkop_qkop_download_index_someone-else']).toBe('malformed unrelated account index remains unread');
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('preserves trusted callback pause error identity while saving the checkpoint with SIGINT', async () => {
    class DownloadPausedError extends Error {}
    const error = new DownloadPausedError('paused');
    const pending = runQuarkCommand(['download', '--fid', 'saved-file'], { onProgress: async () => { throw error; } });
    const child = await waitForSpawn();
    child.stdout.write(`${JSON.stringify({ type: 'progress', data: { current: 20, total: 100 } })}\n`);
    await expect(pending).rejects.toBe(error);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    await expect(fs.stat(path.join(root, '.command-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('isolates the real preload child home without replacing HOME or executing the official CLI', async () => {
    const lock = path.join(root, '.preload-lock');
    const privateHome = path.join(root, 'private-home');
    await fs.mkdir(lock);
    await fs.mkdir(privateHome);
    const token = 'd'.repeat(48);
    let childPid: number | undefined;
    const finished = new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ['--require', path.resolve('scripts/quark/isolate.cjs'), '-e',
        'process.stdout.write(JSON.stringify({home:require("node:os").homedir(),mask:process.umask()}))'], {
        cwd: root,
        env: { NODE_ENV: 'test', LIBRETV_QUARK_PRIVATE_HOME: privateHome, LIBRETV_QUARK_LOCK_DIR: lock, LIBRETV_QUARK_LOCK_TOKEN: token },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      childPid = child.pid;
    });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, childPid, token }));
    expect(JSON.parse(await finished)).toEqual({ home: privateHome, mask: 0o077 });
    expect(children.spawn).not.toHaveBeenCalled();
  });

  it('injects a completion code from stdin only inside the real preload child argv', async () => {
    const lock = path.join(root, '.preload-lock');
    const privateHome = path.join(root, 'private-home');
    const fixture = path.join(root, 'auth-fixture.cjs');
    await fs.mkdir(lock);
    await fs.mkdir(privateHome);
    await fs.writeFile(fixture, 'process.stdout.write(JSON.stringify({operation:process.argv[2],flag:process.argv[3],valid:/^AAC-[a-f0-9]{32}$/i.test(process.argv[4]),privateInputRemoved:process.env.LIBRETV_QUARK_AUTH_STDIN===undefined}))');
    const token = 'd'.repeat(48);
    let childPid: number | undefined;
    const finished = new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, ['--require', path.resolve('scripts/quark/isolate.cjs'), fixture, 'login'], {
        cwd: root,
        env: { NODE_ENV: 'test', LIBRETV_QUARK_PRIVATE_HOME: privateHome, LIBRETV_QUARK_LOCK_DIR: lock, LIBRETV_QUARK_LOCK_TOKEN: token, LIBRETV_QUARK_AUTH_STDIN: '1' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
      childPid = child.pid;
      child.stdin?.end(`AAC-${'a'.repeat(32)}`);
    });
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, childPid, token }));
    expect(JSON.parse(await finished)).toEqual({ operation: 'login', flag: '--token', valid: true, privateInputRemoved: true });
    expect(children.spawn).not.toHaveBeenCalled();
  });
});
