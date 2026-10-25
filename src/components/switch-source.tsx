'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client-api';
import { resolveSource, useAppStore } from '@/lib/store';
import { isQualityEntryFresh, qualityKey } from '@/lib/quality';
import type { QualityEntry, SearchResultItem, SourceConfig, VideoDetail } from '@/lib/types';
import { identityMismatch, matchPlaybackEpisode, playbackKind, titleSeason, type PlaybackIdentity, type PlaybackSelection } from '@/lib/playback-source';
import { cn } from '@/lib/utils';
import { Spinner } from './states';
import { QualityBadge } from './quality-badge';
import { useQualityProbe } from './use-quality-probe';

interface Candidate { source: SourceConfig; result: SearchResultItem; detail?: VideoDetail; ms?: number; error?: string }

/** Source discovery leaves the active player intact until an exact episode is selected. */
export function PlaybackSourcePicker({ identity, currentSourceKey = '', currentVodId = '', currentDetail, onSwitch, autoLoad = false }: {
  identity: PlaybackIdentity;
  currentSourceKey?: string;
  currentVodId?: string;
  currentDetail?: VideoDetail;
  onSwitch: (selection: PlaybackSelection) => void;
  autoLoad?: boolean;
}) {
  const selectedKeys = useAppStore((state) => state.selectedKeys);
  const envSources = useAppStore((state) => state.envSources);
  const customAPIs = useAppStore((state) => state.customAPIs);
  const yellowFilter = useAppStore((state) => state.yellowFilter);
  const qualityMap = useAppStore((state) => state.qualityMap);
  const [enabled, setEnabled] = useState(autoLoad);
  const [revision, setRevision] = useState(0);
  const [discovered, setDiscovered] = useState<Candidate[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'testing' | 'done'>('idle');
  const [error, setError] = useState('');
  const fullDetails = useRef(new Map<Candidate, { detail: VideoDetail; ms: number }>());
  const sources = useMemo(() => {
    const seen = new Set<string>();
    return selectedKeys.map((key) => resolveSource({ envSources, customAPIs }, key)).filter((source): source is SourceConfig => {
      if (!source || seen.has(source.key)) return false;
      seen.add(source.key);
      return true;
    });
  }, [selectedKeys, envSources, customAPIs]);
  const queryTitle = titleSeason(identity.title).title;
  const { qualities, probing, prime, probe } = useQualityProbe(sources);
  const cachedQualities = useMemo(() => {
    const cached: Record<string, QualityEntry> = {};
    for (const candidate of candidates) {
      const key = qualityKey(candidate.source.key, candidate.result.vodId);
      const entry = qualityMap[key];
      if (entry && isQualityEntryFresh(entry)) cached[key] = entry;
    }
    return cached;
  }, [candidates, qualityMap]);
  useEffect(() => { prime(candidates.map((candidate) => candidate.result)); }, [candidates, prime]);
  // Changing episodes re-resolves LIBVIO's selected slot without searching again.
  const identityKey = JSON.stringify({ title: identity.title, kind: identity.kind, typeName: identity.typeName, year: identity.year, seasonNumber: identity.seasonNumber });
  const selectionKey = discovered.some((candidate) => candidate.source.kind === 'libvio')
    ? JSON.stringify({ episodeNumber: identity.episodeNumber ?? 1, seasonNumber: identity.seasonNumber ?? titleSeason(identity.title).season ?? 1 }) : '';
  useEffect(() => { if (autoLoad) setEnabled(true); }, [autoLoad]);

  useEffect(() => {
    if (!enabled || !queryTitle || !sources.length) return;
    const controller = new AbortController();
    fullDetails.current.clear();
    setDiscovered([]);
    setCandidates([]);
    setError('');
    setPhase('searching');
    const requestedIdentity = JSON.parse(identityKey) as PlaybackIdentity;
    void (async () => {
      try {
        const response = await api.search(queryTitle, sources, yellowFilter, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const matches: Candidate[] = [];
        for (const source of sources) {
          const results = response.list.filter((result) => result.sourceKey === source.key
            && !identityMismatch(requestedIdentity, { title: result.name, year: result.year, kind: playbackKind(result.typeName), typeName: result.typeName }));
          for (const result of results.slice(0, 2)) matches.push({ source, result });
        }
        setDiscovered(matches);
        if (!matches.length) setPhase('done');
      } catch (failure) {
        if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : '查找播放源失败'); setPhase('done'); }
      }
    })();
    return () => controller.abort();
  }, [enabled, queryTitle, identityKey, sources, yellowFilter, revision]);

  useEffect(() => {
    if (!enabled || !discovered.length) return;
    const controller = new AbortController();
    const selection = selectionKey ? JSON.parse(selectionKey) as { episodeNumber: number; seasonNumber: number } : undefined;
    setCandidates(discovered);
    setPhase('testing');
    void Promise.all(discovered.map(async (candidate) => {
      if (candidate.source.key === currentSourceKey && candidate.result.vodId === currentVodId) return;
      const started = performance.now();
      try {
        const cached = candidate.source.kind !== 'libvio' ? fullDetails.current.get(candidate) : undefined;
        const detail = cached?.detail ?? await api.detail(candidate.result.vodId, candidate.source, controller.signal, candidate.source.kind === 'libvio' ? selection : undefined);
        const ms = cached?.ms ?? Math.round(performance.now() - started);
        if (!controller.signal.aborted) {
          if (candidate.source.kind !== 'libvio') fullDetails.current.set(candidate, { detail, ms });
          setCandidates((previous) => previous.map((item) => item.source.key === candidate.source.key && item.result.vodId === candidate.result.vodId
            ? { ...item, detail, ms } : item));
        }
      } catch (failure) {
        if (!controller.signal.aborted) setCandidates((previous) => previous.map((item) => item.source.key === candidate.source.key && item.result.vodId === candidate.result.vodId
          ? { ...item, error: failure instanceof Error ? failure.message : '暂时无法连接' } : item));
      }
    })).then(() => { if (!controller.signal.aborted) setPhase('done'); });
    return () => controller.abort();
  }, [enabled, discovered, selectionKey, currentSourceKey, currentVodId]);

  const sorted = candidates.map((candidate) => currentDetail && candidate.source.key === currentSourceKey && candidate.result.vodId === currentVodId
    ? { ...candidate, detail: currentDetail } : candidate).sort((a, b) => {
    const currentA = a.source.key === currentSourceKey && a.result.vodId === currentVodId;
    const currentB = b.source.key === currentSourceKey && b.result.vodId === currentVodId;
    if (currentA !== currentB) return currentA ? -1 : 1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });

  return <section aria-label="切换播放源" className="border-t border-line pt-4 mt-4">
    <div className="flex items-center justify-between gap-2 mb-2">
      <h2 className="text-sm font-semibold text-content">播放源</h2>
      <div className="flex gap-1">
        {sorted.some((candidate) => candidate.detail) && <button type="button" className="btn-ghost btn-sm" onClick={() => probe(sorted.filter((candidate) => candidate.detail && matchPlaybackEpisode(identity, candidate.result, candidate.detail).index !== undefined).map((candidate) => candidate.result))}>画质</button>}
        <button type="button" className="btn-ghost btn-sm" disabled={phase === 'searching' || phase === 'testing'} onClick={() => { setEnabled(true); setRevision((value) => value + 1); }}>{enabled ? '重新查找' : '联网查找'}</button>
      </div>
    </div>
    {!sources.length ? <p className="text-xs text-muted">未选择播放源</p>
      : !enabled ? null
      : <>
        {(phase === 'searching' || phase === 'testing') && <p className="flex items-center gap-2 text-xs text-muted mb-2" role="status"><Spinner size="sm" />{phase === 'searching' ? '正在查找同片播放源' : '正在确认剧集'}</p>}
        {error && <p className="text-xs text-danger mb-2" role="status">{error}</p>}
        {phase === 'done' && !sorted.length && !error && <p className="text-xs text-muted" role="status">暂无匹配来源</p>}
        <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
          {sorted.map((candidate) => {
            const current = candidate.source.key === currentSourceKey && candidate.result.vodId === currentVodId;
            const match = candidate.detail ? matchPlaybackEpisode(identity, candidate.result, candidate.detail) : undefined;
            const unavailable = candidate.error || match?.reason;
            const ready = candidate.detail && match?.index !== undefined;
            const key = qualityKey(candidate.source.key, candidate.result.vodId);
            return <button key={`${candidate.source.key}:${candidate.result.vodId}`} type="button"
              disabled={current || !ready}
              className={cn('w-full text-left rounded-lg border px-3 py-2 transition-colors', current ? 'border-accent/40 bg-accent/5' : ready ? 'border-line hover:bg-hover' : 'border-line opacity-65')}
              onClick={() => { if (candidate.detail && match?.index !== undefined) onSwitch({ source: candidate.source, result: candidate.result, detail: candidate.detail, index: match.index }); }}>
              <span className="flex items-center justify-between gap-2 text-xs font-medium text-content"><span>{candidate.source.name}</span><QualityBadge entry={cachedQualities[key] || qualities[key]} loading={probing[key]} /><span className="text-[10px] text-muted">{current ? ready ? '正在播放' : '当前来源' : ready ? '续接播放' : '暂不可用'}</span></span>
              <span className="block text-[11px] text-muted mt-1">{unavailable || (!candidate.detail ? '确认中…' : `${candidate.result.name}${identity.kind === 'tv' ? ` · 第 ${identity.episodeNumber ?? 1} 集` : ''}`)}</span>
            </button>;
          })}
        </div>
      </>}
  </section>;
}
