import path from 'node:path';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import fs from 'fs-extra';
import PQueue from 'p-queue';
import mime from 'mime-types';
import type { FailureStage, MemoryEntry } from '../../shared/types/memory-entry.js';
import { buildOutputName } from '../utils/naming.js';
import { tempPath } from '../utils/files.js';
import { detectMagicType } from '../utils/magic-bytes.js';
import type { StateStore } from './state-store.js';
import type { ProgressCallback } from '../types.js';
import log from '../logger.js';
import type { PauseSignal } from '../pipeline/pipeline-control.js';
import type { InvestigationJournal } from './investigation-journal.js';

export interface DownloadServiceOptions {
  downloadDir: string;
  tempDir: string;
  concurrency: number;
  retryLimit: number;
  throttleDelayMs: number;
  attemptTimeoutMs: number;
}

export class DownloadService {
  private readonly queue: PQueue;
  private readonly unsubscribeControl?: () => void;

  constructor(
    private readonly options: DownloadServiceOptions,
    private readonly state: StateStore,
    private readonly control?: PauseSignal,
    private readonly investigation?: InvestigationJournal
  ) {
    this.queue = new PQueue({ concurrency: options.concurrency });
    if (this.control) {
      this.unsubscribeControl = this.control.onChange(({ paused }) => {
        if (paused) {
          this.queue.pause();
        } else {
          this.queue.start();
        }
      });
      if (this.control.paused) {
        this.queue.pause();
      }
    }
  }

  async run(entries: MemoryEntry[], progress: ProgressCallback): Promise<MemoryEntry[]> {
    await fs.ensureDir(this.options.downloadDir);
    await fs.ensureDir(this.options.tempDir);

    const promises: Array<Promise<MemoryEntry>> = [];

    for (const entry of entries) {
      const job = this.queue.add(async () => {
        try {
          return await this.processEntry(entry, progress);
        } catch (error) {
          progress({ type: 'error', entry, error: error as Error });
          this.markFailure(entry, 'download', (error as Error).message);
          return entry;
        }
      }) as Promise<MemoryEntry>;
      promises.push(job);
    }

    const results = await Promise.all(promises);
    this.unsubscribeControl?.();
    return results;
  }

  private async processEntry(entry: MemoryEntry, progress: ProgressCallback): Promise<MemoryEntry> {
    await this.control?.waitIfPaused();
    const persisted = this.state.get(entry.index);
    if (persisted?.downloadStatus === 'downloaded' && persisted.downloadedPath && (await fs.pathExists(persisted.downloadedPath))) {
      entry.downloadStatus = 'downloaded';
      entry.downloadedPath = persisted.downloadedPath;
      entry.attempts = persisted.attempts;
      progress({ type: 'entry', entry, message: 'Already downloaded (resume)' });
      return entry;
    }

    for (let attempt = 1; attempt <= this.options.retryLimit; attempt += 1) {
      try {
        progress({ type: 'entry', entry, message: `Downloading (attempt ${attempt})` });
        const finalPath = await this.fetchAndWrite(entry);
        entry.downloadStatus = 'downloaded';
        entry.downloadedPath = finalPath;
        entry.attempts = attempt;
        this.state.upsert({ index: entry.index, downloadStatus: 'downloaded', downloadedPath: finalPath, attempts: attempt });
        progress({ type: 'entry', entry, message: 'Downloaded' });
        if (this.options.throttleDelayMs > 0) {
          await this.delay(this.options.throttleDelayMs);
        }
        return entry;
      } catch (error) {
        log.error('Download failed for %s: %s', entry.downloadUrl, (error as Error).message);
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
        if (attempt >= this.options.retryLimit) {
          entry.downloadStatus = 'failed';
          entry.attempts = attempt;
          this.markFailure(entry, 'download');
          this.state.upsert({
            index: entry.index,
            downloadStatus: 'failed',
            errors: entry.errors,
            attempts: attempt,
            failureStage: entry.failureStage
          });
          throw error;
        }
        const delay = Math.min(2000 * 2 ** (attempt - 1), 30000);
        await this.delay(delay);
        await this.control?.waitIfPaused();
      }
    }

    return entry;
  }

  private async fetchAndWrite(entry: MemoryEntry): Promise<string> {
    const downloadUrl = await this.resolveUrl(entry);
    const controller = new AbortController();
    const timeout = Number.isFinite(this.options.attemptTimeoutMs) && this.options.attemptTimeoutMs > 0
      ? setTimeout(() => controller.abort(), this.options.attemptTimeoutMs)
      : null;
    let response: Response;
    try {
      response = await fetch(downloadUrl, {
        method: 'GET',
        headers: {
          'X-Snap-Route-Tag': 'mem-dmd'
        },
        signal: controller.signal
      });
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    if (!response.ok || !response.body) {
      throw new Error(`Unexpected response status ${response.status}`);
    }

    const filenameBase = buildOutputName(entry.capturedAtUtc, entry.mediaType, entry.index, '.bin');
    const tempFile = tempPath(this.options.tempDir, path.parse(filenameBase).name);
    const writable = fs.createWriteStream(tempFile);
    const readable = Readable.fromWeb(response.body as ReadableStream);
    await pipeline(readable, writable);

    const resolvedExt = await this.determineExtension(
      response.headers.get('content-disposition'),
      response.headers.get('content-type'),
      tempFile,
      entry.mediaType
    );
    const finalName = buildOutputName(entry.capturedAtUtc, entry.mediaType, entry.index, resolvedExt);
    const finalPath = path.join(this.options.downloadDir, finalName);
    await fs.move(tempFile, finalPath, { overwrite: true });

    const magic = await detectMagicType(finalPath);
    entry.isZipPayload = magic === 'zip';
    if (magic === 'zip' && !finalPath.endsWith('.zip')) {
      const renamed = `${finalPath}.zip`;
      await fs.move(finalPath, renamed, { overwrite: true });
      this.investigation?.recordDownload({
        index: entry.index,
        method: 'GET',
        url: downloadUrl,
        contentType: response.headers.get('content-type'),
        disposition: response.headers.get('content-disposition'),
        status: response.status,
        inferredExt: '.zip'
      });
      return renamed;
    }

    this.investigation?.recordDownload({
      index: entry.index,
      method: entry.downloadMethodHint === 'POST' ? 'POST' : 'GET',
      url: downloadUrl,
      contentType: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      status: response.status,
      inferredExt: resolvedExt
    });

    return finalPath;
  }

  private async resolveUrl(entry: MemoryEntry): Promise<string> {
    if (entry.downloadMethodHint === 'POST') {
      return this.proxyPost(entry.downloadUrl);
    }
    return entry.downloadUrl;
  }

  private async proxyPost(url: string): Promise<string> {
    const [base, query] = url.split('?');
    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: query ?? ''
    });
    if (!response.ok) {
      throw new Error(`POST proxy failed with status ${response.status}`);
    }
    const text = await response.text();
    return text.trim();
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async determineExtension(disposition: string | null, contentType: string | null, filePath: string, mediaType: string): Promise<string> {
    if (disposition) {
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/i) ?? disposition.match(/filename="?([^";]+)"?/i);
      if (match) {
        const ext = path.extname(match[1]);
        if (ext) {
          return ext;
        }
      }
    }

    if (contentType) {
      const ext = mime.extension(contentType);
      if (ext) {
        return `.${ext}`;
      }
    }

    const magic = await detectMagicType(filePath);
    switch (magic) {
      case 'jpg':
        return '.jpg';
      case 'png':
        return '.png';
      case 'mp4':
        return '.mp4';
      case 'mov':
        return '.mov';
      case 'zip':
        return '.zip';
      default:
        return mediaType === 'video' ? '.mp4' : '.jpg';
    }
  }

  private markFailure(entry: MemoryEntry, stage: FailureStage, message?: string): void {
    entry.downloadStatus = 'failed';
    entry.failureStage = stage;
    if (message) {
      entry.errors = [...(entry.errors ?? []), message];
    }
  }
}
