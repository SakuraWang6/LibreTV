import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, videoDetailQueryKey } from './client-api';
import type { SourceConfig, VideoDetail } from './types';

const cms: SourceConfig = { key: 'cms', name: 'CMS', url: 'https://api.example.test/vod' };
const libvio: SourceConfig = { key: 'libvio', name: 'LIBVIO', url: 'https://libvio.host', kind: 'libvio' };
const sparse: VideoDetail = {
  episodes: ['', '', 'https://cdn.example.test/3.mp4', ''],
  episodeLabels: ['第1集', '第2集', '第3集', '第4集'], episodeSeasons: [2, 2, 2, 2],
  videoInfo: { title: '某剧第二季', sourceKey: libvio.key, sourceName: libvio.name },
  playbackType: 'media', mediaContext: 'libvio',
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

  it.each([0, 11])('requests only selected playlist slot %i', async (index) => {
    const fetchMock = mockDetail();
    await api.detail('123', libvio, undefined, { index });
    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://localhost');
    expect(url.searchParams.get('index')).toBe(String(index));
    expect(url.searchParams.has('episodeNumber')).toBe(false);
  });

  it('passes real season and episode identities without guessing a candidate index', async () => {
    const fetchMock = mockDetail();
    const controller = new AbortController();
    await api.detail('123', libvio, controller.signal, { episodeNumber: 3, seasonNumber: 2 });
    const url = new URL(fetchMock.mock.calls[0][0] as string, 'http://localhost');
    expect(url.searchParams.get('episodeNumber')).toBe('3');
    expect(url.searchParams.get('seasonNumber')).toBe('2');
    expect(url.searchParams.has('index')).toBe(false);
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('partitions selected LIBVIO slots while retaining a shared CMS full-detail cache', () => {
    expect(videoDetailQueryKey(libvio, '123', 0)).not.toEqual(videoDetailQueryKey(libvio, '123', 1));
    expect(videoDetailQueryKey(cms, '123', 0)).toEqual(videoDetailQueryKey(cms, '123', 1));
    expect(videoDetailQueryKey(libvio, '123', 2)).toEqual(['detail', libvio.key, '123', libvio.url, 'libvio', 2]);
  });
});
