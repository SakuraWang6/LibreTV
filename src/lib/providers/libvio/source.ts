import type { SourceConfig } from '@/lib/types';

/** Only origins published by LIBVIO's public address page are provider pages. */
export const LIBVIO_ORIGINS = ['https://libvio.host', 'https://www.libvio.to', 'https://libviobd.com'] as const;
const HOSTS = new Set(['libvio.host', 'www.libvio.host', 'libvio.to', 'www.libvio.to', 'libviobd.com', 'www.libviobd.com']);
const PORTALS = new Set(['libvio.app', 'www.libvio.app', 'libviofabu.com', 'www.libviofabu.com', 'libfabu.com', 'www.libfabu.com', 'libviogroup.github.io']);

export function isLibvioSource(source: Pick<SourceConfig, 'url' | 'kind'>): boolean {
  if (source.kind === 'libvio') return true;
  try { const host = new URL(source.url).hostname; return HOSTS.has(host) || PORTALS.has(host); }
  catch { return false; }
}

export function libvioOrigin(source: Pick<SourceConfig, 'url'>): string {
  const url = new URL(source.url);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('LIBVIO 只接受官方 HTTPS 线路');
  if (PORTALS.has(url.hostname)) return LIBVIO_ORIGINS[0];
  if (!HOSTS.has(url.hostname)) throw new Error('不是 LIBVIO 官方发布的线路');
  return url.origin;
}

export function libvioPageUrl(raw: string, base: string): string | undefined {
  try { const url = new URL(raw, base); libvioOrigin({ url: url.href }); if (!HOSTS.has(url.hostname)) return; return url.href; }
  catch { return; }
}

export function libvioSearchUrl(source: Pick<SourceConfig, 'url'>, term: string): string {
  const url = new URL('/search/-------------.html', libvioOrigin(source));
  url.searchParams.set('wd', term.slice(0, 100));
  return url.href;
}
