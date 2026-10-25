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
    expect(detail.episodes).toEqual(['https://cdn.example.test/one.m3u8', 'https://cdn.example.test/two.m3u8']);
    expect(detail.episodeLabels).toEqual(['第1集', '第2集']);
    expect(fetcher.mock.calls.every(([url]) => !url.includes('/w/456') && !url.includes('/w/123-2-'))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
