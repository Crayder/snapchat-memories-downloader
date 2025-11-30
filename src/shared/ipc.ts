import type { PipelineRunRequest, PipelineRunSummary } from './types/memory-entry';
import type { PipelineStatsPayload } from './types/pipeline-stats';

export type DialogFilters = Array<{ name: string; extensions: string[] }>; // simple helper type

export interface DialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface PipelineProgressEvent {
  type:
    | 'phase'
    | 'entry-status'
    | 'log'
    | 'error'
    | 'summary'
    | 'stats';
  phase?: string;
  entryIndex?: number;
  status?: string;
  message?: string;
  summary?: PipelineRunSummary;
  stats?: PipelineStatsPayload;
}

export interface RendererAPI {
  selectFile(filters: DialogFilters): Promise<DialogResult>;
  selectDirectory(): Promise<DialogResult>;
  runPipeline(request: PipelineRunRequest): Promise<PipelineRunSummary>;
  pausePipeline(): Promise<{ paused: boolean }>;
  resumePipeline(): Promise<{ paused: boolean }>;
  exportDiagnostics(): Promise<{ path: string }>;
  openOutputFolder(): Promise<{ path: string }>;
  onProgress(callback: (event: PipelineProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: RendererAPI;
  }
}
