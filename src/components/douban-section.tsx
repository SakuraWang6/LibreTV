'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';
import { LoadMoreTrigger } from './load-more-trigger';
import { mergeRecommendations, nextRecommendationPage } from './recommendation-pagination';

const MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动画'];
const TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const RECOMMEND_PAGE_SIZE = 24;
const POSTER_GRID = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 gap-x-4 gap-y-7';

function useDoubanPages(type: 'movie' | 'tv', tag: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: ['douban-pages', type, tag],
    queryFn: ({ pageParam, signal }) => api.douban(type, tag, pageParam, RECOMMEND_PAGE_SIZE, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages, lastStart) => nextRecommendationPage(last, pages, lastStart, RECOMMEND_PAGE_SIZE),
    enabled,
    staleTime: 300_000,
  });
}

/** 首页推荐区：数据源由设置决定。 */
export function RecommendSection({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const recommendSource = useAppStore((s) => s.recommendSource);

  if (!doubanEnabled) return null;
  if (recommendSource === 'bangumi') return <BangumiView onPick={onPick} />;
  if (recommendSource === 'hot-list') return <HotListView onPick={onPick} />;
  return <DoubanView onPick={onPick} />;
}

/** 豆瓣标签变化会创建独立分页，回到标签时复用已经加载的海报。 */
function DoubanView({ onPick }: { onPick: (title: string) => void }) {
  const [type, setType] = useState<'movie' | 'tv'>('movie');
  const [tag, setTag] = useState('热门');
  const query = useDoubanPages(type, tag);

  const tags = type === 'movie' ? MOVIE_TAGS : TV_TAGS;
  const items = mergeRecommendations(query.data?.pages.flatMap((page) => page.items) ?? []);

  const switchType = (t: 'movie' | 'tv') => {
    if (t === type) return;
    setType(t);
    setTag('热门');
  };

  return (
    <section aria-label="影视推荐">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="flex bg-chip rounded-lg p-0.5">
            <TypeButton active={type === 'movie'} onClick={() => switchType('movie')}>
              电影
            </TypeButton>
            <TypeButton active={type === 'tv'} onClick={() => switchType('tv')}>
              剧集
            </TypeButton>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4">
        {tags.map((t) => (
          <button
            key={t}
            className={cn(
              'min-h-10 px-3 py-1.5 rounded-md text-xs transition-colors',
              t === tag ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
            )}
            onClick={() => setTag(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {query.isError && !items.length ? (
        <RecommendationError onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-faint py-8">该分类暂无推荐内容</p>
      ) : (
        <>
          <div className={POSTER_GRID}>{items.map((item) => <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />)}</div>
          <LoadMoreTrigger hasMore={!!query.hasNextPage} itemCount={items.length} loading={query.isFetchingNextPage} error={query.isFetchNextPageError} onLoad={() => { if (!query.isFetching) void query.fetchNextPage(); }} />
        </>
      )}
    </section>
  );
}

/** Bangumi 每日放送：星期筛选，一次拉全量无分页 */
function BangumiView({ onPick }: { onPick: (title: string) => void }) {
  const [weekday, setWeekday] = useState<number | 'all'>('all');

  const query = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
  });

  let items: DoubanItem[] = [];
  if (query.data) {
    items = weekday === 'all'
      ? query.data.days.flatMap((d) => d.items)
      : (query.data.days.find((d) => d.weekday === weekday)?.items ?? []);
  }

  return (
    <section aria-label="新番放送推荐">
      <div className="flex flex-wrap gap-1.5 mb-4">
        <ChipButton active={weekday === 'all'} onClick={() => setWeekday('all')}>
          全部
        </ChipButton>
        {WEEKDAYS.map((name, i) => (
          <ChipButton key={name} active={weekday === i + 1} onClick={() => setWeekday(i + 1)}>
            {name}
          </ChipButton>
        ))}
      </div>

      {query.isError ? (
        <RecommendationError onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <GridSkeleton />
      ) : (
        <div className={POSTER_GRID}>
          {items.map((item) => (
            <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />
          ))}
        </div>
      )}
    </section>
  );
}

const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_chinese', label: '国产剧周榜' },
  { id: 'douban_tv_global', label: '海外剧周榜' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'baidu_teleplay', label: '百度热播剧' },
];

/** 影视热榜（60s API）：豆瓣五个周榜 + 百度热播剧，chips 切换 */
function HotListView({ onPick }: { onPick: (title: string) => void }) {
  const [listId, setListId] = useState(HOT_LISTS[0].id);
  const query = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
  });
  const recommendations = useDoubanPages(listId === 'douban_movie_weekly' ? 'movie' : 'tv', '热门', query.isFetched);
  const items = mergeRecommendations([...(query.data?.items ?? []), ...(recommendations.data?.pages.flatMap((page) => page.items) ?? [])]);
  const retryRecommendations = () => {
    if (recommendations.isFetching) return;
    if (recommendations.data) void recommendations.fetchNextPage();
    else void recommendations.refetch();
  };

  return <section aria-label="影视榜单推荐">
    <div className="flex flex-wrap gap-1.5 mb-5">{HOT_LISTS.map((list) => <ChipButton key={list.id} active={listId === list.id} onClick={() => setListId(list.id)}>{list.label}</ChipButton>)}</div>
    {query.isLoading ? <GridSkeleton /> : items.length ? <>
      <div className={POSTER_GRID}>{items.map((item) => <DoubanCard key={item.id} item={item} onClick={() => onPick(item.title)} />)}</div>
      <LoadMoreTrigger hasMore={!!recommendations.hasNextPage || recommendations.isError} itemCount={items.length} loading={recommendations.isFetching} error={recommendations.isError} onLoad={retryRecommendations} />
    </> : recommendations.isFetching ? <GridSkeleton />
      : <RecommendationError onRetry={() => { if (query.isError) void query.refetch(); void recommendations.refetch(); }} />}
  </section>;
}

function RecommendationError({ onRetry }: { onRetry: () => void }) {
  return <div className="py-8 text-center"><p className="text-sm text-faint">推荐加载失败</p><button type="button" className="btn-ghost mt-2 min-h-11 text-xs" onClick={onRetry}>重试</button></div>;
}

function GridSkeleton() {
  return (
    <div className={POSTER_GRID}>
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i}>
          <div className="aspect-[2/3] rounded-lg bg-chip animate-pulse" />
          <div className="h-3 mt-2 rounded bg-chip animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function ChipButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        'min-h-10 px-3 py-1.5 rounded-md text-xs transition-colors',
        active ? 'bg-accent text-on-accent' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TypeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={cn('min-h-10 px-3.5 py-1.5 rounded-md text-sm transition-colors', active ? 'bg-accent text-on-accent' : 'text-muted hover:text-content')}
      onClick={onClick}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
