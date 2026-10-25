import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { SourceConfig, SourceSearchOutcome, VideoDetail } from '@/lib/types';
import { isLibvioChallenge, MAX_LIBVIO_HTML, parseLibvioDetail, parseLibvioSearch } from './parse';
import { libvioOrigin, libvioPageUrl, libvioSearchUrl } from './source';

const blocked = new Map<string, number>();
const BLOCK_TTL = 90_000;
const BROWSER_MESSAGE = 'LIBVIO 需要在原站浏览器完成验证；本站未绕过验证，暂时无法读取网页内容。';
class BrowserRequired extends Error {}

/** Ordinary public HTTP only: no browser cookies, challenge solving, iframe/parser execution or proxy. */
async function page(url: string, signal?: AbortSignal): Promise<string> {
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
  if (error instanceof BrowserRequired) return error.message;
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
export async function getLibvioDetail(source: SourceConfig, id: string, signal?: AbortSignal): Promise<VideoDetail> {
  if (!/^\d{1,18}$/.test(id)) throw new Error('无效的 LIBVIO 作品编号');
  const origin = libvioOrigin(source);
  const pageUrl = `${origin}/detail/${id}.html`;
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
  try {
    const parsed = parseLibvioDetail(await page(pageUrl, deadline), source, id, pageUrl);
    if (parsed.detail.episodes.length || !parsed.watchPages.length) return parsed.detail;
    // Keep one playback line: /w/<id>-1-1 and /w/<id>-2-1 are alternatives,
    // not two episodes. More pages remain available through the original site.
    const firstLine = new URL(parsed.watchPages[0].url).pathname.split('-')[1];
    const primaryPages = parsed.watchPages.filter((watch) => new URL(watch.url).pathname.split('-')[1] === firstLine);
    for (const watch of primaryPages.slice(0, 4)) {
      const result = parseLibvioDetail(await page(watch.url, deadline), source, id, watch.url).detail;
      if (result.episodes.length) {
        for (const episode of result.episodes) {
          if (parsed.detail.episodes.includes(episode)) continue;
          parsed.detail.episodes.push(episode);
          (parsed.detail.episodeLabels ||= []).push(watch.label || `第 ${parsed.detail.episodes.length} 集`);
        }
      }
      parsed.detail.externalLinks = [...(parsed.detail.externalLinks || []), ...(result.externalLinks || [])].slice(0, 30);
    }
    if (parsed.detail.episodes.length) {
      parsed.detail.playbackType = 'media';
      if (primaryPages.length > 4) parsed.detail.message = '当前仅解析首条播放线路的前 4 个公开播放页；更多剧集可在原网页查看。';
      else delete parsed.detail.message;
    }
    else if (parsed.detail.externalLinks?.length) { parsed.detail.playbackType = 'external'; parsed.detail.message = '该资源提供网盘分享，需在原网页打开，不能作为视频地址直接下载。'; }
    return parsed.detail;
  } catch (error) {
    return { episodes: [], playbackType: error instanceof BrowserRequired ? 'browser-required' : 'unavailable', pageUrl, message: safeMessage(error), externalLinks: [{ label: '在 LIBVIO 打开', url: pageUrl }], videoInfo: { sourceKey: source.key, sourceName: source.name, sourceUrl: origin } };
  }
}
