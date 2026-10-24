/** Shared contract for the optional disk-backed library on a local installation. */
export type LibraryKind = 'movie' | 'tv';

export interface LibraryMetadata {
  title: string;
  kind: LibraryKind;
  year?: string;
  description?: string;
  coverUrl?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
  sourceName?: string;
}

export interface LibraryEntry extends Omit<LibraryMetadata, 'coverUrl'> {
  id: string;
  groupId: string;
  bytes: number;
  format: 'MP4' | 'TS' | 'WEBM' | 'MOV';
  createdAt: string;
  mediaUrl: string;
  posterUrl: string;
  position?: number;
  duration?: number;
  lastPlayedAt?: string;
}

export interface LibraryResponse {
  enabled: boolean;
  items: LibraryEntry[];
}

export const LOCAL_LIBRARY_UPDATED_EVENT = 'libretv:library-updated';
