import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api-guard', () => ({ guardRequest: () => undefined }));
vi.mock('@/lib/douban', () => ({ fetchDoubanRecommend: vi.fn() }));
import { fetchDoubanRecommend } from '@/lib/douban';
import { GET } from './route';

describe('recommendation pagination', () => {
  beforeEach(() => vi.resetAllMocks());
  it('advances the real upstream offset after a full page', async () => {
    const items = [{ id: '1', title: 'A', cover: '' }, { id: '2', title: 'B', cover: '' }];
    vi.mocked(fetchDoubanRecommend).mockResolvedValue(items);
    const result = await GET(new Request('https://local.test/api/douban?type=tv&pageStart=2&pageSize=2'));
    expect(fetchDoubanRecommend).toHaveBeenCalledWith('tv', '热门', 2, 2);
    expect(await result.json()).toEqual({ items, hasMore: true, nextPageStart: 4 });
  });
  it('marks a partial or empty page as the end', async () => {
    vi.mocked(fetchDoubanRecommend).mockResolvedValue([]);
    const result = await GET(new Request('https://local.test/api/douban?pageStart=4&pageSize=2'));
    expect(await result.json()).toEqual({ items: [], hasMore: false, nextPageStart: null });
  });
});
