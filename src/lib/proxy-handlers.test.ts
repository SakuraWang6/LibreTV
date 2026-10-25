import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from './auth';
import { handleProxyRequest } from './proxy-handlers';
import { fetchWithSafeRedirects } from './fetch-utils';

vi.mock('./fetch-utils', () => ({ fetchWithSafeRedirects: vi.fn() }));
vi.mock('./ssrf', async (original) => ({ ...await original<typeof import('./ssrf')>(), isBlockedByDNS: vi.fn(async () => false) }));

beforeEach(() => {
  vi.stubEnv('PASSWORD', 'media-proxy-test-password');
  vi.stubEnv('PROXY_SECRET', 'media-proxy-test-secret');
  vi.mocked(fetchWithSafeRedirects).mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });

function request(query = '', authenticated = true, extraHeaders: Record<string, string> = {}) {
  return new Request(`https://local.example/api/proxy?${query}`, {
    headers: { ...(authenticated ? { cookie: `${SESSION_COOKIE}=${signSession().token}` } : {}), ...extraHeaders },
  });
}

describe('ordinary media proxy and retired-context rejection', () => {
  it('retains authentication and private-target rejection and refuses arbitrary context', async () => {
    expect((await handleProxyRequest(request('mediaContext=libvio', false), 'https://cdn.example/movie.mp4')).status).toBe(401);
    expect((await handleProxyRequest(request('mediaContext=libvio', false), 'https://img1.doubanio.com/movie.mp4')).status).toBe(400);
    expect((await handleProxyRequest(request('mediaContext=arbitrary'), 'https://cdn.example/movie.mp4')).status).toBe(400);
    expect((await handleProxyRequest(request('mediaContext=libvio'), 'http://127.0.0.1/private.mp4')).status).toBe(400);
    expect(fetchWithSafeRedirects).not.toHaveBeenCalled();
  });

  it('forwards Range while excluding client credentials and custom headers', async () => {
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response('media', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-4/100' } }), finalUrl: 'https://cdn.example/movie.mp4' });
    const req = request('', true, { range: 'bytes=0-4', referer: 'https://attacker.example', authorization: 'secret' });
    const response = await handleProxyRequest(req, 'https://cdn.example/movie.mp4');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-4/100');
    expect(await response.text()).toBe('media');
    const [, init, options] = vi.mocked(fetchWithSafeRedirects).mock.calls[0];
    expect(init?.headers).toEqual({ 'User-Agent': expect.any(String), Accept: '*/*', Range: 'bytes=0-4' });
    expect(init?.signal).not.toBe(req.signal);
    expect(options).toBeUndefined();
  });

  it('rewrites nested playlists, keys, maps and media segments through the ordinary proxy', async () => {
    const content = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:3,\nseg.ts\nchild.m3u8';
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response(content, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), finalUrl: 'https://final.example/path/main.m3u8' });
    const response = await handleProxyRequest(request(), 'https://cdn.example/main.m3u8');
    const rewritten = await response.text();
    for (const name of ['key', 'init.mp4', 'seg.ts', 'child.m3u8']) {
      expect(rewritten).toContain(`/api/proxy?url=${encodeURIComponent(`https://final.example/path/${name}`)}`);
    }
  });

  it('retains the existing default proxy headers and request deadline without a context', async () => {
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response('media'), finalUrl: 'https://cdn.example/seg.ts' });
    const req = request();
    await handleProxyRequest(req, 'https://cdn.example/seg.ts');
    const [, init, options] = vi.mocked(fetchWithSafeRedirects).mock.calls[0];
    expect(init?.headers).toHaveProperty('User-Agent');
    expect(init?.headers).not.toHaveProperty('Referer');
    expect(init?.signal).not.toBe(req.signal);
    expect(options).toBeUndefined();
  });
});
