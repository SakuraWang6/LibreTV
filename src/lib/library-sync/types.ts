import type { LibraryEntry } from '@/lib/local-library/types';

export interface SyncCacheTask {
  id: string;
  itemId: string;
  status: 'queued' | 'downloading' | 'completed' | 'error';
  progress: number;
  error?: string;
}

export interface SyncCatalogItem extends LibraryEntry {
  cachedLocalId?: string;
  cacheTask?: SyncCacheTask;
}

export interface SyncProgress {
  position?: number;
  duration?: number;
  lastPlayedAt?: string;
}

export interface SyncProgressConflict {
  itemId: string;
  localId: string;
  title: string;
  local: SyncProgress;
  server: SyncProgress;
}

export interface SyncStatus {
  enabled: boolean;
  online: boolean;
  serverUrl?: string;
  catalog: SyncCatalogItem[];
  progressConflicts: SyncProgressConflict[];
  error?: string;
}
