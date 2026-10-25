import { isExactTitleMatch, isNumberedCollectionTitle } from './cms-parser';
import type { SearchResultItem, SourceConfig, VideoDetail } from './types';
import type { LibraryEntry } from './local-library/types';
import { buildWatchUrl } from './utils';

export interface PlaybackIdentity {
  title: string;
  kind?: 'movie' | 'tv';
  typeName?: string;
  year?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  multipartMovie?: boolean;
}

export interface PlaybackSelection {
  source: SourceConfig;
  result: SearchResultItem;
  detail: VideoDetail;
  index: number;
}

const chineseDigits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function episodeInteger(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    if ((tens && chineseDigits[tens] === undefined) || (units && chineseDigits[units] === undefined)) return undefined;
    return (tens ? chineseDigits[tens] : 1) * 10 + (units ? chineseDigits[units] : 0);
  }
  return chineseDigits[value];
}

export function titleSeason(title: string): { title: string; season?: number } {
  const pattern = /第\s*([0-9零〇一二两三四五六七八九十]+)\s*季|\bseason\s*(\d+)\b|\bS(\d{1,2})\b/gi;
  let season: number | undefined;
  const base = title.normalize('NFKC').replace(pattern, (_match, chinese: string | undefined, english: string | undefined, short: string | undefined) => {
    season ??= episodeInteger(chinese || english || short || '');
    return '';
  }).trim();
  return { title: base, season };
}

export function episodeFromLabel(label?: string): number | undefined {
  if (!label) return undefined;
  const normalized = label.normalize('NFKC').trim();
  // A combined or split episode cannot safely map to one episode of another cut.
  if (/\d\s*[-~至、/]\s*\d|[上下][集篇部]?\s*$/.test(normalized)) return undefined;
  const match = normalized.match(/(?:第\s*([0-9零〇一二两三四五六七八九十]+)\s*[集话話回])|(?:\b(?:S\d+)?E(?:P(?:ISODE)?)?\s*(\d+)\b)|^(\d{1,4})$/i);
  return match ? episodeInteger(match[1] || match[2] || match[3]) : undefined;
}

export function playbackKind(typeName?: string, episodeCount = 0): 'movie' | 'tv' | undefined {
  if (/电影|片|movie|film/i.test(typeName || '')) return 'movie';
  if (/剧|电视|连续|series|drama|\btv\b/i.test(typeName || '')) return 'tv';
  return episodeCount > 1 ? 'tv' : undefined;
}

/** Multiple film parts cannot be continued safely through an ordinal index. */
export function isMultipartMovie(detail?: VideoDetail): boolean {
  if (!detail) return false;
  if (isNumberedCollectionTitle(detail.videoInfo.title || '')) return true;
  if (playbackKind(detail.videoInfo.typeName) !== 'movie' || detail.episodes.length < 2) return false;
  const labels = detail.episodeLabels?.map((label) => label.replace(/<[^>]*>/g, ' ').normalize('NFKC').trim());
  if (!labels || labels.length !== detail.episodes.length || labels.some((label) => !label)) return true;
  const qualityLabel = /^(?:(?:正片|电影|播放|蓝光原盘|蓝光|高清|超清|原盘|修复版|重制版|国语|粤语|英语|中字|中英双字|无字幕|简|繁|HD|BD|UHD|[248]K|(?:720|1080|2160)[PI]|HDR(?:10)?\+?|DV|WEB[ .-]?DL)|[\s[\]()【】_.|/+-])+$/i;
  const parts = labels.filter((label) => !qualityLabel.test(label));
  return parts.length > 0;
}

export function isPlayableEpisode(url: string, detail?: VideoDetail): boolean {
  // Old cached website responses must not silently become ordinary CMS media.
  if (detail && ('mediaContext' in detail || 'playbackType' in detail || 'externalLinks' in detail)) return false;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    return /\.(?:m3u8|mp4|m4v|webm|mov|mkv|ts)(?:$|[?#])/i.test(parsed.href);
  } catch { return false; }
}

export function isNativeMediaUrl(url: string): boolean {
  try {
    const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
    let parsed = new URL(url, origin);
    if (parsed.origin === origin) {
      if (parsed.searchParams.has('mediaContext')) return false;
      let target: string | undefined;
      if (parsed.pathname === '/api/proxy' && parsed.searchParams.getAll('url').length === 1) target = parsed.searchParams.get('url') || undefined;
      else if (parsed.pathname.startsWith('/api/proxy/')) target = decodeURIComponent(parsed.pathname.slice('/api/proxy/'.length));
      if (target !== undefined) {
        if (!/^https?:\/\//i.test(target)) return false;
        parsed = new URL(target);
      }
    }
    // Unwrap exactly once. Arbitrary external parser queries remain HTML/HLS paths.
    return ['http:', 'https:'].includes(parsed.protocol) && /\.(?:mp4|m4v|webm|mov|mkv|ts)$/i.test(parsed.pathname);
  }
  catch { return false; }
}

function yearOf(value?: string): string | undefined { return value?.match(/^\d{4}/)?.[0]; }

export function identityMismatch(current: PlaybackIdentity, candidate: PlaybackIdentity): string | undefined {
  const a = titleSeason(current.title);
  const b = titleSeason(candidate.title);
  if (!a.title || !b.title || !isExactTitleMatch(b.title, a.title)) return '片名不一致';
  const currentShort = /短剧|短片|微短/i.test(current.typeName || current.title);
  const candidateShort = /短剧|短片|微短/i.test(candidate.typeName || candidate.title);
  if (currentShort !== candidateShort) return '与当前长剧版本不一致';
  if (current.kind && candidate.kind && current.kind !== candidate.kind) return '电影与电视剧类型不一致';
  const ay = yearOf(current.year);
  const by = yearOf(candidate.year);
  if (ay && by && ay !== by) return '年份不一致';
  if (current.kind === 'tv' || candidate.kind === 'tv') {
    const seasonA = a.season ?? current.seasonNumber ?? 1;
    const seasonB = b.season ?? candidate.seasonNumber ?? 1;
    if (seasonA !== seasonB) return '季数不一致';
  }
  return undefined;
}

export function matchPlaybackEpisode(current: PlaybackIdentity, result: Pick<SearchResultItem, 'name' | 'typeName' | 'year'>, detail: VideoDetail): { index?: number; reason?: string } {
  const kind = playbackKind(detail.videoInfo.typeName || result.typeName, detail.episodes.length);
  const title = detail.videoInfo.title || result.name;
  const wantedSeason = titleSeason(current.title).season ?? current.seasonNumber ?? 1;
  const season = titleSeason(title).season;
  const reason = identityMismatch(current, { title, kind, typeName: detail.videoInfo.typeName || result.typeName, year: detail.videoInfo.year || result.year, seasonNumber: season });
  if (reason) return { reason };
  if ('mediaContext' in detail || 'playbackType' in detail || 'externalLinks' in detail) return { reason: '此来源已停用' };
  if (current.multipartMovie || isNumberedCollectionTitle(current.title) || isMultipartMovie(detail)) {
    return { reason: '电影合集或分段版本需手动选择分部' };
  }
  if (current.kind !== 'tv' && kind !== 'tv') {
    if ((current.episodeNumber ?? 1) > 1) return { reason: '分段版本不同，不能准确续接' };
    return isPlayableEpisode(detail.episodes[0] || '', detail) ? { index: 0 } : { reason: '没有可直接播放的视频' };
  }
  const episode = current.episodeNumber ?? 1;
  const labels = detail.episodeLabels || [];
  const numbered = labels.map((label, index) => ({ index, number: episodeFromLabel(label) }));
  if (numbered.some((item) => item.number !== undefined)) {
    const matches = numbered.filter((item) => item.number === episode && (season ?? 1) === wantedSeason);
    if (matches.length !== 1) return { reason: `未能准确匹配第 ${episode} 集` };
    return isPlayableEpisode(detail.episodes[matches[0].index] || '', detail) ? { index: matches[0].index } : { reason: '本集没有可直接播放的视频' };
  }
  if (labels.some((label) => /\d\s*[-~至、/]\s*\d|[上下][集篇部]?\s*$/.test(label))) return { reason: '该源使用合并或拆分集，不能准确续接' };
  const index = episode - 1;
  return Number.isInteger(index) && index >= 0 && isPlayableEpisode(detail.episodes[index] || '', detail)
    ? { index } : { reason: `该源尚无第 ${episode} 集` };
}

/** Re-check disk metadata before linking online playback to an existing file. */
export function canLinkLibraryProgress(entry: LibraryEntry, current: PlaybackIdentity, detail: VideoDetail): boolean {
  if (!detail.episodes.length) return false;
  if (current.multipartMovie || isNumberedCollectionTitle(entry.title) || isMultipartMovie(detail)) return false;
  const typeName = detail.videoInfo.typeName;
  const kind = playbackKind(typeName, detail.episodes.length);
  const confirmed: PlaybackIdentity = { ...current, title: detail.videoInfo.title || current.title, kind, typeName, year: detail.videoInfo.year };
  if (identityMismatch({ ...entry, typeName: entry.kind === 'tv' ? '电视剧' : '电影' }, confirmed)) return false;
  // Unknown category needs a positive, matching year rather than only a name.
  if (!playbackKind(typeName) && (!yearOf(entry.year) || yearOf(entry.year) !== yearOf(confirmed.year))) return false;
  if (entry.kind === 'tv' && (entry.episodeNumber ?? 1) !== (current.episodeNumber ?? 1)) return false;
  return !('mediaContext' in detail || 'playbackType' in detail || 'externalLinks' in detail);
}

export function requestedResumePosition(value: string | null): number | undefined {
  if (value === null) return undefined;
  const position = Number(value);
  return Number.isFinite(position) && position >= 0 ? position : 0;
}

export function clampResumePosition(position: number, duration: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position <= 0 || duration <= 0) return 0;
  return Math.min(position, Math.max(0, duration - 0.25));
}

export function buildPlaybackSwitchUrl(selection: PlaybackSelection, position: number, libraryId?: string): string {
  const url = buildWatchUrl({ sourceKey: selection.source.key, vodId: selection.result.vodId, index: selection.index,
    title: selection.detail.videoInfo.title || selection.result.name, episodeUrl: selection.detail.episodes[selection.index],
    sourceUrl: selection.source.url, detail: selection.source.detail });
  const params = new URLSearchParams(url.split('?')[1]);
  params.set('position', String(Number.isFinite(position) ? Math.max(0, position) : 0));
  if (libraryId && /^[a-f0-9]{32}$/.test(libraryId)) params.set('libraryId', libraryId);
  return `/watch?${params.toString()}`;
}
