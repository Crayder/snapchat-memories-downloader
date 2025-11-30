import type { MemoryEntry } from '../shared/types/memory-entry.js';
import type { PipelineStatsPayload } from '../shared/types/pipeline-stats.js';

export type ProgressCallback = (event: {
  type: 'phase' | 'entry' | 'log' | 'error' | 'stats';
  phase?: string;
  entry?: MemoryEntry;
  message?: string;
  error?: Error;
  stats?: PipelineStatsPayload;
}) => void;
