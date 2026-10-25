import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceConfig } from '@/lib/types';
import { parseLibvioDetail } from './parse';

const browser = vi.hoisted(() => ({ enabled: true, read: vi.fn() }));
vi.mock('./browser-client', async (actual) => ({ ...await actual<typeof import('./browser-client')>(), browserBridgeConfigured: () => browser.enabled, readLibvioBrowserPage: browser.read }));
vi.mock('@/lib/ssrf', async (actual) => ({ ...await actual<typeof import('@/lib/ssrf')>(), checkUpstreamAllowed: vi.fn(async () => ({ ok: true })) }));
const source: SourceConfig = { key: 'libvio', name: 'LIBVIO', url: 'https://libvio.host', kind: 'libvio' };
function detail(count: number) {
  return `<h1>无耻之徒第一季</h1><div class="vod-meta"><span class="meta-item">电视剧</span><span class="meta-item">2011</span></div><a href="/w/123-1-1.html">立即播放旧线路</a><ul class="stui-content__playlist">${Array.from({ length: count }, (_, i) => `<li><a href="/w/123-3-${i + 1}.html">第${String(i + 1).padStart(2, '0')}集</a></li>`).join('')}</ul><ul class="stui-content__playlist"><li><a href="/w/123-7-1.html">第1集其他线路</a></li></ul>`;
}
function mediaPage(url: string) {
  const episode = url.match(/-(\d+)\.html$/)![1];
  return `<h1>无耻之徒第一季</h1><div class="vod-meta"><span class="meta-item">电视剧</span></div><ul class="stui-play__list"><li><a href="/w/123-3-${episode}.html">第${episode}集</a></li></ul><iframe src="/vid/plyr/vr2.php?url=https://v.vimsec.app/series/S01E${episode}.mp4"></iframe>`;
}
beforeEach(() => { vi.resetModules(); browser.enabled = true; browser.read.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('on-demand LIBVIO playlist detail', () => {
  it('returns all 12 catalogue slots but resolves only the first requested real line3 page', async () => {
    browser.read.mockImplementation(async (url: string) => url.includes('/detail/') ? detail(12) : mediaPage(url));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123');
    expect(result.episodes).toHaveLength(12);
    expect(result.episodes.filter(Boolean)).toEqual(['https://v.vimsec.app/series/S01E1.mp4']);
    expect(result.episodeLabels).toEqual(Array.from({ length: 12 }, (_, i) => `第${i + 1}集`));
    expect(result).toMatchObject({ playbackType: 'media', mediaContext: 'libvio', videoInfo: { title: '无耻之徒第一季', year: '2011' } });
    expect(result.message).toBeUndefined();
    expect(result.episodeSeasons).toEqual(Array(12).fill(1));
    expect(result.pageUrl).toBe('https://libvio.host/w/123-3-1.html');
    expect(browser.read.mock.calls.slice(1).every(([url]) => url.includes('/w/123-3-'))).toBe(true);
    expect(browser.read).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(20_000);
  });
  it('preserves a longer catalogue without prefetching and resolves only the chosen index', async () => {
    browser.read.mockImplementation(async (url: string) => url.includes('/detail/') ? detail(30) : mediaPage(url));
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123', undefined, { index: 8 });
    expect(result.episodes).toHaveLength(30);
    expect(result.episodes[8]).toBe('https://v.vimsec.app/series/S01E9.mp4');
    expect(result.episodes.filter(Boolean)).toHaveLength(1);
    expect(result.episodeLabels?.[8]).toBe('第9集');
    expect(result.pageUrl).toBe('https://libvio.host/w/123-3-9.html');
    expect(browser.read).toHaveBeenCalledTimes(2);
  });
  it('keeps the catalogue and selected original-page link when one selected page is interrupted', async () => {
    browser.read.mockImplementation(async (url: string) => {
      if (url.includes('/detail/')) return detail(12);
      if (url.includes('-3-3.html')) throw new Error('interrupted');
      return mediaPage(url);
    });
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123', undefined, { index: 2 });
    expect(result.episodes).toEqual(Array(12).fill(''));
    expect(result.episodeLabels?.[2]).toBe('第3集');
    expect(result.playbackType).toBe('unavailable');
    expect(result.pageUrl).toBe('https://libvio.host/w/123-3-3.html');
    expect(result.videoInfo.title).toBe('无耻之徒第一季');
    expect(browser.read).toHaveBeenCalledTimes(2);
  });
  it('keeps the ordinary HTTP path limited to six seconds', async () => {
    browser.enabled = false;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(url.includes('/detail/') ? detail(1) : mediaPage(url))));
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { getLibvioDetail } = await import('./server');
    expect((await getLibvioDetail(source, '123')).episodes).toHaveLength(1);
    expect(timeout).toHaveBeenCalledWith(6000);
    expect(browser.read).not.toHaveBeenCalled();
  });
  it('normalizes pure movie quality labels while preserving actual part/year names', () => {
    const html = `<h1>教父1-3</h1><div class="vod-meta"><span class="meta-item">电影</span></div><ul class="stui-content__playlist">${['1.1972集', '2.1974集', '3.1990集', '1080P', '4KHDR', 'HD', '预告'].map((label, i) => `<li><a href="/w/653-1-${i + 1}.html">${label}</a></li>`).join('')}</ul>`;
    expect(parseLibvioDetail(html, source, '653').watchPages.map((page) => page.label)).toEqual(['1.1972集', '2.1974集', '3.1990集', '正片', '正片', '正片', '预告']);
  });
  it('matches a requested season and episode by one unique label rather than ordinal position', async () => {
    browser.read.mockImplementation(async (url: string) => url.includes('/detail/') ? detail(12) : mediaPage(url));
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123', undefined, { episodeNumber: 9, seasonNumber: 1 });
    expect(result.episodes[8]).toBe('https://v.vimsec.app/series/S01E9.mp4');
    expect(result.episodes.filter(Boolean)).toHaveLength(1);
    expect(browser.read).toHaveBeenLastCalledWith('https://libvio.host/w/123-3-9.html', expect.any(AbortSignal));
    for (const selection of [{ episodeNumber: 99 }, { episodeNumber: 9, seasonNumber: 2 }, { index: 0, episodeNumber: 9 }]) {
      browser.read.mockClear();
      const mismatch = await getLibvioDetail(source, '123', undefined, selection);
      expect(mismatch.playbackType).toBe('unavailable');
      expect(mismatch.episodes.every((url) => !url)).toBe(true);
      expect(browser.read).toHaveBeenCalledTimes(1);
    }
  });
  it('refuses duplicate or absent episode labels without fetching a guessed watch page', async () => {
    const { getLibvioDetail } = await import('./server');
    browser.read.mockResolvedValue(detail(3).replace('第02集', '第01集'));
    const duplicate = await getLibvioDetail(source, '123', undefined, { episodeNumber: 1, seasonNumber: 1 });
    expect(duplicate.playbackType).toBe('unavailable');
    expect(browser.read).toHaveBeenCalledTimes(1);
    browser.read.mockClear();
    browser.read.mockResolvedValue('<h1>未知剧集</h1><ul class="stui-content__playlist"><li><a href="/w/123-3-1.html">合集</a></li></ul>');
    expect((await getLibvioDetail(source, '123', undefined, { episodeNumber: 1 })).playbackType).toBe('unavailable');
    expect(browser.read).toHaveBeenCalledTimes(1);
  });
  it('keeps movie-part identity and selected watch link when the official page has no supported media', async () => {
    browser.read.mockImplementation(async (url: string) => url.includes('/detail/')
      ? '<h1>教父1-3</h1><div class="vod-meta"><span class="meta-item">电影</span></div><a href="/w/123-1-1.html">立即播放</a><ul class="stui-content__playlist"><li><a href="/w/123-3-1.html">1.1972集</a></li><li><a href="/w/123-3-2.html">2.1974集</a></li></ul>'
      : '<h1>教父1-3</h1><iframe src="/vid/plyr/yd.php?url=encrypted"></iframe>');
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123', undefined, { index: 1 });
    expect(result.episodeLabels).toEqual(['1.1972集', '2.1974集']);
    expect(result.episodes).toEqual(['', '']);
    expect(result.pageUrl).toBe('https://libvio.host/w/123-3-2.html');
    expect(result.playbackType).toBe('unavailable');
    expect(result.videoInfo.title).toBe('教父1-3');
  });
  it('does not misclassify an unready selected page using unrelated catalogue download links', async () => {
    browser.read.mockImplementation(async (url: string) => url.includes('/detail/')
      ? detail(12) + '<a href="https://pan.baidu.com/s/collection">合集下载</a>'
      : '<h1>本集</h1>');
    const { getLibvioDetail } = await import('./server');
    const result = await getLibvioDetail(source, '123', undefined, { index: 1 });
    expect(result.playbackType).toBe('unavailable');
    expect(result.message).toContain('手动重试');
    expect(result.externalLinks).toHaveLength(1);
    expect(result.episodes).toEqual(Array(12).fill(''));
  });
});
