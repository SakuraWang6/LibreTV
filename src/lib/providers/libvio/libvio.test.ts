import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLibvioSource, libvioOrigin, libvioSearchUrl } from './source';
import { directLibvioMediaUrl, isLibvioChallenge, parseLibvioDetail, parseLibvioSearch } from './parse';
import { getEnvSources } from '@/lib/env-sources';
import { parseSourceListPayload } from '@/lib/source-list';
import { buildWatchUrl } from '@/lib/utils';
import type { SourceConfig } from '@/lib/types';

vi.mock('@/lib/ssrf', async (original) => ({ ...await original<typeof import('@/lib/ssrf')>(), checkUpstreamAllowed: vi.fn(async () => ({ ok: true })) }));
const source: SourceConfig = { key: 'libvio', name: 'LIBVIO', url: 'https://libvio.host', kind: 'libvio' };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('bounded public LIBVIO HTML parser', () => {
  it('recognizes only published hosts and rejects hostile origins', () => {
    expect(isLibvioSource({ url: 'https://www.libvio.to' })).toBe(true);
    expect(isLibvioSource({ url: 'https://libvio.host.evil.test' })).toBe(false);
    expect(libvioOrigin({ url: 'https://www.libvio.app' })).toBe('https://libvio.host');
    for (const url of ['http://libvio.host', 'https://libvio.host:8888', 'https://user@libvio.host', 'https://127.0.0.1']) expect(() => libvioOrigin({ url })).toThrow();
    expect(new URL(libvioSearchUrl(source, '片名 & 值')).searchParams.get('wd')).toBe('片名 & 值');
  });
  it('extracts and deduplicates public detail anchors without HTML or script injection', () => {
    const html = `<a href="/detail/123.html" title="电影 &amp; 名"><img data-original="https://images.example.test/a.jpg"></a><a href="/detail/123.html">电影</a><a href="https://evil.test/detail/456.html">广告</a><a href="/detail/789.html" title="另一部">查看</a>`;
    const list = parseLibvioSearch(html, source);
    expect(list.map((item) => [item.vodId, item.name])).toEqual([['123', '电影 & 名'], ['789', '另一部']]);
    expect(list[0]).toMatchObject({ sourceKind: 'libvio', pageUrl: 'https://libvio.host/detail/123.html' });
    expect(list[1].pic).toBeUndefined();
  });
  it('keeps netdisk shares external and never treats HTML/query media as playback', () => {
    const html = `<h1>片名</h1><script>var player_aaaa={"url":"https://pan.quark.cn/s/abc","encrypt":0}</script><iframe src="/static/player/kuake.html"></iframe><a href="https://pan.xunlei.com/s/xyz">迅雷</a><a href="https://parser.example.test/index.html?url=https://cdn.example.test/a.m3u8">播放</a>`;
    const { detail } = parseLibvioDetail(html, source, '123');
    expect(detail.episodes).toEqual([]); expect(detail.playbackType).toBe('external');
    expect(detail.externalLinks).toHaveLength(2);
    expect(directLibvioMediaUrl('https://parser.example.test/?url=x.mp4', source.url)).toBeUndefined();
  });
  it('decodes ordinary JSON URL encodings without executing site scripts', () => {
    const url = 'https://cdn.example.test/movie.m3u8?x=1';
    const encoded = Buffer.from(encodeURIComponent(url)).toString('base64');
    const { detail } = parseLibvioDetail(`<script>var player_aaaa={"url":"${encoded}","encrypt":2};</script>`, source, '123');
    expect(detail.episodes).toEqual([url]); expect(detail.playbackType).toBe('media');
    const bad = parseLibvioDetail('<script>var player_aaaa={url:(globalThis.attack=true,"https://cdn.example.test/x.mp4")}</script>', source, '123');
    expect(bad.detail.episodes).toEqual([]);
  });
  it('rejects reserved/private media and credentials even inside player JSON', () => {
    for (const url of ['http://127.0.0.1/a.mp4', 'http://169.254.169.254/a.m3u8', 'https://u:p@cdn.example.test/a.mp4', 'javascript:alert(1)', 'https://pan.quark.cn/s/a.mp4']) expect(directLibvioMediaUrl(url, source.url)).toBeUndefined();
    expect(isLibvioChallenge('403 Forbidden: browser verification required')).toBe(true);
    expect(isLibvioChallenge('<h1>电影验证码</h1>')).toBe(false);
  });
  it('limits search to the result list and excludes history and recommendation anchors', () => {
    const html = `<nav><a href="/detail/999.html" title="历史影片">历史影片</a></nav>
      <ul class="stui-vodlist clearfix"><li><a class="stui-vodlist__thumb" href="/detail/714891136.html" title="流浪地球2" data-original="https://images.example.test/earth.jpg"><span class="pic-text text-right">4KHDR</span></a><h4><a href="/detail/714891136.html">流浪地球2</a></h4></li></ul>
      <h3><a>猜你喜欢</a></h3><ul class="stui-vodlist"><li><a href="/detail/888.html" title="不相关推荐">不相关推荐</a></li></ul>`;
    expect(parseLibvioSearch(html, source)).toEqual([expect.objectContaining({ vodId: '714891136', name: '流浪地球2', remarks: '4KHDR', pic: 'https://images.example.test/earth.jpg' })]);
    expect(parseLibvioSearch('<ul class="stui-vodlist"></ul><h3>猜你喜欢</h3><a href="/detail/888.html">推荐</a>', source)).toEqual([]);
  });

  it('extracts real detail fields before recommendations and prefers h1 over an SEO title', () => {
    const html = `<meta property="og:title" content="错误的SEO标题 - LIBVIO"><div class="vod-poster"><img id="js-poster-img" data-original="https://images.example.test/marvel.jpg"></div>
      <div class="vod-info"><h1 class="title">惊奇队长</h1><div class="vod-meta"><span class="meta-item">动作,科幻,冒险,电影</span><span class="meta-item">美国,澳大利亚</span><span class="meta-item">2019</span><span class="meta-item">上映 2019-03-08</span><span class="meta-item">更新 2026-08-09</span></div>
      <div class="vod-meta"><span class="meta-item">主演：布丽·拉尔森,裘德·洛,</span></div><div class="vod-meta"><span class="meta-item">导演：安娜·波顿,瑞安·弗雷克</span></div>
      <p class="vod-desc"><span class="detail-sketch">摘要</span><span class="detail-content">完整简介 &amp; 更多。</span><a>展开</a></p></div>
      <ul class="stui-content__playlist"><li><a href="/w/653-1-1.html">1080P</a></li></ul><h3>猜你喜欢</h3><a href="/w/653-9-9.html">推荐</a>`;
    const parsed = parseLibvioDetail(html, source, '653');
    expect(parsed.detail.videoInfo).toMatchObject({ title: '惊奇队长', year: '2019', typeName: '动作,科幻,冒险,电影', area: '美国,澳大利亚', actor: '布丽·拉尔森,裘德·洛', director: '安娜·波顿,瑞安·弗雷克', desc: '完整简介 & 更多。', cover: 'https://images.example.test/marvel.jpg' });
    expect(parsed.watchPages).toEqual([{ url: 'https://libvio.host/w/653-1-1.html', label: '正片' }]);
  });

  it('reads a rendered same-origin known player iframe without treating quality text as an episode number', () => {
    const media = 'https://v.vimsec.app/2026/dy/8/Captain.Marvel/Captain.Marvel.2019.1080P_fixed.mp4';
    const html = `<nav><a href="/w/653-1-1.html">历史标题</a></nav><div class="stui-player__detail"><h1>惊奇队长</h1><div class="data-more"><p><span>主演：</span><a>布丽·拉尔森</a>&nbsp;<a>裘德·洛</a></p><p>导演：安娜·波顿</p><p>类型：动作,科幻,电影&nbsp;&nbsp;地区：美国,澳大利亚&nbsp;&nbsp;年份：2019</p><p>简介：这是完整的电影简介。</p></div></div>
      <ul class="stui-play__list"><li><a href="/w/653-1-1.html">1080P</a></li></ul><iframe src="/vid/plyr/vr2.php?url=${media}&amp;next=&amp;id=653&amp;nid=1"></iframe>`;
    const { detail } = parseLibvioDetail(html, source, '653', 'https://libvio.host/w/653-1-1.html');
    expect(detail).toMatchObject({ episodes: [media], episodeLabels: ['正片'], playbackType: 'media', mediaContext: 'libvio' });
    expect(detail.videoInfo).toMatchObject({ title: '惊奇队长', year: '2019', typeName: '动作,科幻,电影', area: '美国,澳大利亚', actor: '布丽·拉尔森 裘德·洛', desc: '这是完整的电影简介。' });
  });

  it('keeps explicit TV season and episode identity without confusing a playback-line number with a season', () => {
    const html = `<div class="vod-info"><h1>某剧 第二季</h1><div class="vod-meta"><span class="meta-item">国产剧</span><span class="meta-item">中国大陆</span><span class="meta-item">2024</span></div></div><ul class="stui-play__list"><li><a href="/w/123-7-3.html">03</a></li><li><a href="/w/123-7-4.html">第4-5集</a></li></ul><iframe src="/vid/plyr/vr2.php?url=https%3A%2F%2Fcdn.example.test%2Fs2e3.m3u8"></iframe>`;
    const parsed = parseLibvioDetail(html, source, '123', 'https://libvio.host/w/123-7-3.html');
    expect(parsed.detail).toMatchObject({ episodeLabels: ['第3集'], episodeSeasons: [2], mediaContext: 'libvio' });
    expect(parsed.watchPages.map((item) => item.label)).toEqual(['第3集', '第4-5集']);
  });

  it('refuses arbitrary iframe origins, wrapper paths, nested parsers, duplicate parameters and private targets', () => {
    const target = 'https://cdn.example.test/film.mp4';
    const frames = [
      `https://evil.test/vid/plyr/vr2.php?url=${target}`,
      `https://www.libvio.to/vid/plyr/vr2.php?url=${target}`,
      `/arbitrary/parser.php?url=${target}`,
      `/vid/plyr/vr2.php?url=https://parser.example.test/?url=${target}`,
      `/vid/plyr/vr2.php?url=${target}&url=https://cdn.example.test/other.mp4`,
      '/vid/plyr/vr2.php?url=http://127.0.0.1/private.mp4',
      '/vid/plyr/vr2.php?url=javascript:alert(1)',
    ];
    for (const frame of frames) expect(parseLibvioDetail(`<iframe src="${frame}"></iframe>`, source, '653').detail.episodes).toEqual([]);
    const external = parseLibvioDetail('<iframe src="/vid/plyr/vr2.php?url=https://pan.quark.cn/s/share"></iframe>', source, '653').detail;
    expect(external.playbackType).toBe('external'); expect(external.episodes).toEqual([]); expect(external.mediaContext).toBeUndefined();
  });

  it('keeps provider identity in env/subscription/share paths without enabling any default source', () => {
    vi.stubEnv('DEFAULT_SOURCES', JSON.stringify([source]));
    expect(getEnvSources()[0].kind).toBe('libvio');
    expect(parseSourceListPayload([{ name: '站点', url: source.url, kind: 'libvio' }]).sources[0].kind).toBe('libvio');
    expect(new URL(buildWatchUrl({ sourceKey: 'libvio', sourceKind: 'libvio', sourceUrl: source.url }), 'http://local.test').searchParams.get('sourceKind')).toBe('libvio');
  });
});

describe('ordinary public request dispatch and honest access states', () => {
  beforeEach(() => vi.resetModules());
  it('turns 403 into browser-required and short-circuits repeated searches', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('browser verification required', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const { getLibvioDetail, searchLibvio } = await import('./server');
    const detail = await getLibvioDetail(source, '123');
    expect(detail).toMatchObject({ playbackType: 'browser-required', episodes: [], pageUrl: 'https://libvio.host/detail/123.html' });
    expect((await searchLibvio(source, '片名')).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0][1];
    expect(init.credentials).toBe('omit'); expect(init.headers.Cookie).toBeUndefined();
  });
  it('does not follow a redirect outside the provider or into a private network', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }));
    vi.stubGlobal('fetch', fetcher);
    const { getLibvioDetail } = await import('./server');
    expect((await getLibvioDetail(source, '123')).episodes).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('serves representative public HTML through the same provider contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => new Response(url.includes('/search/') ? '<a href="/detail/123.html" title="片名">片名</a>' : '<h1>片名</h1><video src="https://cdn.example.test/a.mp4"></video>')));
    const { getLibvioDetail, searchLibvio } = await import('./server');
    expect((await searchLibvio(source, '片名')).list[0].vodId).toBe('123');
    expect((await getLibvioDetail(source, '123')).episodes).toEqual(['https://cdn.example.test/a.mp4']);
  });
  it('bounds HTML reads and refuses a 200 response containing a browser challenge', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('x'.repeat(1024 * 1024 + 1))).mockResolvedValueOnce(new Response('<title>正在验证</title>验证由浏览器完成一次工作量证明'));
    vi.stubGlobal('fetch', fetcher);
    const { getLibvioDetail } = await import('./server');
    const oversized = await getLibvioDetail(source, '123');
    expect(oversized).toMatchObject({ episodes: [], playbackType: 'unavailable' });
    expect(oversized.message).toContain('读取上限');
    expect((await getLibvioDetail(source, '123')).playbackType).toBe('browser-required');
  });
  it('parses only matching item watch pages, keeps episode labels and deduplicates media', async () => {
    const fetcher = vi.fn().mockImplementation(async (url: string) => new Response(url.includes('/detail/')
      ? '<h1>剧集</h1><a href="/w/123-1-1.html">第1集</a><a href="/w/456-1-1.html">广告</a><a href="/w/123-1-2.html">第2集</a><a href="/w/123-2-1.html">另一线路</a>'
      : `<script>var player_a={"url":"https://cdn.example.test/${url.includes('-1-2') ? 'two' : 'one'}.m3u8"}</script>`));
    vi.stubGlobal('fetch', fetcher);
    const { getLibvioDetail } = await import('./server');
    const detail = await getLibvioDetail(source, '123');
    expect(detail.episodes).toEqual(['https://cdn.example.test/one.m3u8', '']);
    expect(detail.episodeLabels).toEqual(['第1集', '第2集']);
    expect(fetcher.mock.calls.every(([url]) => !url.includes('/w/456') && !url.includes('/w/123-2-'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
