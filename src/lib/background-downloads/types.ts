import type { LibraryMetadata } from '@/lib/local-library/types';
import type { MediaContext } from '@/lib/media-context';

export type BackgroundDownloadStatus = 'queued' | 'downloading' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface BackgroundDownloadTask {
  id: string;
  url: string;
  provider?: 'quark';
  mediaContext?: MediaContext;
  title: string;
  format: 'MP4';
  metadata: LibraryMetadata;
  status: BackgroundDownloadStatus;
  finished: number;
  total: number;
  bytes: number;
  error?: string;
  libraryItemId?: string;
  createdAt: number;
  updatedAt: number;
}
export interface BackgroundDownloadsResponse {
  enabled: boolean;
  workerOnline: boolean;
  tasks: BackgroundDownloadTask[];
}
