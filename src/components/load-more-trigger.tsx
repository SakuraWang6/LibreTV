'use client';

import { useEffect, useRef } from 'react';

/** Re-observe after each page so a short first page can fill the viewport. */
export function LoadMoreTrigger({ hasMore, itemCount, loading = false, error = false, onLoad }: { hasMore: boolean; itemCount: number; loading?: boolean; error?: boolean; onLoad: () => void }) {
  const marker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = marker.current;
    if (!target || !hasMore || loading || error || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onLoad();
    }, { rootMargin: '500px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, itemCount, loading, error, onLoad]);

  if (!hasMore && !loading) return null;
  return <div ref={marker} className="flex min-h-24 items-center justify-center pt-5" aria-live="polite">
    {loading ? <span className="text-xs text-faint" role="status">正在加载…</span>
      : <button type="button" className="btn-ghost min-h-11 text-xs" onClick={onLoad}>{error ? '重新加载' : '加载更多'}</button>}
  </div>;
}
