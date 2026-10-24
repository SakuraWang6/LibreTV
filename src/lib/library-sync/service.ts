import path from 'node:path';
import crypto from 'node:crypto';
import { getLibraryEntry, LibraryError, posterResponse, updateProgress } from '@/lib/local-library/server';
import type { LibraryEntry } from '@/lib/local-library/types';
import { boundedBytes, remoteCatalog, remoteProgress, remoteRequest } from './remote';
import { allMappings, allTasks, atomicJson, itemId, mappingFile, publicTask, readJson, syncConfig, syncRoot, taskFile, withLock, type CacheTask, type Catalog, type Mapping, type SyncConfig } from './storage';
import type { SyncProgress, SyncStatus } from './types';

export const progressVersion = (entry: LibraryEntry) => entry.lastPlayedAt ?? null;
export const progressOf = (entry: LibraryEntry): SyncProgress => ({ position: entry.position, duration: entry.duration, lastPlayedAt: entry.lastPlayedAt });
const safeConnectionError = '暂时无法连接云端影视库；本机已保存的视频仍可离线播放';

export async function refreshCatalog(config: SyncConfig, signal?: AbortSignal): Promise<Catalog> {
  const root = await syncRoot(config);
  try {
    const catalog: Catalog = { version: 1, items: await remoteCatalog(config, signal), online: true, checkedAt: Date.now() };
    await atomicJson(path.join(root, 'catalog.json'), catalog);
    return catalog;
  } catch {
    signal?.throwIfAborted();
    const previous = await readJson<Catalog>(path.join(root, 'catalog.json'));
    const catalog: Catalog = { version: 1, items: previous?.items ?? [], online: false, checkedAt: Date.now(), error: safeConnectionError };
    await atomicJson(path.join(root, 'catalog.json'), catalog);
    return catalog;
  }
}

export async function getSyncStatus(): Promise<SyncStatus> {
  let config: SyncConfig | null;
  try { config = syncConfig(); }
  catch (error) { return { enabled: false, online: false, catalog: [], progressConflicts: [], error: error instanceof LibraryError ? error.message : '云端影视库配置无效' }; }
  if (!config) return { enabled: false, online: false, catalog: [], progressConflicts: [] };
  const root = await syncRoot(config);
  const [catalog, tasks, mappings] = await Promise.all([readJson<Catalog>(path.join(root, 'catalog.json')), allTasks(root), allMappings(root)]);
  const localMappings = new Map<string, Mapping>();
  for (const mapping of mappings) {
    if (mapping.remoteOrigin === config.origin && await getLibraryEntry(mapping.localId).then(() => true).catch(() => false)) localMappings.set(mapping.remoteId, mapping);
  }
  const online = !!catalog?.online && Date.now() - catalog.checkedAt < 60_000;
  return {
    enabled: true, online, serverUrl: config.origin,
    catalog: (catalog?.items ?? []).map((entry) => ({
      ...entry, mediaUrl: '', posterUrl: `/api/library-sync/${entry.id}/poster`,
      ...(localMappings.has(entry.id) ? { cachedLocalId: localMappings.get(entry.id)!.localId } : {}),
      ...(tasks.find((task) => task.itemId === entry.id) ? { cacheTask: publicTask(tasks.find((task) => task.itemId === entry.id)!) } : {}),
    })),
    progressConflicts: [...localMappings.values()].flatMap((mapping) => mapping.conflict ? [mapping.conflict] : []),
    ...(!online ? { error: catalog?.error ?? safeConnectionError } : {}),
  };
}

function requiredConfig(): SyncConfig {
  const config = syncConfig();
  if (!config) throw new LibraryError('尚未配置云端影视库连接', 503);
  return config;
}

export async function enqueueCache(body: unknown): Promise<{ task: ReturnType<typeof publicTask> }> {
  const id = itemId((body as { itemId?: unknown } | null)?.itemId);
  const config = requiredConfig();
  const root = await syncRoot(config);
  let catalog = await readJson<Catalog>(path.join(root, 'catalog.json'));
  if (!catalog?.items.some((item) => item.id === id)) catalog = await refreshCatalog(config);
  const item = catalog.items.find((entry) => entry.id === id);
  if (!item) throw new LibraryError('请先连接云端并刷新影视库', 404);
  return withLock(root, `task-${id}`, async () => {
    const existing = await readJson<CacheTask>(taskFile(root, id));
    const mapping = await readJson<Mapping>(mappingFile(root, id));
    const cached = mapping && await getLibraryEntry(mapping.localId).then(() => true).catch(() => false);
    if (existing && (cached || ['queued', 'downloading'].includes(existing.status))) return { task: publicTask(existing) };
    const task: CacheTask = {
      version: 1, id, itemId: id, item, uploadId: existing?.uploadId ?? crypto.randomBytes(16).toString('hex'),
      status: cached ? 'completed' : 'queued', progress: cached ? 100 : existing?.progress ?? 0,
      createdAt: existing?.createdAt ?? Date.now(), updatedAt: Date.now(),
    };
    await atomicJson(taskFile(root, id), task);
    return { task: publicTask(task) };
  });
}

async function saveMapping(root: string, mapping: Mapping): Promise<void> { await atomicJson(mappingFile(root, mapping.remoteId), mapping); }

function sameProgress(left: LibraryEntry, right: LibraryEntry): boolean {
  return Math.abs((left.position ?? 0) - (right.position ?? 0)) < 0.25 && Math.abs((left.duration ?? 0) - (right.duration ?? 0)) < 1;
}

export async function synchronizeProgress(config: SyncConfig, items: LibraryEntry[], signal?: AbortSignal): Promise<void> {
  const root = await syncRoot(config);
  const remote = new Map(items.map((item) => [item.id, item]));
  for (const original of await allMappings(root)) {
    signal?.throwIfAborted();
    if (original.remoteOrigin !== config.origin || !remote.has(original.remoteId)) continue;
    await withLock(root, `mapping-${itemId(original.remoteId)}`, async () => {
      const mapping = await readJson<Mapping>(mappingFile(root, original.remoteId));
      if (!mapping) return;
      const local = await getLibraryEntry(mapping.localId).catch(() => undefined);
      const server = remote.get(mapping.remoteId)!;
      if (!local) return;
      const localChanged = progressVersion(local) !== mapping.localVersion;
      const serverChanged = progressVersion(server) !== mapping.serverVersion;
      if (localChanged && serverChanged && !sameProgress(local, server)) {
        const title = server.kind === 'tv' ? `${server.title} · 第 ${server.seasonNumber ?? 1} 季 第 ${server.episodeNumber ?? 1} 集` : server.title;
        mapping.conflict = { itemId: server.id, localId: local.id, title, local: progressOf(local), server: progressOf(server) };
      } else if (localChanged && !serverChanged) {
        const nextServer = await remoteProgress(config, { ...local, id: server.id }, progressVersion(server), signal);
        mapping.localVersion = progressVersion(local); mapping.serverVersion = progressVersion(nextServer); delete mapping.conflict;
        remote.set(server.id, nextServer);
      } else if (serverChanged && !localChanged) {
        const result = await updateProgress(local.id, { position: server.position ?? 0, ...(server.duration !== undefined ? { duration: server.duration } : {}), expectedLastPlayedAt: progressVersion(local) });
        mapping.localVersion = progressVersion(result.item); mapping.serverVersion = progressVersion(server); delete mapping.conflict;
      } else if (localChanged && serverChanged) {
        mapping.localVersion = progressVersion(local); mapping.serverVersion = progressVersion(server); delete mapping.conflict;
      }
      await saveMapping(root, mapping);
    }, signal);
  }
}

export async function resolveProgress(body: unknown): Promise<{ resolved: true }> {
  const data = body as { itemId?: unknown; choice?: unknown } | null;
  const id = itemId(data?.itemId);
  if (data?.choice !== 'local' && data?.choice !== 'server') throw new LibraryError('请选择本机或云端观看进度');
  const config = requiredConfig();
  const root = await syncRoot(config);
  await withLock(root, `mapping-${id}`, async () => {
    const mapping = await readJson<Mapping>(mappingFile(root, id));
    if (!mapping || mapping.remoteOrigin !== config.origin) throw new LibraryError('该影片尚未保存到本机', 404);
    const local = await getLibraryEntry(mapping.localId);
    const server = (await remoteCatalog(config)).find((entry) => entry.id === id);
    if (!server) throw new LibraryError('云端已找不到该影片', 404);
    if (data.choice === 'local') {
      const next = await remoteProgress(config, { ...local, id }, progressVersion(server));
      mapping.localVersion = progressVersion(local); mapping.serverVersion = progressVersion(next);
    } else {
      const next = await updateProgress(local.id, { position: server.position ?? 0, ...(server.duration !== undefined ? { duration: server.duration } : {}), expectedLastPlayedAt: progressVersion(local) });
      mapping.localVersion = progressVersion(next.item); mapping.serverVersion = progressVersion(server);
    }
    delete mapping.conflict;
    await saveMapping(root, mapping);
  });
  return { resolved: true };
}

export async function syncPoster(id: string, signal?: AbortSignal): Promise<Response> {
  itemId(id);
  const config = requiredConfig();
  const root = await syncRoot(config);
  const mapping = await readJson<Mapping>(mappingFile(root, id));
  if (mapping?.remoteOrigin === config.origin) {
    try { return await posterResponse(mapping.localId); } catch { /* Continue with the cached cloud cover. */ }
  }
  const cached = path.join(root, `poster-${id}.json`);
  const poster = await readJson<{ type: string; bytes: string }>(cached);
  const headers = (type: string) => ({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (poster) return new Response(new Uint8Array(Buffer.from(poster.bytes, 'base64')), { headers: headers(poster.type) });
  const catalog = await readJson<Catalog>(path.join(root, 'catalog.json'));
  if (!catalog?.items.some((entry) => entry.id === id)) throw new LibraryError('找不到云端海报', 404);
  const response = await remoteRequest(config, `/api/library/${id}/poster`, {}, signal);
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !/^image\/(jpeg|png|webp|gif|svg\+xml)(?:;|$)/i.test(type)) { await response.body?.cancel(); throw new LibraryError('云端海报暂时不可用', 502); }
  const bytes = await boundedBytes(response, 5 * 1024 * 1024);
  await atomicJson(cached, { type, bytes: Buffer.from(bytes).toString('base64') });
  return new Response(new Uint8Array(bytes), { headers: headers(type) });
}
