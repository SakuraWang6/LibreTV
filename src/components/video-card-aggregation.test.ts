import { describe, expect, it } from 'vitest';
import type { SearchResultItem } from '@/lib/types';
import { aggregateResults } from './video-card-aggregation';

const result = (sourceKey: string, name: string, year?: string): SearchResultItem => ({ sourceKey, sourceName: sourceKey, vodId: `${sourceKey}-${name}`, name, year });

describe('search poster grouping', () => {
  it('keeps same-title remakes from different years separate', () => {
    const groups = aggregateResults([result('a', '同名电影', '1995'), result('b', '同名电影', '2025')]);
    expect(groups.map((group) => [group.year, group.items.length])).toEqual([['1995', 1], ['2025', 1]]);
  });

  it('does not merge different seasons', () => {
    const groups = aggregateResults([result('a', '剧名 第一季', '2025'), result('b', '剧名 第二季', '2025')]);
    expect(groups).toHaveLength(2);
  });

  it('keeps a poster identity stable as another source arrives', () => {
    const first = result('a', '影片', '2025');
    const initial = aggregateResults([first]);
    const streamed = aggregateResults([first, result('b', '影片', '2025')]);
    expect(streamed).toHaveLength(1);
    expect(streamed[0].key).toBe(initial[0].key);
    expect(streamed[0].items[0]).toBe(first);
  });
});
