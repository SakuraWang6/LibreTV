import { describe, expect, it } from 'vitest';
import { filterExactTitleResults, isExactTitleMatch, parseDetail } from './cms-parser';

describe('exact title search', () => {
  it.each([
    ['摔跤吧！爸爸', '摔跤吧!爸爸'],
    ['庆余年 第二季', '庆余年2'],
    ['庆余年第八季', '庆余年 第8季'],
    ['Example Season 8', 'Example S08'],
    ['庆余年 第二季粤语', '庆余年'],
    ['电影名【4K HDR】（国语）', '电影名'],
    ['电影名 1080P', '电影名'],
    ['流浪地球2', '流浪地球2'],
    ['1917', '1917'],
  ])('matches title/edition/season alias %s / %s', (name, query) => {
    expect(isExactTitleMatch(name, query)).toBe(true);
  });

  it.each([
    ['庆余年之风起沧州', '庆余年'],
    ['测试剧外传', '测试剧'],
    ['电影名【影视解说】', '电影名'],
    ['电影名花絮', '电影名'],
    ['电影名（预告片）', '电影名'],
    ['爸爸回来了', '摔跤吧！爸爸'],
    ['庆余年 第十二季', '庆余年 第2季'],
    ['流浪地球2', '流浪地球'],
    ['流浪地球', '流浪地球2'],
    ['电影名2024', '电影名'],
    ['', '电影名'],
    ['电影名', ''],
  ])('rejects a different work %s / %s', (name, query) => {
    expect(isExactTitleMatch(name, query)).toBe(false);
  });

  it('rejects an identically named commentary category and preserves different release years', () => {
    const items = [
      { name: '电影名', typeName: '影视解说', year: '2024' },
      { name: '电影名', typeName: '剧情片', year: '1994' },
      { name: '电影名', typeName: '剧情片', year: '2024' },
    ];
    expect(filterExactTitleResults(items, '电影名')).toEqual(items.slice(1));
  });
});

describe('CMS episode identity', () => {
  it('preserves labels from the selected media line including missing episodes', () => {
    const detail = parseDetail({ list: [{ vod_name: '剧名第二季', vod_play_url:
      '第1集$https://example.com/share/1$$$第01集$https://cdn.example.com/1.m3u8#第03集$https://cdn.example.com/3.m3u8?token=a$b',
    }] }, { key: 'a', name: 'A', url: 'https://api.example.com' });
    expect(detail.episodeLabels).toEqual(['第01集', '第03集']);
    expect(detail.episodes).toEqual(['https://cdn.example.com/1.m3u8', 'https://cdn.example.com/3.m3u8?token=a$b']);
  });
});
