import type { LibraryMetadata } from '@/lib/local-library/types';

export type BackgroundDownloadStatus = 'queued' | 'downloading' | 'processing' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface BackgroundDownloadTask {
  id: string;
  url: string;
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
