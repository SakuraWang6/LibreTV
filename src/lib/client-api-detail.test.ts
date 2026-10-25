import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, videoDetailQueryKey } from './client-api';
import type { SourceConfig, VideoDetail } from './types';

const cms: SourceConfig = { key: 'cms', name: 'CMS', url: 'https://api.example.test/vod' };
const sparse: VideoDetail = {
  episodes: ['', '', 'https://cdn.example.test/3.mp4', ''],
  episodeLabels: ['第1集', '第2集', '第3集', '第4集'],
  videoInfo: { title: '某剧第二季', sourceKey: cms.key, sourceName: cms.name },
};

afterEach(() => { vi.unstubAllGlobals(); });

function mockDetail() {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(sparse), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('selected detail requests', () => {
  it('keeps the legacy third AbortSignal argument and preserves empty episode slots', async () => {
    const fetchMock = mockDetail();
    const controller = new AbortController();
    expect(await api.detail('123', cms, controller.signal)).toEqual(sparse);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(path, 'http://localhost');
    expect([...url.searchParams.keys()]).toEqual(['id', 'source']);
    expect(JSON.parse(url.searchParams.get('source') || '')).toEqual(cms);
    expect(init.signal).toBe(controller.signal);
  });

  it('shares a full-detail cache per CMS video and separates different API URLs', () => {
    expect(videoDetailQueryKey(cms, '123')).toEqual(['detail', cms.key, '123', cms.url]);
    expect(videoDetailQueryKey(cms, '123')).not.toEqual(videoDetailQueryKey({ ...cms, url: 'https://another.example/api' }, '123'));
    expect(videoDetailQueryKey(cms, '123')).not.toEqual(videoDetailQueryKey(cms, '456'));
  });
});
