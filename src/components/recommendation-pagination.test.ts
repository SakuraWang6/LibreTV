import { describe, expect, it } from 'vitest';
import { mergeRecommendations, nextRecommendationPage } from './recommendation-pagination';

const item = (id: string) => ({ id, title: id, cover: '/poster.jpg' });

describe('recommendation pagination', () => {
  it('continues using the real offset when a page contributes new films', () => {
    const first = { items: [item('a'), item('b')], nextPageStart: 2, hasMore: true };
    const second = { items: [item('b'), item('c')], nextPageStart: 4, hasMore: true };
    expect(nextRecommendationPage(second, [first, second], 2, 2)).toBe(4);
  });

  it('stops when an upstream repeatedly returns its first page', () => {
    const first = { items: [item('a'), item('b')], nextPageStart: 2, hasMore: true };
    const repeated = { ...first, nextPageStart: 4 };
    expect(nextRecommendationPage(repeated, [first, repeated], 2, 2)).toBeUndefined();
  });

  it('honors exhaustion and rejects backward offsets', () => {
    expect(nextRecommendationPage({ items: [item('a')], nextPageStart: null }, [], 0, 1)).toBeUndefined();
    expect(nextRecommendationPage({ items: [item('a')], hasMore: false }, [], 0, 1)).toBeUndefined();
    expect(nextRecommendationPage({ items: [item('a')], nextPageStart: 0 }, [], 0, 1)).toBeUndefined();
  });

  it('retains ranking order while removing repeated recommendation IDs', () => {
    expect(mergeRecommendations([item('ranked'), item('a'), item('ranked'), item('b')]).map((entry) => entry.id)).toEqual(['ranked', 'a', 'b']);
  });
});
