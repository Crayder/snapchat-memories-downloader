import type { PipelineRunRequest, PipelineRunSummary } from './types/memory-entry';

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
    | 'summary';
  phase?: string;
  entryIndex?: number;
  status?: string;
  message?: string;
  summary?: PipelineRunSummary;
}

export interface RendererAPI {
  selectFile(filters: DialogFilters): Promise<DialogResult>;
  selectDirectory(): Promise<DialogResult>;
  runPipeline(request: PipelineRunRequest): Promise<PipelineRunSummary>;
  onProgress(callback: (event: PipelineProgressEvent) => void): () => void;
}

declare global {
  interface Window {
    electronAPI: RendererAPI;
  }
}
