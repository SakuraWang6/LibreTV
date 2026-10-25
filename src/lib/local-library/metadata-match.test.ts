import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchLibraryMetadata } from './metadata-match';
import type { LibraryMetadata } from './types';
import type { SearchResultItem, SourceConfig, VideoDetail } from '@/lib/types';

const mocks = vi.hoisted(() => ({ search: vi.fn(), detail: vi.fn() }));
vi.mock('@/lib/client-api', () => ({ api: mocks }));

const source: SourceConfig = { key: 'a', name: '源A', url: 'https://a.example.com/api.php/provide/vod' };
const other: SourceConfig = { key: 'b', name: '源B', url: 'https://b.example.com/api.php/provide/vod' };
const movie: LibraryMetadata = { title: '教父', kind: 'movie', year: '1972' };
const result = (patch: Partial<SearchResultItem> = {}): SearchResultItem => ({
  sourceKey: source.key, sourceName: source.name, vodId: 'one', name: '教父', year: '1972', typeName: '剧情片', ...patch,
});
const detail = (patch: Partial<VideoDetail['videoInfo']> = {}): VideoDetail => ({
  episodes: [], videoInfo: { sourceKey: source.key, sourceName: source.name, title: '教父', year: '1972', typeName: '剧情片', cover: 'https://images.example.com/poster.jpg', desc: '<p>影片简介 &amp; 内容。</p>', ...patch },
});

beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue({ list: [result()] });
  mocks.detail.mockReset().mockResolvedValue(detail());
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('local library metadata identity matching', () => {
  it('splits a legacy filename year, fetches confirmed details, and leaves the original object untouched', async () => {
    const original: LibraryMetadata = { title: '教父 1972', kind: 'movie' };
    const matched = await matchLibraryMetadata(original, [source]);
    expect(matched).toEqual({ status: 'matched', metadata: {
      title: '教父', kind: 'movie', year: '1972', coverUrl: 'https://images.example.com/poster.jpg', description: '影片简介 & 内容。', sourceName: '源A',
    } });
    expect(original).toEqual({ title: '教父 1972', kind: 'movie' });
    expect(mocks.search).toHaveBeenCalledWith('教父', [source], true, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('does not mistake a sequel, collection or television season for the film', async () => {
    mocks.search.mockResolvedValue({ list: [result({ name: '教父2', year: '1974' }), result({ vodId: 'collection', name: '教父1-3' }), result({ vodId: 'tv', name: '教父第二季', year: '2024', typeName: '短剧' })] });
    const answer = await matchLibraryMetadata(movie, [source]);
    expect(answer).toEqual({ status: 'unmatched', metadata: movie });
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('keeps roman and numeric sequel identities distinct', async () => {
    mocks.search.mockResolvedValue({ list: [result({ name: '教父II', year: '1974' })] });
    expect((await matchLibraryMetadata({ title: '教父2', kind: 'movie', year: '1974' }, [source])).status).toBe('unmatched');
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('skips a source with a wrong claimed year even when another source has the correct film', async () => {
    mocks.search.mockResolvedValue({ list: [result({ name: '教父2', year: '1972' }), result({ sourceKey: other.key, vodId: 'correct', name: '教父2', year: '1974' })] });
    mocks.detail.mockResolvedValue(detail({ title: '教父2', year: '1974' }));
    const answer = await matchLibraryMetadata({ title: '教父2', kind: 'movie', year: '1974' }, [source, other]);
    expect(answer.status).toBe('matched');
    expect(answer.metadata.sourceName).toBe('源B');
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(mocks.detail).toHaveBeenCalledWith('correct', other, expect.any(AbortSignal));
  });

  it('does not pick a remake when the input lacks a year', async () => {
    const original: LibraryMetadata = { title: '同名电影', kind: 'movie' };
    mocks.search.mockResolvedValue({ list: [result({ name: original.title, year: '1990' }), result({ vodId: 'remake', name: original.title, year: '2020' })] });
    expect(await matchLibraryMetadata(original, [source])).toEqual({ status: 'ambiguous', metadata: original });
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('accepts duplicate sources only after confirming the same identity and complete metadata', async () => {
    mocks.search.mockResolvedValue({ list: [result(), result({ sourceKey: other.key, vodId: 'complete' })] });
    mocks.detail.mockImplementation(async (id: string) => id === 'one' ? detail({ desc: '' }) : detail());
    const answer = await matchLibraryMetadata(movie, [source, other]);
    expect(answer.status).toBe('matched');
    expect(answer.metadata.sourceName).toBe('源B');
  });

  it('can fill a missing year when every confirmed identity is the same work', async () => {
    const answer = await matchLibraryMetadata({ title: '教父', kind: 'movie' }, [source]);
    expect(answer.status).toBe('matched');
    expect(answer.metadata.year).toBe('1972');
  });

  it('detects distinct detail years even when search omitted all years', async () => {
    mocks.search.mockResolvedValue({ list: [result({ year: undefined }), result({ vodId: 'remake', year: undefined })] });
    mocks.detail.mockImplementation(async (id: string) => detail({ year: id === 'one' ? '1972' : '2020' }));
    expect((await matchLibraryMetadata({ title: '教父', kind: 'movie' }, [source])).status).toBe('ambiguous');
  });

  it('does not ignore an unconfirmed undated source that may hide another adaptation', async () => {
    mocks.search.mockResolvedValue({ list: [result(), result({ vodId: 'undated', year: undefined })] });
    mocks.detail.mockImplementation(async (id: string) => {
      if (id === 'undated') throw new Error('Offline');
      return detail();
    });
    expect((await matchLibraryMetadata({ title: '教父', kind: 'movie' }, [source])).status).toBe('unavailable');
  });

  it.each([
    { title: '教父2', year: '1974' },
    { year: '1974' },
    { typeName: '欧美剧' },
    { year: undefined },
  ])('rechecks detail identity instead of trusting the search hit: %o', async (patch) => {
    mocks.detail.mockResolvedValue(detail(patch));
    expect(await matchLibraryMetadata(movie, [source])).toEqual({ status: 'unmatched', metadata: movie });
  });

  it('does not confirm a title with no recognizable movie or television category', async () => {
    mocks.search.mockResolvedValue({ list: [result({ typeName: undefined })] });
    mocks.detail.mockResolvedValue(detail({ typeName: undefined }));
    expect((await matchLibraryMetadata(movie, [source])).status).toBe('unmatched');
  });

  it('preserves television season, episode and user episode title', async () => {
    const metadata: LibraryMetadata = { title: '剧名', kind: 'tv', year: '2020', seasonNumber: 2, episodeNumber: 7, episodeTitle: '我的第七集' };
    mocks.search.mockResolvedValue({ list: [result({ name: '剧名第二季', typeName: '国产剧', year: '2020' })] });
    mocks.detail.mockResolvedValue(detail({ title: '剧名第二季', typeName: '国产剧', year: '2020' }));
    const answer = await matchLibraryMetadata(metadata, [source]);
    expect(answer.status).toBe('matched');
    expect(answer.metadata).toMatchObject({ title: '剧名', seasonNumber: 2, episodeNumber: 7, episodeTitle: '我的第七集' });
  });

  it('rejects the wrong television season before requesting details', async () => {
    mocks.search.mockResolvedValue({ list: [result({ name: '剧名第一季', typeName: '国产剧', year: '2020' })] });
    expect((await matchLibraryMetadata({ title: '剧名', kind: 'tv', year: '2020', seasonNumber: 2 }, [source])).status).toBe('unmatched');
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it('retains an explicit season in the title when the season field was omitted', async () => {
    mocks.search.mockResolvedValue({ list: [result({ name: '剧名第二季', typeName: '国产剧', year: '2020' })] });
    mocks.detail.mockResolvedValue(detail({ title: '剧名第二季', typeName: '国产剧', year: '2020' }));
    const answer = await matchLibraryMetadata({ title: '剧名第二季', kind: 'tv', year: '2020' }, [source]);
    expect(answer.status).toBe('matched');
    expect(answer.metadata).toMatchObject({ title: '剧名', seasonNumber: 2 });
  });

  it('rejects contradictory season or release-year input rather than silently changing it', async () => {
    expect((await matchLibraryMetadata({ title: '剧名第二季', kind: 'tv', seasonNumber: 1 }, [source])).status).toBe('unmatched');
    expect((await matchLibraryMetadata({ title: '教父 1972', kind: 'movie', year: '1990' }, [source])).status).toBe('unmatched');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('does not open LIBVIO or enable adult or unselected sources for metadata', async () => {
    const providers: SourceConfig[] = [
      { key: 'libvio', name: 'LIBVIO', kind: 'libvio', url: 'https://libvio.host' },
      { key: 'implicit-libvio', name: 'LIBVIO地址', url: 'https://libvio.host' },
      { ...source, isAdult: true },
    ];
    expect(await matchLibraryMetadata(movie, providers)).toEqual({ status: 'unavailable', metadata: movie });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('keeps the metadata unchanged when search or detail requests fail', async () => {
    mocks.search.mockRejectedValueOnce(new Error('Network'));
    expect(await matchLibraryMetadata(movie, [source])).toEqual({ status: 'unavailable', metadata: movie });
    mocks.search.mockResolvedValueOnce({ list: [result()] });
    mocks.detail.mockRejectedValueOnce(new Error('Network'));
    expect(await matchLibraryMetadata(movie, [source])).toEqual({ status: 'unavailable', metadata: movie });
  });

  it('requires both a usable cover and description before calling the match complete', async () => {
    mocks.detail.mockResolvedValue(detail({ cover: 'javascript:alert(1)', desc: '' }));
    expect((await matchLibraryMetadata(movie, [source])).status).toBe('unmatched');
    mocks.detail.mockResolvedValue(detail({ cover: 'https://user:secret@example.com/poster.jpg' }));
    expect((await matchLibraryMetadata(movie, [source])).status).toBe('unmatched');
  });

  it('bounds network work and returns a nonblocking unavailable result on timeout', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds: number) => {
      expect(milliseconds).toBe(15_000);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    mocks.search.mockImplementation((_title: string, _sources: SourceConfig[], _filter: boolean, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const pending = matchLibraryMetadata(movie, [source]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toEqual({ status: 'unavailable', metadata: movie });
  });

  it('honors caller cancellation instead of continuing the next import', async () => {
    const controller = new AbortController();
    mocks.search.mockImplementation((_title: string, _sources: SourceConfig[], _filter: boolean, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const pending = matchLibraryMetadata(movie, [source], controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
