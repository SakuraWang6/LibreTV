import { describe, expect, it } from 'vitest';
import { movieDownloadMetadata } from './download-metadata';

const collection = { title: '教父1-3', year: '1972', kind: 'movie' as const, episodeCount: 3, episodeLabels: ['1.1972集', '2.1974集', '3.1990集'], index: 1 };

describe('movie collection download metadata', () => {
  it('names and dates the selected film rather than the overall collection', () => {
    expect(movieDownloadMetadata(collection)).toEqual({ title: '教父1-3 · 2.1974集', year: '1974' });
    expect(movieDownloadMetadata({ ...collection, index: 2 })).toEqual({ title: '教父1-3 · 3.1990集', year: '1990' });
  });

  it('does not guess a later part year from the catalogue first film year', () => {
    expect(movieDownloadMetadata({ ...collection, episodeLabels: ['第1部', '第2部', '第3部'] })).toEqual({ title: '教父1-3 · 第2部', year: undefined });
  });

  it('leaves a single movie, TV series and quality-only alternatives unchanged', () => {
    const unchanged = { title: '教父1-3', year: '1972' };
    expect(movieDownloadMetadata({ ...collection, episodeCount: 1, episodeLabels: ['正片'], index: 0 })).toEqual(unchanged);
    expect(movieDownloadMetadata({ ...collection, kind: 'tv' })).toEqual(unchanged);
    expect(movieDownloadMetadata({ ...collection, episodeLabels: ['1080P', '4K', 'HD'] })).toEqual(unchanged);
    expect(movieDownloadMetadata({ ...collection, episodeLabels: ['正片', '正片', '正片'] })).toEqual(unchanged);
  });
});
