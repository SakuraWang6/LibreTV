import { describe, expect, it } from 'vitest';
import { buildPlaybackSwitchUrl, canLinkLibraryProgress, clampResumePosition, episodeFromLabel, identityMismatch, isNativeMediaUrl, isPlayableEpisode, matchPlaybackEpisode, requestedResumePosition, titleSeason, type PlaybackIdentity } from './playback-source';
import type { VideoDetail } from './types';
import type { LibraryEntry } from './local-library/types';

const source = { key: 'new', name: '新来源', url: 'https://source.example/api.php/provide/vod' };
const result = { name: '庆余年第二季', typeName: '国产剧', year: '2024', sourceKey: source.key, sourceName: source.name, vodId: '12' };
const current: PlaybackIdentity = { title: '庆余年 第2季', kind: 'tv', typeName: '国产剧', year: '2024', seasonNumber: 2, episodeNumber: 3 };
const detail = (over: Partial<VideoDetail> = {}): VideoDetail => ({
  episodes: ['https://cdn.example/1.m3u8', 'https://cdn.example/2.m3u8', 'https://cdn.example/3.m3u8'],
  episodeLabels: ['第1集', '第2集', '第3集'],
  videoInfo: { title: '庆余年第二季', typeName: '国产剧', year: '2024', sourceKey: source.key, sourceName: source.name },
  ...over,
});
const entry = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id: 'a'.repeat(32), groupId: 'group', title: '庆余年第二季', kind: 'tv', year: '2024', seasonNumber: 2, episodeNumber: 3,
  bytes: 20, format: 'MP4', createdAt: '2026-01-01T00:00:00Z', mediaUrl: '/api/library/media', posterUrl: '/api/library/poster', ...over,
});

describe('safe source and episode matching', () => {
  it('normalizes explicit season labels and numbered episode labels', () => {
    expect(titleSeason('某剧 第八季')).toEqual({ title: '某剧', season: 8 });
    expect(titleSeason('Some Show Season 8')).toEqual({ title: 'Some Show', season: 8 });
    expect(titleSeason('Some Show S08')).toEqual({ title: 'Some Show', season: 8 });
    expect(['第十二集', 'EP03', 'S02E03', '03'].map(episodeFromLabel)).toEqual([12, 3, 3, 3]);
    expect(episodeFromLabel('第1-2集')).toBeUndefined();
    expect(episodeFromLabel('第1集上')).toBeUndefined();
  });

  it('keeps the same episode even when the candidate order is reversed', () => {
    const reversed = detail({ episodeLabels: ['第3集', '第2集', '第1集'] });
    expect(matchPlaybackEpisode(current, result, reversed)).toEqual({ index: 0 });
  });

  it('rejects another season, remake year, short drama and prefix-only derivative', () => {
    expect(identityMismatch(current, { title: '庆余年第一季', kind: 'tv', typeName: '国产剧' })).toBe('季数不一致');
    expect(identityMismatch(current, { title: '庆余年第二季', kind: 'tv', year: '2025' })).toBe('年份不一致');
    expect(identityMismatch(current, { title: '庆余年第二季', kind: 'tv', typeName: '短剧' })).toBe('与当前长剧版本不一致');
    expect(identityMismatch(current, { title: '庆余年之风起沧州', kind: 'tv' })).toBe('片名不一致');
    expect(identityMismatch(current, { title: '庆余年第二季[电影解说]', kind: 'movie' })).toBeDefined();
  });

  it('never resets to episode one when the requested episode is missing or ambiguous', () => {
    expect(matchPlaybackEpisode(current, result, detail({ episodes: ['https://cdn.example/1.m3u8'], episodeLabels: ['第1集'] })).index).toBeUndefined();
    expect(matchPlaybackEpisode(current, result, detail({ episodeLabels: ['第3集', '第3集', '第4集'] })).index).toBeUndefined();
    expect(matchPlaybackEpisode(current, result, detail({ episodeLabels: ['第1-2集', '第3-4集', '第5-6集'] })).index).toBeUndefined();
  });

  it('falls back to the existing ordinal only when labels do not identify episodes', () => {
    expect(matchPlaybackEpisode(current, result, detail({ episodeLabels: ['一', '二', '三'] }))).toEqual({ index: 2 });
    expect(matchPlaybackEpisode(current, result, detail({ episodeLabels: undefined }))).toEqual({ index: 2 });
  });

  it('uses explicit season metadata when multiple seasons share one catalogue', () => {
    const all = detail({ videoInfo: { title: '庆余年', typeName: '国产剧', year: '2024', sourceKey: source.key, sourceName: source.name }, episodeSeasons: [1, 2, 2], episodeLabels: ['第3集', '第2集', '第3集'] });
    expect(matchPlaybackEpisode(current, { ...result, name: '庆余年' }, all)).toEqual({ index: 2 });
  });

  it('keeps web, cloud share and browser verification entries out of the media player', () => {
    expect(isPlayableEpisode('https://example.com/share/abc')).toBe(false);
    expect(isPlayableEpisode('https://example.com/file.mp4', detail({ playbackType: 'external' }))).toBe(false);
    expect(matchPlaybackEpisode(current, result, detail({ playbackType: 'browser-required', message: '需要在原网站验证' }))).toEqual({ reason: '需要在原网站验证' });
    expect(isPlayableEpisode('https://example.com/file.mp4?token=abc')).toBe(true);
    expect(isNativeMediaUrl('https://example.com/file.mp4?token=abc')).toBe(true);
    expect(isNativeMediaUrl('https://example.com/file.m3u8')).toBe(false);
  });

  it('does not turn the second half of a split film into the first part of another cut', () => {
    const film = detail({ videoInfo: { title: '某电影', typeName: '剧情片', year: '2024', sourceKey: source.key, sourceName: source.name } });
    expect(matchPlaybackEpisode({ title: '某电影', kind: 'movie', episodeNumber: 2 }, { name: '某电影', typeName: '剧情片' }, film).index).toBeUndefined();
  });
});

describe('resume URL and disk progress association', () => {
  it('retains fractional seconds, the mapped episode and optional library identity', () => {
    const selected = { source: { ...source, kind: 'libvio' as const }, result, detail: detail(), index: 2 };
    const url = new URL(buildPlaybackSwitchUrl(selected, 7.625, entry().id), 'http://localhost');
    expect(url.searchParams.get('position')).toBe('7.625');
    expect(url.searchParams.get('index')).toBe('2');
    expect(url.searchParams.get('libraryId')).toBe(entry().id);
    expect(url.searchParams.get('sourceKind')).toBe('libvio');
    expect(url.searchParams.get('url')).toBe('https://cdn.example/3.m3u8');
    expect(requestedResumePosition(url.searchParams.get('position'))).toBe(7.625);
    expect(requestedResumePosition('0')).toBe(0);
    expect(requestedResumePosition(null)).toBeUndefined();
    expect(requestedResumePosition('Infinity')).toBe(0);
    expect(clampResumePosition(7.625, 100)).toBe(7.625);
    expect(clampResumePosition(99.5, 100)).toBe(99.5);
    expect(clampResumePosition(120, 100)).toBe(99.75);
    expect(new URL(buildPlaybackSwitchUrl(selected, NaN, 'not-a-library-id'), 'http://localhost').searchParams.has('libraryId')).toBe(false);
  });

  it('only links the same film, season and episode after reading disk metadata', () => {
    expect(canLinkLibraryProgress(entry(), current, detail())).toBe(true);
    expect(canLinkLibraryProgress(entry({ episodeNumber: 2 }), current, detail())).toBe(false);
    expect(canLinkLibraryProgress(entry({ title: '另一部剧' }), current, detail())).toBe(false);
    expect(canLinkLibraryProgress(entry({ year: '2019' }), current, detail())).toBe(false);
    expect(canLinkLibraryProgress(entry({ title: '庆余年第一季', seasonNumber: 1 }), current, detail())).toBe(false);
  });

  it('requires a matching year when the source does not identify its category', () => {
    const unknown = detail({ videoInfo: { title: '庆余年第二季', sourceKey: source.key, sourceName: source.name } });
    expect(canLinkLibraryProgress(entry(), current, unknown)).toBe(false);
    unknown.videoInfo.year = '2024';
    expect(canLinkLibraryProgress(entry(), current, unknown)).toBe(true);
  });
});
