import { LibraryError, validateLibraryMetadata } from '@/lib/local-library/server';
import type { LibraryEntry } from '@/lib/local-library/types';
import { itemId, type SyncConfig } from './storage';

const sessions = new Map<string, { password: string; cookie: string }>();
const FORMATS = new Set(['MP4', 'TS', 'WEBM', 'MOV']);

export async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new LibraryError('云端返回的数据过大', 502); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new LibraryError('云端返回的数据过大', 502); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new Uint8Array(Buffer.concat(chunks, length));
}

async function fetchRemote(config: SyncConfig, endpoint: string, options: RequestInit, signal?: AbortSignal): Promise<Response> {
  // Media bodies can take much longer on a low-bandwidth home/cloud link.
  // Authentication, catalog and cover requests keep their shorter deadline.
  const timeout = AbortSignal.timeout(/^\/api\/library\/[a-f0-9]{32}\/media$/.test(endpoint) ? 60_000 : 15_000);
  return fetch(`${config.origin}${endpoint}`, { ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
}

async function login(config: SyncConfig, signal?: AbortSignal): Promise<string> {
  const response = await fetchRemote(config, '/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: config.password }),
  }, signal);
  if (!response.ok) { await response.body?.cancel(); throw new LibraryError('无法登录云端影视库，请检查连接密码', 502); }
  await response.body?.cancel();
  const session = response.headers.get('set-cookie')?.match(/(?:^|,\s*)ltv_session=([^;,\s]+)/)?.[1];
  if (!session) throw new LibraryError('云端没有返回有效的登录会话', 502);
  const cookie = `ltv_session=${session}`;
  sessions.set(config.origin, { password: config.password, cookie });
  return cookie;
}

export async function remoteRequest(config: SyncConfig, endpoint: string, options: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  // Every caller builds fixed API paths with validated IDs; redirects cannot leak
  // the server-only session to a third-party host.
  if (!endpoint.startsWith('/api/') || endpoint.includes('://') || endpoint.includes('\\')) throw new LibraryError('无效的云端请求', 400);
  let cookie = sessions.get(config.origin);
  if (!cookie || cookie.password !== config.password) cookie = { password: config.password, cookie: await login(config, signal) };
  const send = (value: string) => fetchRemote(config, endpoint, { ...options, headers: { ...Object.fromEntries(new Headers(options.headers)), Cookie: value } }, signal);
  let response = await send(cookie.cookie);
  if (response.status === 401) {
    await response.body?.cancel();
    response = await send(await login(config, signal));
  }
  return response;
}

export function remoteItem(value: unknown): LibraryEntry {
  const entry = value as Partial<LibraryEntry> | null;
  if (!entry || !Number.isSafeInteger(entry.bytes) || (entry.bytes ?? 0) <= 0 || !FORMATS.has(entry.format ?? '') || typeof entry.createdAt !== 'string') throw new LibraryError('云端影视库记录格式不兼容', 502);
  const metadata = validateLibraryMetadata(entry);
  const id = itemId(entry.id);
  const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    ...metadata, id, groupId: typeof entry.groupId === 'string' ? entry.groupId.slice(0, 100) : id,
    bytes: entry.bytes!, format: entry.format!, createdAt: entry.createdAt.slice(0, 80),
    mediaUrl: `/api/library/${id}/media`, posterUrl: `/api/library/${id}/poster`,
    position: numeric(entry.position), duration: numeric(entry.duration),
    lastPlayedAt: typeof entry.lastPlayedAt === 'string' && Number.isFinite(Date.parse(entry.lastPlayedAt)) ? entry.lastPlayedAt.slice(0, 80) : undefined,
  };
}

export async function remoteCatalog(config: SyncConfig, signal?: AbortSignal): Promise<LibraryEntry[]> {
  const response = await remoteRequest(config, '/api/library', {}, signal);
  if (!response.ok) { await response.body?.cancel(); throw new LibraryError('云端影视库暂时不可用', 502); }
  const data = JSON.parse(Buffer.from(await boundedBytes(response, 16 * 1024 * 1024)).toString('utf8')) as { enabled?: boolean; items?: unknown[] };
  if (!data.enabled || !Array.isArray(data.items) || data.items.length > 10_000) throw new LibraryError('云端未开启磁盘影视库或记录过多', 502);
  return data.items.map(remoteItem);
}

export async function remoteProgress(config: SyncConfig, entry: LibraryEntry, expected: string | null, signal?: AbortSignal): Promise<LibraryEntry> {
  const response = await remoteRequest(config, `/api/library/${itemId(entry.id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ position: entry.position ?? 0, ...(entry.duration !== undefined ? { duration: entry.duration } : {}), expectedLastPlayedAt: expected }),
  }, signal);
  if (!response.ok) { await response.body?.cancel(); throw new LibraryError(response.status === 409 ? '两台设备的观看进度同时发生变化，请重新选择' : '云端观看进度暂时无法保存', response.status === 409 ? 409 : 502); }
  const result = JSON.parse(Buffer.from(await boundedBytes(response, 128 * 1024)).toString('utf8')) as { item?: unknown };
  return remoteItem(result.item);
}
