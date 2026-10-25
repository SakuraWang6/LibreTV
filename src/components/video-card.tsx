'use client';

import { useEffect, useState } from 'react';
import type { SearchResultItem } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import type { AggregatedGroup } from './video-card-aggregation';
export { aggregateResults } from './video-card-aggregation';
import { SmartImage } from './smart-image';
import { Icon } from './icon';

/** Source choice belongs to the playback page; a poster opens the film directly. */
export function AggregatedCard({ group, onOpen }: { group: AggregatedGroup; onOpen: (item: SearchResultItem) => void }) {
  const item = group.items[0];
  if (!item) return null;
  return <PosterCard title={group.name} cover={group.pic} onClick={() => onOpen(item)}
    metadata={[group.year, group.typeName, group.remarks].filter(Boolean).join(' · ')} />;
}

export function DoubanCard({ item, onClick }: { item: { title: string; cover: string; rating?: string }; onClick: () => void }) {
  return <PosterCard title={item.title} cover={item.cover} rating={item.rating} onClick={onClick} />;
}

function PosterCard({ title, cover, rating, metadata, onClick }: { title: string; cover?: string; rating?: string; metadata?: string; onClick: () => void }) {
  const imageProxyMode = useAppStore((state) => state.imageProxyMode);
  const customImageProxy = useAppStore((state) => state.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [cover, imageProxyMode, customImageProxy]);

  return <button type="button" onClick={onClick} aria-label={title}
    className="group block min-w-0 w-full text-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-4 focus-visible:ring-offset-page">
    <span className="relative block aspect-[2/3] overflow-hidden rounded-lg bg-chip ring-1 ring-black/5 shadow-sm transition-shadow duration-200 group-hover:shadow-lg">
      {cover && !imgFailed ? <SmartImage url={cover} mode={imageProxyMode} customProxy={customImageProxy} alt={title}
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]" onExhausted={() => setImgFailed(true)} />
        : <span className="absolute inset-0 flex items-center justify-center text-faint"><Icon name="film" className="h-9 w-9" /></span>}
      {rating && <span className="absolute top-2 right-2 rounded px-1.5 py-0.5 bg-black/65 text-[11px] font-medium text-rating">★ {rating}</span>}
    </span>
    <span className="mt-3 block truncate px-0.5 text-[13px] font-medium text-content" title={title}>{title}</span>
    {metadata && <span className="mt-1 block truncate px-0.5 text-[11px] text-faint" title={metadata}>{metadata}</span>}
  </button>;
}
