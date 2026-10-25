'use client';

import type { ExternalLocation, ExternalMediaFile, ExternalScanResult } from './external-media';
import { LOCAL_LIBRARY_UPDATED_EVENT, type LibraryEntry, type LibraryMetadata } from './types';

export type { ExternalLocation, ExternalMediaFile, ExternalScanResult };

async function externalRequest<T>(url: string, body?: unknown, timeout = 30_000): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new Error('读取媒体目录失败，请确认本机服务正在运行'); }
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || '媒体目录暂时不可用');
  return result;
}

export async function fetchLibraryLocations(): Promise<{ enabled: boolean; locations: ExternalLocation[] }> {
  const result = await externalRequest<{ enabled: boolean; locations: ExternalLocation[] }>('/api/library/locations');
  if (!Array.isArray(result.locations)) throw new Error('媒体目录返回异常');
  return result;
}

export function chooseLibraryLocation(): Promise<{ cancelled: true } | { cancelled: false; location: ExternalLocation }> {
  return externalRequest('/api/library/locations', { action: 'choose' }, 135_000);
}

export function addLibraryLocation(path: string): Promise<{ location: ExternalLocation }> {
  return externalRequest('/api/library/locations', { action: 'add', path: path.trim() });
}

export function scanLibraryLocation(locationId: string): Promise<ExternalScanResult> {
  return externalRequest('/api/library/locations', { action: 'scan', locationId }, 90_000);
}

export async function indexLibraryReference(locationId: string, fileId: string, metadata: LibraryMetadata): Promise<{ item: LibraryEntry; existing?: boolean }> {
  const result = await externalRequest<{ item: LibraryEntry; existing?: boolean }>('/api/library/references', { locationId, fileId, metadata });
  if (!result.item?.id) throw new Error('影视库未确认文件索引');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOCAL_LIBRARY_UPDATED_EVENT));
  return result;
}
