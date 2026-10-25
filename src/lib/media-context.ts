import { PROXY_BASE } from './m3u8';

/** Public embedding context only; never accepts browser cookies or caller headers. */
export type MediaContext = 'libvio';

export function parseMediaContext(value: unknown): MediaContext | undefined {
  if (value === undefined) return undefined;
  if (value === 'libvio') return value;
  throw new Error('不支持的媒体来源上下文');
}

export function mediaContextHeaders(context?: MediaContext): Record<string, string> {
  return context === 'libvio' ? { Referer: 'https://libvio.host/' } : {};
}

export function mediaProxyPrefix(context?: MediaContext): string {
  return context === 'libvio' ? '/api/proxy?mediaContext=libvio&url=' : PROXY_BASE;
}

/** Sources needing a public Referer use the same-origin proxy from the outset. */
export function buildMediaProxyUrl(url: string, context?: MediaContext): string {
  if (!context) return url;
  if (url.startsWith('/api/proxy?') || url.startsWith('/api/proxy/')) {
    const parsed = new URL(url, 'http://proxy.invalid');
    parsed.searchParams.set('mediaContext', context);
    return `${parsed.pathname}${parsed.search}`;
  }
  return `${mediaProxyPrefix(context)}${encodeURIComponent(url)}`;
}
