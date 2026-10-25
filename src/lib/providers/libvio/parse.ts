import { isValidProxyUrl } from '@/lib/ssrf';
import type { SearchResultItem, SourceConfig, VideoDetail } from '@/lib/types';
import { libvioOrigin, libvioPageUrl } from './source';

export const MAX_LIBVIO_HTML = 1024 * 1024;
interface Link { url: string; label: string; attributes: Record<string, string>; body: string }
const CLOUD_HOSTS = new Set(['pan.quark.cn', 'pan.xunlei.com', 'pan.baidu.com', 'drive.uc.cn', 'www.aliyundrive.com', 'www.alipan.com', '115.com', 'caiyun.139.com']);

function entities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, code: string) => {
    if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[code.toLowerCase()] ?? raw;
  });
}
function text(value: string): string { return entities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1].toLowerCase()] = entities(match[2] ?? match[3] ?? match[4]);
  return result;
}
function publicUrl(raw: string, base: string): string | undefined {
  if (!raw.trim() || raw.length > 8192) return;
  try { const url = new URL(entities(raw), base); return !url.username && !url.password && isValidProxyUrl(url.href) ? url.href : undefined; }
  catch { return; }
}
function links(html: string, base: string): Link[] {
  const result: Link[] = [];
  for (const match of html.slice(0, MAX_LIBVIO_HTML).matchAll(/<a\b([^>]{0,4096})>/gi)) {
    if (result.length >= 512) break;
    const attrs = attributes(match[1]);
    const url = attrs.href && publicUrl(attrs.href, base);
    if (!url) continue;
    const start = (match.index ?? 0) + match[0].length;
    const body = html.slice(start, start + 4096).split(/<\/a\s*>/i)[0];
    result.push({ url, attributes: attrs, body, label: text(attrs.title || body).slice(0, 200) });
  }
  return result;
}
function meta(html: string, key: string): string | undefined {
  for (const match of html.matchAll(/<meta\b([^>]{0,4096})>/gi)) {
    const attrs = attributes(match[1]);
    if ((attrs.property || attrs.name) === key && attrs.content) return text(attrs.content).slice(0, 3000);
  }
}
export function isLibvioChallenge(html: string): boolean {
  return /browser verification required|<title[^>]*>\s*(?:正在验证|Just a moment)|cf-chl-|工作量证明.{0,80}Proof-of-Work|验证由浏览器完成一次工作量证明/i.test(html);
}

export function parseLibvioSearch(html: string, source: SourceConfig): SearchResultItem[] {
  const base = libvioOrigin(source);
  const found = new Map<string, SearchResultItem>();
  for (const link of links(html, base)) {
    const page = libvioPageUrl(link.url, base);
    const id = page && new URL(page).pathname.match(/^\/detail\/(\d{1,18})\.html$/)?.[1];
    if (!id) continue;
    const image = link.body.match(/<img\b([^>]{0,4096})>/i);
    const attrs = image ? attributes(image[1]) : {};
    const name = text(link.attributes.title || attrs.alt || link.label).slice(0, 200);
    if (!name || /^(?:播放|详情|立即观看)$/.test(name)) continue;
    const pic = publicUrl(attrs['data-original'] || attrs['data-src'] || attrs.src || link.attributes['data-original'] || '', base);
    const previous = found.get(id);
    if (previous) { previous.pic ||= pic; continue; }
    found.set(id, { sourceKey: source.key, sourceName: source.name, sourceUrl: base, sourceKind: 'libvio', pageUrl: page, vodId: id, name, ...(pic && { pic }) });
    if (found.size >= 100) break;
  }
  return [...found.values()];
}

/** Parse JSON assignments only. Never evaluate site JavaScript or third-party parsers. */
function playerUrls(html: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(/(?:var|let|const)\s+player_[\w]+\s*=\s*(?=\{)/g)) {
    if (values.length >= 8) break;
    const start = (match.index ?? 0) + match[0].length;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < Math.min(html.length, start + 64 * 1024); i++) {
      const c = html[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          const data = JSON.parse(html.slice(start, i + 1)) as { url?: unknown; encrypt?: unknown };
          if (typeof data.url === 'string' && data.url.length < 8192) {
            let url = data.url;
            if (String(data.encrypt) === '2' && /^[\da-z+/=]+$/i.test(url)) url = Buffer.from(url, 'base64').toString('utf8');
            if (String(data.encrypt) === '1' || String(data.encrypt) === '2') url = decodeURIComponent(url);
            if (data.encrypt === undefined || ['0', '1', '2'].includes(String(data.encrypt))) values.push(url);
          }
        } catch { /* Executable expressions, unknown encryption and malformed JSON stay unparsed. */ }
        break;
      }
    }
  }
  return values;
}
export function directLibvioMediaUrl(raw: string, base: string): string | undefined {
  const url = publicUrl(raw, base);
  if (!url) return;
  const parsed = new URL(url);
  if (CLOUD_HOSTS.has(parsed.hostname)) return;
  return /\.(?:m3u8|mp4)$/i.test(parsed.pathname) ? url : undefined;
}

export interface LibvioParsedDetail { detail: VideoDetail; watchPages: { url: string; label: string }[] }
export function parseLibvioDetail(html: string, source: SourceConfig, id: string, pageUrl?: string): LibvioParsedDetail {
  html = html.slice(0, MAX_LIBVIO_HTML);
  const base = libvioOrigin(source);
  const page = pageUrl || `${base}/detail/${id}.html`;
  const allLinks = links(html, base);
  const episodes: string[] = [];
  const labels: string[] = [];
  const add = (raw: string, label: string) => { const media = directLibvioMediaUrl(raw, page); if (media && !episodes.includes(media) && episodes.length < 100) { episodes.push(media); labels.push(label || `第 ${episodes.length} 集`); } };
  for (const raw of playerUrls(html)) add(raw, '');
  for (const match of html.matchAll(/<(?:video|source)\b([^>]{0,4096})>/gi)) { const attrs = attributes(match[1]); if (attrs.src) add(attrs.src, ''); }
  for (const link of allLinks) add(link.url, link.label);
  const externalLinks = allLinks.filter((link) => CLOUD_HOSTS.has(new URL(link.url).hostname)).map((link) => ({ label: link.label || '网盘资源', url: link.url }));
  for (const raw of playerUrls(html)) { const url = publicUrl(raw, page); if (url && CLOUD_HOSTS.has(new URL(url).hostname)) externalLinks.push({ label: '网盘资源', url }); }
  const watchPages = allLinks.filter((link) => {
    const url = libvioPageUrl(link.url, base);
    return url && new RegExp('^/w/' + id + '-\\d+-\\d+\\.html$').test(new URL(url).pathname);
  }).map((link) => ({ url: link.url, label: link.label }));
  const title = meta(html, 'og:title') || text(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').slice(0, 200);
  return { watchPages: [...new Map(watchPages.map((link) => [link.url, link])).values()].slice(0, 100), detail: {
    episodes, episodeLabels: labels, playbackType: episodes.length ? 'media' : externalLinks.length ? 'external' : 'unavailable', pageUrl: page,
    ...(!episodes.length && { message: externalLinks.length ? '该资源提供网盘分享，请在原网页打开；不是可直接播放或后台下载的视频地址。' : '网页未提供可直接播放的视频地址，可在原网页查看。' }),
    externalLinks: [...new Map(externalLinks.map((link) => [link.url, link])).values()].slice(0, 30),
    videoInfo: { title, cover: publicUrl(meta(html, 'og:image') || '', base), desc: meta(html, 'og:description') || meta(html, 'description'), sourceKey: source.key, sourceName: source.name, sourceUrl: base },
  } };
}
