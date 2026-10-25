import type { SearchResultItem } from '@/lib/types';
import { inferGroupRemarks } from '@/lib/remarks';

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: `${name}|${year ?? ''}`,
    name,
    year,
    typeName: items.find((item) => item.typeName)?.typeName,
    pic: items.find((item) => item.pic)?.pic,
    remarks: inferGroupRemarks(items.map((item) => item.remarks)),
    items,
  };
}

/** Same-title remakes remain separate when their release years differ. */
export function aggregateResults(list: SearchResultItem[]): AggregatedGroup[] {
  const byName = new Map<string, SearchResultItem[]>();
  for (const item of list) {
    const name = (item.name || '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(item);
  }
  const groups: AggregatedGroup[] = [];
  for (const [name, items] of byName) {
    const years = [...new Set(items.map((item) => item.year).filter(Boolean))] as string[];
    if (years.length > 1) {
      for (const year of years) groups.push(buildGroup(name, year, items.filter((item) => item.year === year)));
      const noYear = items.filter((item) => !item.year);
      if (noYear.length) groups.push(buildGroup(name, undefined, noYear));
    } else {
      groups.push(buildGroup(name, years[0], items));
    }
  }
  return groups;
}

