import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SourceConfig, SourceSearchOutcome, VideoDetail } from '@/lib/types';
import { isLibvioChallenge, MAX_LIBVIO_HTML, parseLibvioDetail, parseLibvioSearch } from './parse';
import { libvioOrigin, libvioPageUrl, libvioSearchUrl } from './source';
import { browserBridgeConfigured, LibvioBrowserRequired, readLibvioBrowserPage } from './browser-client';
import { episodeFromLabel, titleSeason } from '@/lib/playback-source';

const blocked = new Map<string, number>();
const BLOCK_TTL = 90_000;
const BROWSER_MESSAGE = 'LIBVIO 需要在原站浏览器完成验证；本站未绕过验证，暂时无法读取网页内容。';
class BrowserRequired extends Error {}

/** Ordinary public HTTP only: no browser cookies, challenge solving, iframe/parser execution or proxy. */
async function page(url: string, signal?: AbortSignal): Promise<string> {
  if (browserBridgeConfigured()) return readLibvioBrowserPage(url, signal);
  const origin = libvioOrigin({ url });
  if ((blocked.get(origin) || 0) > Date.now()) throw new BrowserRequired(BROWSER_MESSAGE);
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(3500)]) : AbortSignal.timeout(3500);
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!libvioPageUrl(current, origin)) throw new Error('LIBVIO 跳转到非官方线路，已停止读取');
    const allowed = await checkUpstreamAllowed(current);
    if (!allowed.ok) throw new Error('LIBVIO 线路未通过公网地址检查');
    const response = await fetch(current, { redirect: 'manual', credentials: 'omit', signal: timeout, headers: { Accept: 'text/html', 'User-Agent': 'LibreTV/2.21 (public webpage adapter)' } });
    if ([401, 403, 429].includes(response.status)) {
      await response.body?.cancel();
      if (blocked.size > 20) blocked.clear();
      blocked.set(origin, Date.now() + BLOCK_TTL);
      throw new BrowserRequired(BROWSER_MESSAGE);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      const next = location && libvioPageUrl(location, current);
      if (!next) throw new Error('LIBVIO 跳转目标不可用');
      current = next; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`LIBVIO 网页暂不可用（HTTP ${response.status}）`); }
    const reader = response.body?.getReader(); if (!reader) return '';
    let size = 0; const parts: Uint8Array[] = [];
    try {
      while (true) {
        const value = await reader.read(); if (value.done) break;
        size += value.value.length;
        if (size > MAX_LIBVIO_HTML) throw new Error('LIBVIO 网页超过读取上限');
        parts.push(value.value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    const html = Buffer.concat(parts).toString('utf8');
    if (isLibvioChallenge(html)) { blocked.set(origin, Date.now() + BLOCK_TTL); throw new BrowserRequired(BROWSER_MESSAGE); }
    return html;
  }
  throw new Error('LIBVIO 网页重定向过多');
}

function safeMessage(error: unknown): string {
  if (error instanceof BrowserRequired || error instanceof LibvioBrowserRequired) return error.message;
  if (error instanceof Error && /LIBVIO/.test(error.message)) return error.message;
  return 'LIBVIO 网页暂时无法访问，请在原站浏览器打开。';
}
export async function searchLibvio(source: SourceConfig, term: string): Promise<SourceSearchOutcome> {
  const started = Date.now();
  try {
    const list = parseLibvioSearch(await page(libvioSearchUrl(source, term)), source);
    return { sourceKey: source.key, ok: true, list, ms: Date.now() - started };
  } catch (error) {
    return { sourceKey: source.key, ok: false, list: [], error: safeMessage(error), timedOut: false, ms: Date.now() - started };
  }
}
export interface LibvioDetailSelection { index?: number; episodeNumber?: number; seasonNumber?: number }

function selectedIndex(labels: string[], seasons: number[] | undefined, selection: LibvioDetailSelection): number | undefined {
  if (selection.episodeNumber !== undefined) {
    const matches = labels.map((label, index) => ({ index, episode: episodeFromLabel(label) }))
      .filter((item) => item.episode === selection.episodeNumber
        && (selection.seasonNumber === undefined || seasons?.[item.index] === selection.seasonNumber));
    if (matches.length !== 1 || (selection.index !== undefined && selection.index !== matches[0].index)) return;
    return matches[0].index;
  }
  if (selection.seasonNumber !== undefined) return;
  const index = selection.index ?? 0;
  return Number.isInteger(index) && index >= 0 && index < labels.length ? index : undefined;
}

export async function getLibvioDetail(source: SourceConfig, id: string, signal?: AbortSignal, selection: LibvioDetailSelection = {}): Promise<VideoDetail> {
  if (!/^\d{1,18}$/.test(id)) throw new Error('无效的 LIBVIO 作品编号');
  const origin = libvioOrigin(source);
  const pageUrl = `${origin}/detail/${id}.html`;
  const totalMs = browserBridgeConfigured() ? 20_000 : 6000;
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(totalMs)]) : AbortSignal.timeout(totalMs);
  try {
    const parsed = parseLibvioDetail(await page(pageUrl, deadline), source, id, pageUrl);
    if (!parsed.watchPages.length) {
      if (!parsed.detail.episodes.length) return parsed.detail;
      const index = selectedIndex(parsed.detail.episodeLabels || parsed.detail.episodes.map(() => ''), parsed.detail.episodeSeasons, selection);
      if (index !== undefined) return parsed.detail;
      return { ...parsed.detail, episodes: parsed.detail.episodes.map(() => ''), playbackType: 'unavailable', message: '未能在此来源唯一匹配所选分部或剧集，请手动选择。' };
    }
    // Keep one playback line: /w/<id>-1-1 and /w/<id>-2-1 are alternatives,
    // not two episodes. More pages remain available through the original site.
    const firstPage = new URL(parsed.watchPages[0].url);
    const firstLine = firstPage.pathname.split('-')[1];
    const primaryPages = parsed.watchPages.filter((watch) => {
      const url = new URL(watch.url);
      return url.origin === firstPage.origin && new RegExp(`^/w/${id}-${firstLine}-\\d+\\.html$`).test(url.pathname);
    });
    const catalogue = [...new Map(primaryPages.map((watch) => [new URL(watch.url).pathname, watch])).values()].slice(0, 100);
    const detail = parsed.detail;
    detail.episodes = catalogue.map(() => '');
    detail.episodeLabels = catalogue.map((watch) => watch.label);
    delete detail.mediaContext;
    const titleSeasonNumber = titleSeason(detail.videoInfo.title || '').season;
    const seasons = detail.episodeLabels.map((label) => Number(label.match(/\bS(\d{1,2})E\d+\b/i)?.[1]) || titleSeason(label).season || titleSeasonNumber);
    if (seasons.length && seasons.every((season) => season !== undefined)) detail.episodeSeasons = seasons as number[];
    else delete detail.episodeSeasons;
    const index = selectedIndex(detail.episodeLabels, detail.episodeSeasons, selection);
    if (index === undefined) {
      detail.playbackType = 'unavailable';
      detail.message = '未能在此来源唯一匹配所选分部或剧集，请手动选择；不会按集数猜测其他位置。';
      return detail;
    }
    const watch = catalogue[index];
    detail.pageUrl = watch.url;
    try {
      deadline.throwIfAborted();
      // Resolve only the requested real playlist position. Empty sibling slots
      // are a catalogue, never guessed media or pages handed to the player.
      const result = parseLibvioDetail(await page(watch.url, deadline), source, id, watch.url).detail;
      detail.externalLinks = [...(detail.externalLinks || []), ...(result.externalLinks || [])].slice(0, 30);
      const media = result.episodes.find((url) => !!url);
      if (media) {
        detail.episodes[index] = media;
        detail.playbackType = 'media'; detail.mediaContext = 'libvio'; delete detail.message;
      } else {
        const selectedExternal = !!result.externalLinks?.length;
        detail.playbackType = selectedExternal ? 'external' : 'unavailable';
        detail.message = selectedExternal ? '该分部或剧集提供外部网盘分享，不能作为视频地址直接播放或下载。' : '本集网页暂未提供可直接播放的视频，可能尚未加载完成；可稍后手动重试。';
      }
    } catch (error) {
      detail.playbackType = error instanceof BrowserRequired || error instanceof LibvioBrowserRequired ? 'browser-required' : 'unavailable';
      detail.message = safeMessage(error);
    }
    return detail;
  } catch (error) {
    return { episodes: [], playbackType: error instanceof BrowserRequired || error instanceof LibvioBrowserRequired ? 'browser-required' : 'unavailable', pageUrl, message: safeMessage(error), externalLinks: [{ label: '在 LIBVIO 打开', url: pageUrl }], videoInfo: { sourceKey: source.key, sourceName: source.name, sourceUrl: origin } };
  }
}
