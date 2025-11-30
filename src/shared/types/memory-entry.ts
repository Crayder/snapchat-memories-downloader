export type MemoryMediaType = 'image' | 'video' | 'unknown';

export type DownloadStatus =
  | 'pending'
  | 'downloading'
  | 'downloaded'
  | 'processed'
  | 'metadata'
  | 'deduped'
  | 'failed'
  | 'skipped';

export interface MemoryEntry {
  index: number;
  capturedAtUtc: string;
  capturedAtRaw: string;
  mediaType: MemoryMediaType;
  hasGps: boolean;
  latitude?: number;
  longitude?: number;
  locationRaw?: string;
  downloadUrl: string;
  downloadMethodHint?: 'GET' | 'POST';
  isZipPayload?: boolean;
  downloadStatus: DownloadStatus;
  downloadedPath?: string;
  finalPath?: string;
  errors?: string[];
  attempts?: number;
  contentHash?: string;
}

export interface PipelineOptions {
  concurrency: number;
  retryLimit: number;
  throttleDelayMs: number;
  attemptTimeoutMs: number;
  keepZipPayloads: boolean;
  cleanupDownloads: boolean;
  batchPauseCount: number;
  retryFailedOnly?: boolean;
  dedupeStrategy: 'move' | 'delete' | 'none';
  dryRun: boolean;
  verifyOnly: boolean;
}

export interface PipelineRunRequest {
  exportZipPath: string;
  outputDir: string;
  options: PipelineOptions;
}

export interface PipelineRunSummary {
  startedAt: string;
  finishedAt: string;
  total: number;
  downloaded: number;
  processed: number;
  metadataWritten: number;
  deduped: number;
  failures: number;
  reattempts: number;
  durationMs: number;
  reportPath: string;
}
