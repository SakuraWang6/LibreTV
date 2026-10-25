import { isValidProxyUrl } from '@/lib/ssrf';
import { episodeFromLabel, playbackKind, titleSeason } from '@/lib/playback-source';
import type { SearchResultItem, SourceConfig, VideoDetail, VideoInfo } from '@/lib/types';
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
interface HtmlBlock { body: string; start: number; end: number; attributes: Record<string, string> }
function visibleHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
}

/** Only inspect complete, bounded containers; nested divs must not truncate metadata. */
function blocks(html: string, tag: string, className?: string): HtmlBlock[] {
  const found: HtmlBlock[] = [];
  const openings = new RegExp('<' + tag + '\\b([^>]{0,4096})>', 'gi');
  let opening: RegExpExecArray | null;
  while ((opening = openings.exec(html)) && found.length < 128) {
    const attrs = attributes(opening[1]);
    if (className && !attrs.class?.split(/\s+/).includes(className)) continue;
    const bodyStart = openings.lastIndex;
    const tokens = new RegExp('<\\/?' + tag + '\\b[^>]{0,4096}>', 'gi');
    tokens.lastIndex = bodyStart;
    let depth = 1;
    let token: RegExpExecArray | null;
    while ((token = tokens.exec(html))) {
      depth += /^<\//.test(token[0]) ? -1 : 1;
      if (!depth) {
        found.push({ body: html.slice(bodyStart, token.index), start: opening.index, end: tokens.lastIndex, attributes: attrs });
        openings.lastIndex = tokens.lastIndex;
        break;
      }
    }
  }
  return found;
}

function beforeRecommendations(html: string): string {
  for (const heading of html.matchAll(/<h[1-6]\b[^>]{0,4096}>([\s\S]{0,4096}?)<\/h[1-6]\s*>/gi)) {
    if (/^(?:猜你喜欢|相关推荐|为你推荐)/.test(text(heading[1]))) return html.slice(0, heading.index);
  }
  return html;
}

function labelledField(rows: string[], name: string): string | undefined {
  const labels = '主演|演员|导演|类型|类别|地区|国家|年份|年代|上映|简介';
  const pattern = new RegExp('(?:^|\\s)(?:' + name + ')\\s*[:：]\\s*(.*?)(?=\\s+(?:' + labels + ')\\s*[:：]|$)');
  for (const row of rows) {
    const value = row.match(pattern)?.[1]?.replace(/[,，/、\s]+$/, '').trim();
    if (value) return value.slice(0, 3000);
  }
}

function detailMetadata(html: string, source: SourceConfig): VideoInfo {
  const base = libvioOrigin(source);
  const info = blocks(html, 'div', 'vod-info')[0]?.body || blocks(html, 'div', 'stui-player__detail')[0]?.body || html;
  const items = blocks(info, 'span', 'meta-item').map((item) => text(item.body));
  const rows = [...items, ...blocks(info, 'p').map((item) => text(item.body))];
  const genericItems = items.filter((item) => !/[:：]|^(?:共\s*\d+\s*集|上映|更新)/.test(item));
  const year = labelledField(rows, '年份|年代')?.match(/(?:18|19|20|21)\d{2}/)?.[0]
    || genericItems.find((item) => /^(?:18|19|20|21)\d{2}$/.test(item));
  const typeName = labelledField(rows, '类型|类别') || genericItems.find((item) => /电影|剧集|连续剧|国产剧|韩剧|日剧|美剧|动漫|动画|综艺|纪录|动作|科幻|剧情|冒险/.test(item));
  const area = labelledField(rows, '地区|国家') || (genericItems[1] && genericItems[1] !== year ? genericItems[1] : undefined);
  const poster = html.match(/<img\b(?=[^>]{0,4096}\bid=["']js-poster-img["'])([^>]{0,4096})>/i);
  const posterAttrs = poster ? attributes(poster[1]) : {};
  const completeDescription = blocks(info, 'span', 'detail-content')[0]?.body;
  const description = completeDescription ? text(completeDescription) : labelledField(rows, '简介')
    || text(blocks(info, 'p', 'vod-desc')[0]?.body || '') || meta(html, 'og:description') || meta(html, 'description');
  return {
    title: text(info.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').slice(0, 200) || meta(html, 'og:title'),
    cover: publicUrl(meta(html, 'og:image') || posterAttrs['data-original'] || posterAttrs.src || '', base),
    desc: description?.slice(0, 3000), year, typeName, area,
    actor: labelledField(rows, '主演|演员'), director: labelledField(rows, '导演'),
    sourceKey: source.key, sourceName: source.name, sourceUrl: base,
  };
}

export function isLibvioChallenge(html: string): boolean {
  return /browser verification required|<title[^>]*>\s*(?:正在验证|Just a moment)|cf-chl-|工作量证明.{0,80}Proof-of-Work|验证由浏览器完成一次工作量证明/i.test(html);
}

export function parseLibvioSearch(html: string, source: SourceConfig): SearchResultItem[] {
  const base = libvioOrigin(source);
  const main = beforeRecommendations(visibleHtml(html.slice(0, MAX_LIBVIO_HTML)));
  const containers = blocks(main, 'ul', 'stui-vodlist');
  const scopes = containers.length ? containers.map((item) => item.body) : [main];
  const found = new Map<string, SearchResultItem>();
  for (const scope of scopes) {
    const cards = blocks(scope, 'li');
    for (const card of cards.length ? cards.map((item) => item.body) : [scope]) {
      for (const link of links(card, base)) {
        const page = libvioPageUrl(link.url, base);
        const id = page && new URL(page).pathname.match(/^\/detail\/(\d{1,18})\.html$/)?.[1];
        if (!id) continue;
        const image = link.body.match(/<img\b([^>]{0,4096})>/i);
        const attrs = image ? attributes(image[1]) : {};
        const name = text(link.attributes.title || attrs.alt || link.label).slice(0, 200);
        if (!name || /^(?:播放|详情|立即观看)$/.test(name)) continue;
        const pic = publicUrl(attrs['data-original'] || attrs['data-src'] || attrs.src || link.attributes['data-original'] || '', base);
        const remarks = text(blocks(card, 'span', 'pic-text')[0]?.body || '').slice(0, 100) || undefined;
        const previous = found.get(id);
        if (previous) { previous.pic ||= pic; previous.remarks ||= remarks; continue; }
        found.set(id, { sourceKey: source.key, sourceName: source.name, sourceUrl: base, sourceKind: 'libvio', pageUrl: page, vodId: id, name, ...(pic && { pic }), ...(remarks && { remarks }) });
        if (found.size >= 100) return [...found.values()];
      }
    }
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

/** Read only the site's known same-origin player wrapper, never arbitrary parser query strings. */
function knownFrameTargets(html: string, page: string): string[] {
  const targets: string[] = [];
  let origin: string;
  try { origin = new URL(page).origin; libvioOrigin({ url: page }); } catch { return targets; }
  for (const match of html.matchAll(/<iframe\b([^>]{0,4096})>/gi)) {
    const attrs = attributes(match[1]);
    const frame = attrs.src && publicUrl(attrs.src, page);
    if (!frame) continue;
    const url = new URL(frame);
    if (url.origin !== origin || url.pathname !== '/vid/plyr/vr2.php' || url.searchParams.getAll('url').length !== 1) continue;
    const raw = url.searchParams.get('url') || '';
    if (!/^https?:\/\//i.test(raw)) continue;
    const target = publicUrl(raw, page);
    if (target && (directLibvioMediaUrl(target, page) || CLOUD_HOSTS.has(new URL(target).hostname))) targets.push(target);
  }
  return [...new Set(targets)];
}

export interface LibvioParsedDetail { detail: VideoDetail; watchPages: { url: string; label: string }[] }
export function parseLibvioDetail(html: string, source: SourceConfig, id: string, pageUrl?: string): LibvioParsedDetail {
  html = beforeRecommendations(html.slice(0, MAX_LIBVIO_HTML));
  const main = visibleHtml(html);
  const base = libvioOrigin(source);
  const page = pageUrl || `${base}/detail/${id}.html`;
  const videoInfo = detailMetadata(main, source);
  const kind = playbackKind(videoInfo.typeName);
  const allLinks = links(main, base);
  const playlistBlocks = [...blocks(main, 'ul', 'stui-content__playlist'), ...blocks(main, 'ul', 'stui-play__list')];
  const playlistLinks = playlistBlocks.length ? playlistBlocks.flatMap((item) => links(item.body, base)) : allLinks;
  const labelFor = (raw: string, url?: string): string => {
    if (kind === 'movie') {
      const label = raw.trim();
      const qualityOnly = /^(?:(?:\d{3,4}p|[248]k|fhd|uhd|hdr10\+?|hdr|hd\d?|bd\d?|sd|蓝光|超清|高清|正片)[\s._+-]*)+$/i.test(label);
      return !label || qualityOnly ? '正片' : label;
    }
    const explicit = episodeFromLabel(raw);
    if (explicit) return `第${explicit}集`;
    // Keep combined/split cuts recognizable; they cannot safely map to one episode.
    const canUseOrdinal = !raw || (kind === 'tv' && /^(?:\d{3,4}p|[248]k|hdr?|bd|蓝光)(?:[\s简繁中字国语粤语]*)$/i.test(raw));
    const ordinal = canUseOrdinal && url ? Number(new URL(url).pathname.match(/-(\d+)\.html$/)?.[1]) || undefined : undefined;
    return ordinal ? `第${ordinal}集` : raw;
  };
  const watchPages = playlistLinks.filter((link) => {
    const url = libvioPageUrl(link.url, base);
    return url && new RegExp('^/w/' + id + '-\\d+-\\d+\\.html$').test(new URL(url).pathname);
  }).map((link) => ({ url: link.url, label: labelFor(link.label, link.url) }));
  const currentWatch = watchPages.find((item) => new URL(item.url).pathname === new URL(page).pathname);
  const currentWatchLink = playlistLinks.find((item) => new URL(item.url).pathname === new URL(page).pathname);
  const currentLabel = currentWatch?.label || labelFor('', page);
  const seasonFor = (label: string) => Number(label.match(/\bS(\d{1,2})E\d+\b/i)?.[1]) || titleSeason(label).season || titleSeason(videoInfo.title || '').season;
  const currentSeason = seasonFor(currentWatchLink?.label || '');
  const episodes: string[] = [];
  const labels: string[] = [];
  const seasons: Array<number | undefined> = [];
  const add = (raw: string, label = currentLabel) => {
    const media = directLibvioMediaUrl(raw, page);
    if (media && !episodes.includes(media) && episodes.length < 100) {
      episodes.push(media); labels.push(labelFor(label) || `第${episodes.length}集`); seasons.push(seasonFor(label) || currentSeason);
    }
  };
  const frameTargets = knownFrameTargets(main, page);
  for (const raw of [...playerUrls(html), ...frameTargets]) add(raw);
  for (const match of main.matchAll(/<(?:video|source)\b([^>]{0,4096})>/gi)) { const attrs = attributes(match[1]); if (attrs.src) add(attrs.src); }
  for (const link of allLinks) add(link.url, link.label);
  const externalLinks = allLinks.filter((link) => CLOUD_HOSTS.has(new URL(link.url).hostname)).map((link) => ({ label: link.label || '网盘资源', url: link.url }));
  for (const raw of [...playerUrls(html), ...frameTargets]) { const url = publicUrl(raw, page); if (url && CLOUD_HOSTS.has(new URL(url).hostname)) externalLinks.push({ label: '网盘资源', url }); }
  return { watchPages: [...new Map(watchPages.map((link) => [link.url, link])).values()].slice(0, 100), detail: {
    episodes, episodeLabels: labels,
    ...(seasons.length && seasons.every((season) => season !== undefined) && { episodeSeasons: seasons as number[] }),
    ...(episodes.length && { mediaContext: 'libvio' as const }),
    playbackType: episodes.length ? 'media' : externalLinks.length ? 'external' : 'unavailable', pageUrl: page,
    ...(!episodes.length && { message: externalLinks.length ? '该资源提供网盘分享，请在原网页打开；不是可直接播放或后台下载的视频地址。' : '网页未提供可直接播放的视频地址，可在原网页查看。' }),
    externalLinks: [...new Map(externalLinks.map((link) => [link.url, link])).values()].slice(0, 30), videoInfo,
  } };
}
