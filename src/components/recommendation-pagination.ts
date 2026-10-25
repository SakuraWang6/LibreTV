import type { DoubanItem } from '@/lib/types';

type RecommendationPage = { items: DoubanItem[]; nextPageStart?: number | null; hasMore?: boolean };

export function mergeRecommendations(items: DoubanItem[]): DoubanItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Stop even if an upstream ignores its offset and repeats a full page. */
export function nextRecommendationPage(last: RecommendationPage, pages: RecommendationPage[], lastStart: number, pageSize: number): number | undefined {
  const previousIds = new Set(pages.slice(0, -1).flatMap((page) => page.items.map((item) => item.id)));
  if (!last.items.some((item) => !previousIds.has(item.id)) || last.hasMore === false || last.nextPageStart === null) return undefined;
  const next = last.nextPageStart ?? (last.items.length >= pageSize ? lastStart + pageSize : undefined);
  return typeof next === 'number' && Number.isSafeInteger(next) && next > lastStart ? next : undefined;
}
