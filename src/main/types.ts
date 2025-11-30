import type { MemoryEntry } from '../shared/types/memory-entry.js';

export type ProgressCallback = (event: {
  type: 'phase' | 'entry' | 'log' | 'error';
  phase?: string;
  entry?: MemoryEntry;
  message?: string;
  error?: Error;
}) => void;
