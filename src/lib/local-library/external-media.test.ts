import fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { externalMediaStatus, listExternalLocations, openExternalMedia, registerExternalLocation, resolveExternalMedia, scanExternalLocation, validateExternalMediaReference, type ExternalMediaReference } from './external-media';
import { guessLibraryMetadata } from './filename';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));

const UUID_A = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const UUID_B = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
let directory: string, library: string, mount: string, selected: string;
let volumes: Map<string, { uuid: string; online: boolean }>;
const dfLine = (root: string) => `/dev/disk-test 100000 1000 99000 1% ${root}`;
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'libretv-external-')));
  library = path.join(directory, 'internal-library');
  mount = path.join(directory, 'Disk With Spaces');
  selected = path.join(mount, '电影');
  await fs.mkdir(selected, { recursive: true });
  await fs.writeFile(path.join(selected, 'movie.mp4'), 'video');
  volumes = new Map([[mount, { uuid: UUID_A, online: true }]]);
  vi.stubEnv('LOCAL_LIBRARY_DIR', library);
  mocks.exec.mockReset().mockImplementation((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n';
    if (file === '/bin/df' && args.length === 1) {
      callback(null, header + [...volumes.entries()].filter(([, volume]) => volume.online).map(([root]) => dfLine(root)).join('\n') + '\n', '');
    } else if (file === '/bin/df') {
      const match = [...volumes.entries()].filter(([root, volume]) => volume.online && existsSync(args[1]) && (args[1] === root || args[1].startsWith(root + path.sep))).sort((a, b) => b[0].length - a[0].length)[0];
      callback(match ? null : new Error('not mounted'), match ? header + dfLine(match[0]) + '\n' : '', '');
    } else if (file === '/usr/sbin/diskutil') {
      const root = args[2], volume = volumes.get(root);
      callback(volume?.online ? null : new Error('not mounted'), volume?.online ? `<plist><dict><key>VolumeUUID</key><string>${volume.uuid}</string><key>MountPoint</key><string>${xml(root)}</string><key>Mounted</key><true/></dict></plist>` : '', '');
    } else throw new Error('Unexpected system command');
  });
});

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

async function one() {
  const location = await registerExternalLocation(selected);
  const scan = await scanExternalLocation(location.id);
  const file = scan.files.find((entry) => entry.name === 'movie.mp4')!;
  const resolved = await resolveExternalMedia(location.id, file.id);
  return { location, scan, file, ...resolved };
}

describe('read-only external media locations', () => {
  it('registers a path with spaces, scans supported files, and keeps stable location/file identifiers', async () => {
    await fs.mkdir(path.join(selected, 'Season 1'));
    await fs.writeFile(path.join(selected, 'Season 1', 'Episode.m4v'), 'episode');
    await fs.writeFile(path.join(selected, 'other.webm'), 'webm');
    await fs.writeFile(path.join(selected, 'clip.MOV'), 'mov');
    await fs.writeFile(path.join(selected, '.hidden.mp4'), 'hidden');
    await fs.writeFile(path.join(selected, 'notes.txt'), 'text');
    await fs.writeFile(path.join(selected, 'unsupported.ts'), 'ts');
    const location = await registerExternalLocation(selected);
    const repeated = await registerExternalLocation(selected + path.sep);
    expect(repeated.id).toBe(location.id);
    const first = await scanExternalLocation(location.id);
    const second = await scanExternalLocation(location.id);
    expect(second.files).toEqual(first.files);
    expect(first.files.map((file) => file.name).sort()).toEqual(['Episode.m4v', 'clip.MOV', 'movie.mp4', 'other.webm']);
    expect(first.files.find((file) => file.name === 'Episode.m4v')).toMatchObject({ format: 'MP4', relativePath: 'Season 1/Episode.m4v' });
    expect(first.files.every((file) => /^[a-f0-9]{32}$/.test(file.id) && !('reference' in file))).toBe(true);
    expect(first.truncated).toBe(false);
    expect((await fs.readdir(path.join(library, '.libretv/external'))).filter((name) => name.startsWith('location-'))).toHaveLength(1);
    expect((await listExternalLocations())[0]).toEqual(location);
    expect(mocks.exec.mock.calls.find(([file]) => file === '/usr/sbin/diskutil')?.[1]).toEqual(['info', '-plist', mount]);
  });

  it('stores index data only in the configured library and never reads or writes the video during scanning', async () => {
    const open = vi.spyOn(fs, 'open');
    const write = vi.spyOn(fs, 'writeFile');
    const mkdir = vi.spyOn(fs, 'mkdir');
    const location = await registerExternalLocation(selected);
    await scanExternalLocation(location.id);
    expect(open.mock.calls.every(([file]) => String(file).startsWith(library + path.sep))).toBe(true);
    expect(write.mock.calls.every(([file]) => String(file).startsWith(library + path.sep))).toBe(true);
    expect(mkdir.mock.calls.every(([file]) => String(file).startsWith(library))).toBe(true);
    expect(await fs.readdir(selected)).toEqual(['movie.mp4']);
  });

  it('opens a selected indexed file read-only without copying it', async () => {
    const { reference } = await one();
    const spy = vi.spyOn(fs, 'open');
    const handle = await openExternalMedia(reference);
    expect(await handle.readFile('utf8')).toBe('video');
    await handle.close();
    const mediaOpen = spy.mock.calls.find(([file]) => String(file) === path.join(selected, 'movie.mp4'))!;
    expect(typeof mediaOpen[1]).toBe('number');
    expect((mediaOpen[1] as number) & constants.O_NOFOLLOW).toBeTruthy();
    expect((mediaOpen[1] as number) & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)).toBe(0);
    expect(await externalMediaStatus(reference)).toEqual({ available: true });
  });

  it('does not accept arbitrary file ids or an unscanned file merely because the filename is known', async () => {
    const { location } = await one();
    await fs.writeFile(path.join(selected, 'new.mp4'), 'new');
    await expect(resolveExternalMedia(location.id, 'f'.repeat(32))).rejects.toThrow('不在扫描索引');
    await expect(resolveExternalMedia('../location', 'f'.repeat(32))).rejects.toThrow('编号');
    const scan = await scanExternalLocation(location.id);
    const added = scan.files.find((file) => file.name === 'new.mp4')!;
    expect((await resolveExternalMedia(location.id, added.id)).filename).toBe('new.mp4');
  });

  it('rejects a selected symlink and skips symlink files and directory trees', async () => {
    const outside = path.join(directory, 'private');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.mp4'), 'private');
    await fs.symlink(selected, path.join(directory, 'alias'));
    await expect(registerExternalLocation(path.join(directory, 'alias'))).rejects.toThrow('符号链接');
    await fs.symlink(path.join(outside, 'secret.mp4'), path.join(selected, 'linked.mp4'));
    await fs.symlink(outside, path.join(selected, 'linked-folder'));
    const location = await registerExternalLocation(selected);
    expect((await scanExternalLocation(location.id)).files.map((file) => file.name)).toEqual(['movie.mp4']);
  });

  it('rejects a path that becomes a symlink after indexing', async () => {
    const { reference } = await one();
    const original = path.join(selected, 'movie.mp4');
    const outside = path.join(directory, 'outside.mp4');
    await fs.writeFile(outside, 'other');
    await fs.unlink(original); await fs.symlink(outside, original);
    expect(await externalMediaStatus(reference)).toEqual({ available: false, reason: 'unavailable' });
  });

  it('retains an offline location without creating a phantom mount and reconnects the same volume', async () => {
    const { reference, location } = await one();
    const detached = path.join(directory, 'detached');
    await fs.rename(mount, detached); volumes.get(mount)!.online = false;
    expect(await externalMediaStatus(reference)).toEqual({ available: false, reason: 'offline' });
    expect((await listExternalLocations())[0]).toEqual({ ...location, online: false });
    await expect(fs.stat(mount)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rename(detached, mount); volumes.get(mount)!.online = true;
    expect(await externalMediaStatus(reference)).toEqual({ available: true });
  });

  it('reconnects the registered UUID at a different mount name without changing ids', async () => {
    const { reference, location, file } = await one();
    const renamed = path.join(directory, 'Renamed Disk');
    await fs.rename(mount, renamed);
    volumes.delete(mount); volumes.set(renamed, { uuid: UUID_A, online: true });
    const newSelected = path.join(renamed, '电影');
    expect(await externalMediaStatus(reference)).toEqual({ available: true });
    expect((await listExternalLocations())[0]).toEqual({ ...location, path: newSelected });
    expect((await registerExternalLocation(newSelected)).id).toBe(location.id);
    expect((await scanExternalLocation(location.id)).files[0].id).toBe(file.id);
  });

  it('does not read a different volume mounted under the same name', async () => {
    const { reference } = await one();
    volumes.get(mount)!.uuid = UUID_B;
    const spy = vi.spyOn(fs, 'open');
    expect(await externalMediaStatus(reference)).toEqual({ available: false, reason: 'offline' });
    expect(spy.mock.calls.some(([file]) => String(file) === path.join(selected, 'movie.mp4'))).toBe(false);
  });

  it('does not register a volume without a confirmed stable UUID', async () => {
    const original = mocks.exec.getMockImplementation()!;
    mocks.exec.mockImplementation((file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (file === '/usr/sbin/diskutil') callback(null, `<plist><dict><key>MountPoint</key><string>${xml(mount)}</string></dict></plist>`, '');
      else original(file, args, options, callback);
    });
    await expect(registerExternalLocation(selected)).rejects.toMatchObject({ reason: 'offline' });
    await expect(fs.stat(path.join(library, '.libretv/external'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('freshly checks volume identity after opening and closes the handle on a hot swap', async () => {
    const { reference } = await one();
    const file = path.join(selected, 'movie.mp4');
    const originalOpen = fs.open.bind(fs);
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      const handle = await originalOpen(target, flags, mode);
      if (String(target) === file) { opened = handle; volumes.get(mount)!.uuid = UUID_B; }
      return handle;
    });
    await expect(openExternalMedia(reference)).rejects.toMatchObject({ reason: 'offline' });
    await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it.each(['size', 'modified', 'replacement'])('rejects a changed source file: %s', async (change) => {
    const { reference } = await one();
    const file = path.join(selected, 'movie.mp4');
    if (change === 'size') await fs.appendFile(file, 'more');
    else if (change === 'modified') await fs.utimes(file, new Date(), new Date(reference.mtimeMs + 2000));
    else {
      const replacement = path.join(selected, 'replacement.mp4');
      await fs.writeFile(replacement, 'video'); await fs.rename(replacement, file);
    }
    expect(await externalMediaStatus(reference)).toEqual({ available: false, reason: 'changed' });
  });

  it('detects a replacement between path checks and open, and closes its file handle', async () => {
    const { reference } = await one();
    const file = path.join(selected, 'movie.mp4');
    const replacement = path.join(selected, 'replacement.mp4');
    await fs.writeFile(replacement, 'video');
    const originalOpen = fs.open.bind(fs);
    let opened: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.spyOn(fs, 'open').mockImplementation(async (target, flags, mode) => {
      if (String(target) === file) {
        await fs.rename(replacement, file);
        opened = await originalOpen(target, flags, mode);
        return opened;
      }
      return originalOpen(target, flags, mode);
    });
    await expect(openExternalMedia(reference)).rejects.toMatchObject({ reason: 'changed' });
    await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('bounds directory depth and marks incomplete scans explicitly', async () => {
    let deep = selected;
    for (let index = 0; index < 10; index++) { deep = path.join(deep, 'nested'); await fs.mkdir(deep); }
    await fs.writeFile(path.join(deep, 'deep.mp4'), 'deep');
    const location = await registerExternalLocation(selected);
    const scan = await scanExternalLocation(location.id);
    expect(scan.truncated).toBe(true);
    expect(scan.files.map((file) => file.name)).toEqual(['movie.mp4']);
  });

  it('bounds the number of indexed videos', async () => {
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(path.join(selected, `file-${batch}-${index}.mp4`), 'v')));
    }
    const location = await registerExternalLocation(selected);
    const scan = await scanExternalLocation(location.id);
    expect(scan.files).toHaveLength(2000);
    expect(scan.truncated).toBe(true);
  }, 20_000);

  it('keeps filename parsing usable without the browser upload client', () => {
    expect(guessLibraryMetadata('教父 1972.mp4')).toEqual({ title: '教父', kind: 'movie', year: '1972' });
  });

  it.each([
    { relativePath: '../outside.mp4' }, { relativePath: '/absolute.mp4' }, { relativePath: 'dir\\file.mp4' }, { relativePath: 'dir/./file.mp4' },
    { relativePath: 'dir//file.mp4' }, { relativePath: 'script.js' }, { locationId: '../id' }, { ino: 'not-an-inode' }, { mtimeMs: Infinity }, { bytes: -1 }, { extra: true },
  ])('strictly validates saved references: %o', (patch) => {
    const reference: ExternalMediaReference = { version: 1, locationId: 'a'.repeat(32), relativePath: 'movie.mp4', bytes: 5, ino: '123', mtimeMs: 1000 };
    expect(() => validateExternalMediaReference({ ...reference, ...patch })).toThrow('外部');
  });
});
