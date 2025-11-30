import { contextBridge, ipcRenderer } from 'electron';
import type { DialogFilters, PipelineRunRequest, PipelineRunSummary, RendererAPI, PipelineProgressEvent } from '../shared/ipc.js';

const api: RendererAPI = {
  selectFile: (filters: DialogFilters) => ipcRenderer.invoke('dialog:select-file', filters),
  selectDirectory: () => ipcRenderer.invoke('dialog:select-directory'),
  runPipeline: (request: PipelineRunRequest): Promise<PipelineRunSummary> => ipcRenderer.invoke('pipeline:start', request),
  pausePipeline: (): Promise<{ paused: boolean }> => ipcRenderer.invoke('pipeline:pause'),
  resumePipeline: (): Promise<{ paused: boolean }> => ipcRenderer.invoke('pipeline:resume'),
  exportDiagnostics: (): Promise<{ path: string }> => ipcRenderer.invoke('pipeline:diagnostics'),
  onProgress: (callback: (event: PipelineProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PipelineProgressEvent) => callback(payload);
    ipcRenderer.on('pipeline:progress', listener);
    return () => ipcRenderer.removeListener('pipeline:progress', listener);
  }
};

contextBridge.exposeInMainWorld('electronAPI', api);
