import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import log from './logger.js';
import { PipelineRunner } from './pipeline/pipeline-runner.js';
import type { PipelineRunRequest } from '../shared/types/memory-entry.js';
import type { PipelineProgressEvent } from '../shared/ipc.js';
import { ensureAppDirectories } from './config/app-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
const runner = new PipelineRunner();

const createWindow = async () => {
  await ensureAppDirectories();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'Snap Memories Backup',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId('app.snap.memories.backup');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  createWindow().catch((error) => log.error(error));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => log.error(error));
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('dialog:select-file', async (_, filters) => {
  if (!mainWindow) {
    throw new Error('Main window not ready');
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    filters,
    properties: ['openFile']
  });
  return { canceled: result.canceled, filePaths: result.filePaths };
});

ipcMain.handle('dialog:select-directory', async () => {
  if (!mainWindow) {
    throw new Error('Main window not ready');
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  return { canceled: result.canceled, filePaths: result.filePaths };
});

ipcMain.handle('pipeline:start', async (_, request: PipelineRunRequest) => {
  if (!mainWindow) {
    throw new Error('Main window is not ready.');
  }
  const progressEmitter = (event: PipelineProgressEvent) => {
    mainWindow?.webContents.send('pipeline:progress', event);
  };
  const summary = await runner.run(request, (event) => {
    if (event.type === 'stats' && event.stats) {
      progressEmitter({ type: 'stats', stats: event.stats });
      return;
    }
    const payload: PipelineProgressEvent = {
      type: event.type === 'entry' ? 'entry-status' : event.type === 'phase' ? 'phase' : (event.type as PipelineProgressEvent['type']),
      phase: event.phase,
      entryIndex: event.entry?.index,
      status: event.entry?.downloadStatus,
      message: event.message ?? event.error?.message
    };
    progressEmitter(payload);
  });
  progressEmitter({ type: 'summary', summary });
  return summary;
});

ipcMain.handle('pipeline:pause', () => {
  runner.pause();
  return runner.getStatus();
});

ipcMain.handle('pipeline:resume', () => {
  runner.resume();
  return runner.getStatus();
});

ipcMain.handle('pipeline:diagnostics', async () => {
  const path = await runner.createDiagnosticsBundle();
  return { path };
});
