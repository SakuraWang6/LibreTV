interface DownloadIdentity {
  title: string;
  year?: string;
  kind: 'movie' | 'tv';
  episodeCount: number;
  episodeLabels?: string[];
  index: number;
}

/** Keep an actual collection part separate from the catalogue's overall title/year. */
export function movieDownloadMetadata(identity: DownloadIdentity): { title: string; year?: string } {
  const { title, year, kind, episodeCount, episodeLabels = [], index } = identity;
  if (kind !== 'movie' || episodeCount < 2 || episodeLabels.length !== episodeCount) return { title, year };
  const labels = episodeLabels.map((label) => label.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  const label = labels[index];
  if (!label || new Set(labels).size !== labels.length || labels.some((value) => !value)
    || /^(?:正片|电影|播放|(?:\d{3,4}p|[248]k|hdr?|bd|hd|蓝光)(?:[\s简繁中字国语粤语]*))$/i.test(label)) return { title, year };
  // A collection's catalogue year often describes only its first film. If the
  // selected part has no explicit year, leave it unknown rather than copying it.
  const partYear = label.match(/(?:^|[^\d])((?:18|19|20|21)\d{2})(?!\d)/)?.[1];
  return { title: `${title} · ${label}`, year: partYear };
}
