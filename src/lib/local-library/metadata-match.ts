'use client';

import { api } from '@/lib/client-api';
import { isExactTitleMatch, isNumberedCollectionTitle } from '@/lib/cms-parser';
import { playbackKind, titleSeason } from '@/lib/playback-source';
import { isSupportedSource } from '@/lib/source-config';
import type { SearchResultItem, SourceConfig, VideoDetail } from '@/lib/types';
import { guessLibraryMetadata } from './filename';
import type { LibraryMetadata } from './types';

export interface LibraryMetadataMatch {
  status: 'matched' | 'unmatched' | 'ambiguous' | 'unavailable';
  metadata: LibraryMetadata;
}

const MAX_DETAILS = 8;
const MATCH_TIMEOUT_MS = 15_000;

function plainText(value?: string): string {
  return (value || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function yearOf(value?: string): string | undefined {
  return value?.trim().match(/^((?:18|19|20|21)\d{2})(?:年)?$/)?.[1];
}

function coverUrl(value?: string): string | undefined {
  if (!value || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function titleMatches(metadata: LibraryMetadata, title: string): boolean {
  if (!title || isNumberedCollectionTitle(title) || isNumberedCollectionTitle(metadata.title)) return false;
  const wanted = titleSeason(metadata.title);
  const candidate = titleSeason(title);
  if (metadata.kind === 'movie' && (wanted.season !== undefined || candidate.season !== undefined)) return false;
  if (metadata.kind === 'tv' && (candidate.season ?? 1) !== (wanted.season ?? metadata.seasonNumber ?? 1)) return false;
  // Require both directions: the search matcher deliberately accepts some
  // season aliases, while metadata updates need one specific work/cut.
  return isExactTitleMatch(candidate.title, wanted.title) && isExactTitleMatch(wanted.title, candidate.title);
}

interface Candidate { result: SearchResultItem; source: SourceConfig }
interface Confirmed { metadata: LibraryMetadata; year: string }

function confirm(metadata: LibraryMetadata, candidate: Candidate, detail: VideoDetail): Confirmed | undefined {
  const info = detail.videoInfo;
  const title = plainText(info.title);
  if (title.length > 300 || !titleMatches(metadata, title)) return undefined;
  const kind = playbackKind(info.typeName) ?? playbackKind(candidate.result.typeName);
  if (kind !== metadata.kind) return undefined;
  const year = yearOf(info.year);
  const claimedYear = yearOf(candidate.result.year);
  if (!year || (metadata.year && year !== yearOf(metadata.year)) || (claimedYear && claimedYear !== year)) return undefined;
  const cover = coverUrl(info.cover) ?? coverUrl(candidate.result.pic) ?? coverUrl(metadata.coverUrl);
  const description = (plainText(info.desc) || plainText(metadata.description)).slice(0, 12000);
  if (!cover || !description) return undefined;
  return {
    year,
    metadata: {
      ...metadata,
      title: metadata.kind === 'tv' ? titleSeason(title).title : title,
      year,
      ...(metadata.kind === 'tv' ? { seasonNumber: metadata.seasonNumber ?? titleSeason(metadata.title).season ?? 1 } : {}),
      ...(cover ? { coverUrl: cover } : {}),
      ...(description ? { description } : {}),
      sourceName: plainText(candidate.source.name).slice(0, 300),
    },
  };
}

/** Find one confirmed identity, rather than attaching the first search hit. */
export async function matchLibraryMetadata(metadata: LibraryMetadata, sources: SourceConfig[], signal?: AbortSignal): Promise<LibraryMetadataMatch> {
  const unchanged = (status: Exclude<LibraryMetadataMatch['status'], 'matched'>): LibraryMetadataMatch => ({ status, metadata });
  signal?.throwIfAborted();
  const guessed = guessLibraryMetadata(`${metadata.title}.mp4`);
  if (metadata.year && guessed.year && yearOf(metadata.year) !== guessed.year) return unchanged('unmatched');
  const identity = { ...metadata, title: guessed.title, year: metadata.year || guessed.year };
  if (!identity.title.trim() || (identity.year && !yearOf(identity.year)) || isNumberedCollectionTitle(identity.title)) return unchanged('unmatched');
  const namedSeason = titleSeason(identity.title).season;
  if (identity.kind === 'tv' && namedSeason !== undefined && identity.seasonNumber !== undefined && namedSeason !== identity.seasonNumber) return unchanged('unmatched');
  const seenSources = new Set<string>();
  const selected = sources.filter((source) => {
    if (!isSupportedSource(source) || source.isAdult || seenSources.has(source.url)) return false;
    seenSources.add(source.url);
    return true;
  });
  if (!selected.length) return unchanged('unavailable');
  const timeout = AbortSignal.timeout(MATCH_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await api.search(identity.title, selected, true, { signal: requestSignal });
    requestSignal.throwIfAborted();
    const sourceByKey = new Map(selected.map((source) => [source.key, source]));
    const seen = new Set<string>();
    const candidates: Candidate[] = response.list.flatMap((result) => {
      const source = sourceByKey.get(result.sourceKey);
      const key = `${result.sourceKey}\0${result.vodId}`;
      const kind = playbackKind(result.typeName);
      if (!source || !result.vodId || result.isAdult || seen.has(key) || !titleMatches(identity, plainText(result.name))
        || (kind && kind !== identity.kind) || (identity.year && yearOf(result.year) && yearOf(result.year) !== yearOf(identity.year))) return [];
      seen.add(key);
      return [{ result, source }];
    });
    if (!candidates.length) return unchanged('unmatched');
    const claimedYears = new Set(candidates.map(({ result }) => yearOf(result.year)).filter(Boolean));
    if (!identity.year && claimedYears.size > 1) return unchanged('ambiguous');
    // Missing years may hide another adaptation. Do not silently drop that
    // unresolved identity when bounding work across very large source lists.
    if (!identity.year && candidates.length > MAX_DETAILS && candidates.some(({ result }) => !yearOf(result.year))) return unchanged('ambiguous');
    const ordered = [...candidates].sort((a, b) => Number(Boolean(b.result.pic)) - Number(Boolean(a.result.pic)));
    let unknownFailed = false;
    let detailFailures = 0;
    const confirmed = (await Promise.all(ordered.slice(0, MAX_DETAILS).map(async (candidate) => {
      try {
        const detail = await api.detail(candidate.result.vodId, candidate.source, requestSignal);
        requestSignal.throwIfAborted();
        return confirm(identity, candidate, detail);
      } catch {
        detailFailures++;
        if (!yearOf(candidate.result.year)) unknownFailed = true;
        return undefined;
      }
    }))).filter((item): item is Confirmed => Boolean(item));
    requestSignal.throwIfAborted();
    if (!identity.year && unknownFailed) return unchanged('unavailable');
    if (!confirmed.length) return unchanged(detailFailures ? 'unavailable' : 'unmatched');
    if (new Set(confirmed.map((entry) => entry.year)).size > 1) return unchanged('ambiguous');
    return { status: 'matched', metadata: confirmed[0].metadata };
  } catch {
    signal?.throwIfAborted();
    return unchanged('unavailable');
  }
}
