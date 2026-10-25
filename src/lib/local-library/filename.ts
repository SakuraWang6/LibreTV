import type { LibraryMetadata } from './types';

/** Pure filename parsing, shared by browser uploads and local directory scans. */
export function guessLibraryMetadata(filename: string): LibraryMetadata {
  const basename = filename.replace(/^.*[/\\]/, '').replace(/\.(mp4|m4v|webm|mov|ts|mkv|avi)$/i, '');
  const episode = /(?:^|[\s._-])S(\d{1,2})[\s._-]*E(\d{1,3})(?=$|[\s._-])/i.exec(basename)
    ?? /S(\d{1,2})E(\d{1,3})/i.exec(basename);
  const chineseEpisode = /第\s*(\d+)\s*[集话]/.exec(basename);
  const markerIndex = episode?.index ?? chineseEpisode?.index;
  const rawTitle = markerIndex !== undefined ? basename.slice(0, markerIndex) : basename;
  const cleaned = rawTitle.replace(/[._]/g, ' ').replace(/[-\s]+$/, '').trim() || basename;
  // A separated trailing year is release metadata; a numeric film title such
  // as 1917 or 1984 must remain a title.
  const dated = /^(.*?)\s*(?:[([【]\s*((?:18|19|20|21)\d{2})\s*[)\]】]|[\s-]+((?:18|19|20|21)\d{2}))$/.exec(cleaned);
  const year = dated?.[1].trim() ? dated[2] || dated[3] : undefined;
  const title = year ? dated![1].trim() : cleaned;
  const release = year ? { year } : {};
  if (episode) return { title, ...release, kind: 'tv', seasonNumber: Number(episode[1]) || 1, episodeNumber: Number(episode[2]) || 1 };
  if (chineseEpisode) return { title, ...release, kind: 'tv', seasonNumber: 1, episodeNumber: Number(chineseEpisode[1]) || 1 };
  return { title, ...release, kind: 'movie' };
}
