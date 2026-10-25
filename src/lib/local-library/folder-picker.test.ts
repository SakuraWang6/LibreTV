import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseLibraryFolder } from './folder-picker';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
type Callback = (error: (Error & { killed?: boolean }) | null, stdout: string, stderr: string) => void;
beforeEach(() => { Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' }); mocks.exec.mockReset(); });
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

describe('fixed native folder picker', () => {
  it('runs only the fixed system dialog and preserves spaces in the chosen path', async () => {
    mocks.exec.mockImplementation((_file, _args, _options, callback: Callback) => callback(null, '/Volumes/Example Disk/Movies/\n', ''));
    expect(await chooseLibraryFolder()).toBe('/Volumes/Example Disk/Movies');
    expect(mocks.exec).toHaveBeenCalledWith('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "选择影片文件夹")'], expect.objectContaining({ timeout: 120000, maxBuffer: 8192 }), expect.any(Function));
  });
  it('treats user cancellation as a normal result and releases its single-dialog guard', async () => {
    let finish!: Callback;
    mocks.exec.mockImplementation((_file, _args, _options, callback: Callback) => { finish = callback; });
    const first = chooseLibraryFolder();
    await expect(chooseLibraryFolder()).rejects.toMatchObject({ status: 409 });
    finish(new Error('Cancelled'), '', 'User canceled. (-128)');
    expect(await first).toBeUndefined();
    mocks.exec.mockImplementation((_file, _args, _options, callback: Callback) => callback(null, '/Movies/\n', ''));
    expect(await chooseLibraryFolder()).toBe('/Movies');
  });
  it('returns a fixed timeout error without exposing command diagnostics', async () => {
    mocks.exec.mockImplementation((_file, _args, _options, callback: Callback) => callback(Object.assign(new Error('/private/secret'), { killed: true }), '', '/private/secret'));
    await expect(chooseLibraryFolder()).rejects.toMatchObject({ status: 408, message: '选择文件夹已超时，请重试' });
  });
  it('does not launch the dialog on other platforms', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    await expect(chooseLibraryFolder()).rejects.toMatchObject({ status: 403 }); expect(mocks.exec).not.toHaveBeenCalled();
  });
});
