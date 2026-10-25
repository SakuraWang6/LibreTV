import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ blocked: false, fetch: vi.fn() }));
vi.mock('@/lib/api-guard', () => ({ guardRequest: () => controls.blocked ? new Response('{}', { status: 401 }) : null }));
vi.mock('@/lib/fetch-utils', () => ({ fetchUpstream: controls.fetch, getCache: () => undefined, setCache: vi.fn() }));
vi.mock('@/lib/ssrf', () => ({ checkUpstreamAllowed: async () => ({ ok: true }) }));
import { GET } from './route';

const source = { key: 'cms', name: 'CMS', url: 'https://api.example.test/vod' };
function request(config: unknown = source) {
  const query = new URLSearchParams({ id: '123', source: JSON.stringify(config) });
  return new Request('http://localhost/api/detail?' + query.toString());
}
beforeEach(() => {
  controls.blocked = false;
  controls.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ list: [{
    vod_id: 123, vod_name: '剧集', vod_play_url: '第1集$https://cdn.example.test/1.m3u8#第2集$https://cdn.example.test/2.m3u8',
  }] })));
});

describe('CMS detail API', () => {
  it('returns the ordinary full playlist from a CMS API', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ episodes: ['https://cdn.example.test/1.m3u8', 'https://cdn.example.test/2.m3u8'], videoInfo: { title: '剧集' } });
    expect(controls.fetch).toHaveBeenCalledWith('https://api.example.test/vod?ac=videolist&ids=123', expect.any(Object));
  });
  it.each([
    { ...source, kind: 'libvio' }, { ...source, sourceKind: 'libvio' },
    { ...source, url: 'https://libvio.host' }, { ...source, url: 'https://www.libvio.app' },
    { ...source, detail: 'https://libvio.to' }, null,
  ])('rejects retired or invalid sources before upstream access', async (config) => {
    expect((await GET(request(config))).status).toBe(400);
    expect(controls.fetch).not.toHaveBeenCalled();
  });
  it('keeps authentication ahead of source parsing', async () => {
    controls.blocked = true;
    expect((await GET(request({ ...source, kind: 'libvio' }))).status).toBe(401);
    expect(controls.fetch).not.toHaveBeenCalled();
  });
});
