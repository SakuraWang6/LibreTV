import type { SourceConfig } from './types';

// Retired website providers must not be interpreted as CMS APIs when loading
// an older settings export, subscription, or shared playback URL.
const RETIRED_SOURCE_HOSTS = new Set([
  'libvio.host', 'www.libvio.host', 'libvio.to', 'www.libvio.to',
  'libviobd.com', 'www.libviobd.com', 'libvio.app', 'www.libvio.app',
  'libviofabu.com', 'www.libviofabu.com', 'libfabu.com', 'www.libfabu.com',
  'libviogroup.github.io',
]);

export function isSupportedSource(value: unknown): value is SourceConfig {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  if (typeof source.key !== 'string' || !source.key || typeof source.name !== 'string'
    || typeof source.url !== 'string' || !source.url.trim()) return false;
  if ((source.kind !== undefined && source.kind !== 'cms')
    || (source.sourceKind !== undefined && source.sourceKind !== 'cms')) return false;
  try {
    for (const raw of [source.url, source.detail]) {
      if (raw === undefined || raw === '') continue;
      if (typeof raw !== 'string') return false;
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || RETIRED_SOURCE_HOSTS.has(url.hostname)) return false;
    }
    return true;
  } catch { return false; }
}
