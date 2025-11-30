export interface PipelineStatsPayload {
  stage: string;
  total: number;
  downloaded: number;
  processed: number;
  metadataWritten: number;
  deduped: number;
  failures: number;
  images: number;
  videos: number;
  withGps: number;
  withoutGps: number;
  reattempts: number;
}
