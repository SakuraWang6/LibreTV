import { beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({ blocked: false, detail: vi.fn() }));
vi.mock('@/lib/api-guard', () => ({ guardRequest: () => controls.blocked ? new Response('{}', { status: 401 }) : null }));
vi.mock('@/lib/providers/libvio/server', () => ({ getLibvioDetail: controls.detail }));
import { GET } from './route';

function request(fields: Record<string, string> = {}, tail = '') {
  const query = new URLSearchParams({ id: '123', source: JSON.stringify({ key: 'libvio', name: 'LIBVIO', url: 'https://libvio.host', kind: 'libvio' }), ...fields });
  return new Request('http://localhost/api/detail?' + query.toString() + tail);
}
beforeEach(() => {
  controls.blocked = false;
  controls.detail.mockReset().mockResolvedValue({ episodes: ['', 'https://cdn.example.test/2.mp4'], episodeLabels: ['第1集', '第2集'], playbackType: 'media', mediaContext: 'libvio', videoInfo: { title: '剧集' } });
});

describe('LIBVIO selected episode detail API', () => {
  it('passes bounded selection fields separately without changing the AbortSignal position', async () => {
    expect((await GET(request({ index: '1', episodeNumber: '2', seasonNumber: '1' }))).status).toBe(200);
    expect(controls.detail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'libvio' }), '123', expect.any(AbortSignal), { index: 1, episodeNumber: 2, seasonNumber: 1 });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(controls.detail.mock.calls[1][3]).toEqual({});
  });
  it('rejects malformed, negative, fractional, duplicate and out-of-range selections before provider access', async () => {
    const invalid: Record<string, string>[] = [
      { index: '-1' }, { index: '100' }, { index: '' }, { index: '1.5' }, { index: '1e1' },
      { episodeNumber: '0' }, { episodeNumber: '10000' }, { seasonNumber: '1' },
      { episodeNumber: '2', seasonNumber: '0' }, { episodeNumber: '2', seasonNumber: '10000' },
    ];
    for (const fields of invalid) expect((await GET(request(fields))).status).toBe(400);
    expect((await GET(request({ index: '1' }, '&index=2'))).status).toBe(400);
    expect((await GET(request({ id: 'not-a-numeric-libvio-id' }))).status).toBe(400);
    expect(controls.detail).not.toHaveBeenCalled();
  });
  it('keeps authentication ahead of source and selection parsing', async () => {
    controls.blocked = true;
    expect((await GET(request({ index: '-1' }))).status).toBe(401);
    expect(controls.detail).not.toHaveBeenCalled();
  });
});
