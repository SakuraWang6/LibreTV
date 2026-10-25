import fs, { type FileHandle } from 'node:fs/promises';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { withFileLock } from './file-lock';

export type ExternalMediaFormat = 'MP4' | 'WEBM' | 'MOV';
export interface ExternalLocation { id: string; path: string; label: string; online: boolean }
export interface ExternalMediaFile { id: string; name: string; relativePath: string; bytes: number; format: ExternalMediaFormat }
export interface ExternalScanResult { location: ExternalLocation; files: ExternalMediaFile[]; truncated: boolean }
export interface ExternalMediaReference { version: 1; locationId: string; relativePath: string; bytes: number; ino: string; mtimeMs: number }
export type ExternalMediaFailure = 'offline' | 'changed' | 'unavailable';

export class ExternalMediaError extends Error {
  constructor(message: string, readonly reason: ExternalMediaFailure = 'unavailable') { super(message); }
}

interface StoredLocation { version: 1; id: string; path: string; label: string; volumeUuid: string; mountPoint: string; relativeRoot?: string }
interface ScanFile extends ExternalMediaFile { reference: ExternalMediaReference }
interface StoredScan { version: 1; locationId: string; files: ScanFile[]; truncated: boolean }
interface Volume { uuid: string; mountPoint: string }
const ID = /^[a-f0-9]{32}$/;
const MAX_DEPTH = 8;
const MAX_FILES = 2000;
const MAX_ENTRIES = 20_000;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_LOCATIONS = 64;

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
const FORMATS: Record<string, ExternalMediaFormat> = { '.mp4': 'MP4', '.m4v': 'MP4', '.webm': 'WEBM', '.mov': 'MOV' };
const formatOf = (name: string): ExternalMediaFormat | undefined => FORMATS[path.extname(name).toLowerCase()];

function relativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || path.isAbsolute(value) || /[\\\x00-\x1f\x7f-\x9f]/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..') || value.split('/').length > MAX_DEPTH + 1) throw new ExternalMediaError('外部视频路径无效');
  return value;
}

export function validateExternalMediaReference(value: unknown): ExternalMediaReference {
  const data = value as Partial<ExternalMediaReference> | null;
  const fields = ['version', 'locationId', 'relativePath', 'bytes', 'ino', 'mtimeMs'];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== fields.length || Object.keys(data).some((key) => !fields.includes(key))
    || data.version !== 1 || typeof data.locationId !== 'string' || !ID.test(data.locationId)
    || typeof data.bytes !== 'number' || !Number.isSafeInteger(data.bytes) || data.bytes <= 0
    || typeof data.ino !== 'string' || !/^\d{1,30}$/.test(data.ino)
    || typeof data.mtimeMs !== 'number' || !Number.isFinite(data.mtimeMs) || data.mtimeMs < 0) throw new ExternalMediaError('外部视频引用无效');
  const relative = relativePath(data.relativePath);
  if (!formatOf(relative)) throw new ExternalMediaError('外部视频格式不支持');
  return { version: 1, locationId: data.locationId, relativePath: relative, bytes: data.bytes, ino: data.ino, mtimeMs: data.mtimeMs };
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) reject(new ExternalMediaError('无法确认磁盘身份，请检查磁盘连接', 'offline'));
      else resolve(stdout);
    });
  });
}

function decodeXml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function inspectVolume(directory: string): Promise<Volume> {
  const report = await run('/bin/df', ['-P', directory]);
  const line = report.trim().split('\n').at(-1) || '';
  const mountPoint = mountFromDf(line);
  if (!mountPoint || !path.isAbsolute(mountPoint) || /[\x00-\x1f]/.test(mountPoint)) throw new ExternalMediaError('无法识别磁盘挂载位置', 'offline');
  const plist = await run('/usr/sbin/diskutil', ['info', '-plist', mountPoint]);
  const uuid = plist.match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim().toUpperCase();
  const actualMount = plist.match(/<key>MountPoint<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!uuid || !/^[A-F0-9-]{8,80}$/.test(uuid) || !actualMount || decodeXml(actualMount) !== mountPoint || /<key>Mounted<\/key>\s*<false\s*\/>/.test(plist)) throw new ExternalMediaError('磁盘没有可用的稳定身份', 'offline');
  return { uuid, mountPoint };
}

// Share only a currently running discovery, never a time-based identity cache.
// Media opens use a separate fresh probe after opening their bound file handle.
const volumeProbes = new Map<string, Promise<Volume>>();
function volumeAt(directory: string): Promise<Volume> {
  const running = volumeProbes.get(directory);
  if (running) return running;
  const probe = inspectVolume(directory).finally(() => { if (volumeProbes.get(directory) === probe) volumeProbes.delete(directory); });
  volumeProbes.set(directory, probe);
  return probe;
}

function mountFromDf(line: string): string | undefined {
  return line.match(/^\S+\s+\d+\s+\d+\s+\d+\s+\S+\s+(.+)$/)?.[1]?.replace(/\\040/g, ' ');
}

/** Reject symlinks at every component, including the selected directory itself. */
async function realDirectory(directory: string): Promise<string> {
  if (typeof directory !== 'string' || directory.length > 4096 || !path.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) throw new ExternalMediaError('请选择真实文件夹');
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ExternalMediaError('不能引用符号链接或非文件夹路径');
  }
  return fs.realpath(resolved);
}

async function stateRoot(): Promise<string> {
  const configured = process.env.LOCAL_LIBRARY_DIR?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new ExternalMediaError('本地影视库未配置');
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  let root = await fs.realpath(configured);
  for (const part of ['.libretv', 'external']) {
    root = path.join(root, part);
    await fs.mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExternalMediaError('外部目录索引位置无效');
  }
  return root;
}

async function readJson<T>(file: string): Promise<T> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile() || (await handle.stat()).size > MAX_STATE_BYTES) throw new ExternalMediaError('外部目录索引过大');
    return JSON.parse(await handle.readFile('utf8')) as T;
  } finally { await handle.close(); }
}

async function atomicJson(file: string, data: unknown): Promise<void> {
  const temporary = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function readLocation(id: string): Promise<StoredLocation> {
  if (!ID.test(id)) throw new ExternalMediaError('外部目录编号无效');
  let location: StoredLocation;
  try { location = await readJson<StoredLocation>(path.join(await stateRoot(), `location-${id}.json`)); }
  catch { throw new ExternalMediaError('外部目录尚未登记'); }
  if (!location || location.version !== 1 || location.id !== id || typeof location.path !== 'string' || location.path.length > 4096 || !path.isAbsolute(location.path)
    || typeof location.mountPoint !== 'string' || !path.isAbsolute(location.mountPoint)
    || !/^[A-F0-9-]{8,80}$/.test(location.volumeUuid) || typeof location.label !== 'string'
    || (location.relativeRoot !== undefined && (typeof location.relativeRoot !== 'string' || /[\\\x00-\x1f\x7f]/.test(location.relativeRoot)
      || (location.relativeRoot !== '' && (path.isAbsolute(location.relativeRoot) || location.relativeRoot.split(path.sep).some((part) => !part || part === '..' || part === '.')))))
    || location.id !== digest(`${location.volumeUuid}\0${location.relativeRoot ?? location.path}`)) throw new ExternalMediaError('外部目录记录无效');
  return location;
}

async function discoverConnectedRoot(location: StoredLocation): Promise<string> {
  try {
    const directory = await realDirectory(location.path);
    if ((await volumeAt(directory)).uuid === location.volumeUuid) return directory;
  } catch { /* A disconnected or renamed mount is checked below without creating paths. */ }
  if (location.relativeRoot === undefined) throw new ExternalMediaError('磁盘未连接或原文件夹不可用', 'offline');
  let candidates: string[];
  try {
    // Use the OS mount table rather than walking other disks. External mounts
    // get priority; the UUID is still checked before any folder is inspected.
    candidates = [...new Set((await run('/bin/df', ['-P'])).split('\n').map(mountFromDf).filter((entry): entry is string => !!entry && path.isAbsolute(entry)))];
    candidates.sort((a, b) => Number(b.startsWith('/Volumes/')) - Number(a.startsWith('/Volumes/')));
    candidates = candidates.slice(0, 32);
  }
  catch { throw new ExternalMediaError('磁盘未连接或原文件夹不可用', 'offline'); }
  for (const candidate of candidates) {
    try {
      const volume = await volumeAt(candidate);
      if (volume.uuid !== location.volumeUuid) continue;
      return await realDirectory(path.join(volume.mountPoint, location.relativeRoot));
    } catch { /* Only a mount with the registered UUID may restore access. */ }
  }
  throw new ExternalMediaError('磁盘未连接或原文件夹不可用', 'offline');
}

const rootDiscoveries = new Map<string, Promise<string>>();
function connectedRoot(location: StoredLocation): Promise<string> {
  const running = rootDiscoveries.get(location.id);
  if (running) return running;
  const discovery = discoverConnectedRoot(location).finally(() => { if (rootDiscoveries.get(location.id) === discovery) rootDiscoveries.delete(location.id); });
  rootDiscoveries.set(location.id, discovery);
  return discovery;
}

export async function registerExternalLocation(directory: string): Promise<ExternalLocation> {
  const canonical = await realDirectory(directory);
  const volume = await volumeAt(canonical);
  const relative = path.relative(volume.mountPoint, canonical);
  const relativeRoot = !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : undefined;
  const id = digest(`${volume.uuid}\0${relativeRoot ?? canonical}`);
  const location: StoredLocation = { version: 1, id, path: canonical, label: path.basename(canonical) || canonical, volumeUuid: volume.uuid, mountPoint: volume.mountPoint, ...(relativeRoot !== undefined ? { relativeRoot } : {}) };
  const root = await stateRoot();
  await withFileLock(path.join(root, 'locations.lock'), async () => {
    const names = (await fs.readdir(root)).filter((name) => /^location-[a-f0-9]{32}\.json$/.test(name));
    if (!names.includes(`location-${id}.json`) && names.length >= MAX_LOCATIONS) throw new ExternalMediaError('登记的文件夹过多，请先整理已有位置');
    await atomicJson(path.join(root, `location-${id}.json`), location);
  });
  return { id, path: canonical, label: location.label, online: true };
}

export async function listExternalLocations(): Promise<ExternalLocation[]> {
  const root = await stateRoot();
  const names = (await fs.readdir(root)).filter((name) => /^location-[a-f0-9]{32}\.json$/.test(name));
  const result: ExternalLocation[] = [];
  for (const name of names) {
    const location = await readLocation(name.slice(9, -5));
    try { result.push({ id: location.id, path: await connectedRoot(location), label: location.label, online: true }); }
    catch { result.push({ id: location.id, path: location.path, label: location.label, online: false }); }
  }
  return result;
}

async function fileAt(root: string, relative: string) {
  const rel = relativePath(relative);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ExternalMediaError('外部文件夹路径不可用');
  let current = root;
  const parts = rel.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink() || stat.dev !== rootStat.dev || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new ExternalMediaError('外部视频路径不可用');
    if (index === parts.length - 1) return { file: current, stat };
  }
  throw new ExternalMediaError('外部视频路径不可用');
}

async function fileAtDirectory(root: string, relative: string): Promise<BigIntStats> {
  const rel = relativePath(relative);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ExternalMediaError('外部文件夹路径不可用');
  let current = root, result = rootStat;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    result = await fs.lstat(current, { bigint: true });
    if (result.isSymbolicLink() || !result.isDirectory() || result.dev !== rootStat.dev) throw new ExternalMediaError('外部文件夹路径不可用');
  }
  return result;
}

const fingerprint = (stat: BigIntStats) => ({ bytes: Number(stat.size), ino: stat.ino.toString(), mtimeMs: Number(stat.mtimeNs) / 1e6 });

export async function scanExternalLocation(locationId: string): Promise<ExternalScanResult> {
  const location = await readLocation(locationId);
  const directory = await connectedRoot(location);
  const rootStat = await fs.lstat(directory, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ExternalMediaError('外部文件夹路径不可用');
  let count = 0, truncated = false;
  const files: ScanFile[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (count >= MAX_ENTRIES) { truncated = true; return; }
    const current = relative ? path.join(directory, relative) : directory;
    if (relative) {
      const checked = await fileAtDirectory(directory, relative);
      if (checked.dev !== rootStat.dev) return;
    }
    const entries: Dirent[] = [];
    const iterator = await fs.opendir(current);
    for await (const entry of iterator) {
      if (++count > MAX_ENTRIES) { truncated = true; break; }
      if (!entry.name.startsWith('.')) entries.push(entry);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) { truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, rel);
      const stat = await fs.lstat(full, { bigint: true }).catch(() => undefined);
      if (!stat || stat.isSymbolicLink() || stat.dev !== rootStat.dev) continue;
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) { truncated = true; continue; }
        await walk(rel, depth + 1);
      } else if (stat.isFile()) {
        const format = formatOf(entry.name);
        const checked = await fileAt(directory, rel).catch(() => undefined);
        if (!checked) continue;
        const attributes = fingerprint(checked.stat);
        if (!format || attributes.bytes <= 0 || !Number.isSafeInteger(attributes.bytes) || rel.length > 4096 || /[\\\x00-\x1f\x7f-\x9f]/.test(rel)) continue;
        const reference = validateExternalMediaReference({ version: 1, locationId, relativePath: rel, ...attributes });
        files.push({ id: digest(`${locationId}\0${rel}`), name: entry.name, relativePath: rel, bytes: attributes.bytes, format, reference });
      }
    }
  };
  await walk('', 0);
  if ((await inspectVolume(directory)).uuid !== location.volumeUuid) throw new ExternalMediaError('磁盘连接已变化，请重新扫描', 'offline');
  const root = await stateRoot();
  await withFileLock(path.join(root, `scan-${locationId}.lock`), () => atomicJson(path.join(root, `scan-${locationId}.json`), { version: 1, locationId, files, truncated } satisfies StoredScan));
  return { location: { id: location.id, path: directory, label: location.label, online: true }, files: files.map(({ id, name, relativePath, bytes, format }) => ({ id, name, relativePath, bytes, format })), truncated };
}

export async function resolveExternalMedia(locationId: string, fileId: string): Promise<{ reference: ExternalMediaReference; filename: string; bytes: number; format: ExternalMediaFormat }> {
  if (!ID.test(locationId) || !ID.test(fileId)) throw new ExternalMediaError('外部视频编号无效');
  const scan = await readJson<StoredScan>(path.join(await stateRoot(), `scan-${locationId}.json`)).catch(() => undefined);
  if (!scan || scan.version !== 1 || scan.locationId !== locationId || !Array.isArray(scan.files) || scan.files.length > MAX_FILES) throw new ExternalMediaError('请先扫描已登记的文件夹');
  const matches = scan.files.filter((file) => file.id === fileId);
  if (matches.length !== 1) throw new ExternalMediaError('所选视频不在扫描索引中');
  const file = matches[0];
  const reference = validateExternalMediaReference(file.reference);
  if (reference.locationId !== locationId || file.id !== digest(`${locationId}\0${reference.relativePath}`) || file.relativePath !== reference.relativePath || file.bytes !== reference.bytes || file.format !== formatOf(reference.relativePath)) throw new ExternalMediaError('外部视频索引不一致');
  const handle = await openExternalMedia(reference); await handle.close();
  return { reference, filename: path.basename(reference.relativePath), bytes: reference.bytes, format: file.format };
}

export async function openExternalMedia(value: ExternalMediaReference): Promise<FileHandle> {
  const reference = validateExternalMediaReference(value);
  const location = await readLocation(reference.locationId);
  const directory = await connectedRoot(location);
  let handle: FileHandle | undefined;
  try {
    const { file, stat } = await fileAt(directory, reference.relativePath);
    const before = fingerprint(stat);
    if (before.bytes !== reference.bytes || before.ino !== reference.ino || before.mtimeMs !== reference.mtimeMs) throw new ExternalMediaError('外部视频已经变化，请重新扫描', 'changed');
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    const after = fingerprint(opened);
    if (!opened.isFile() || opened.dev !== stat.dev || after.bytes !== reference.bytes || after.ino !== reference.ino || after.mtimeMs !== reference.mtimeMs) throw new ExternalMediaError('外部视频已经变化，请重新扫描', 'changed');
    if ((await inspectVolume(directory)).uuid !== location.volumeUuid) throw new ExternalMediaError('磁盘连接已变化', 'offline');
    return handle;
  } catch (error) {
    await handle?.close();
    if (error instanceof ExternalMediaError) throw error;
    throw new ExternalMediaError('外部视频不可用，请检查磁盘和原文件');
  }
}

export async function externalMediaStatus(reference: ExternalMediaReference): Promise<{ available: boolean; reason?: ExternalMediaFailure }> {
  try {
    const saved = validateExternalMediaReference(reference);
    const location = await readLocation(saved.locationId);
    const directory = await connectedRoot(location);
    const { stat } = await fileAt(directory, saved.relativePath);
    const current = fingerprint(stat);
    if (current.bytes !== saved.bytes || current.ino !== saved.ino || current.mtimeMs !== saved.mtimeMs) return { available: false, reason: 'changed' };
    return { available: true };
  }
  catch (error) { return { available: false, reason: error instanceof ExternalMediaError ? error.reason : 'unavailable' }; }
}
