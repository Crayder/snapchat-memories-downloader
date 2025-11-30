import path from 'node:path';
import { Readable } from 'node:stream';
import { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import fs from 'fs-extra';
import PQueue from 'p-queue';
import mime from 'mime-types';
import type { MemoryEntry } from '../../shared/types/memory-entry.js';
import { buildOutputName } from '../utils/naming.js';
import { tempPath } from '../utils/files.js';
import { detectMagicType } from '../utils/magic-bytes.js';
import type { StateStore } from './state-store.js';
import type { ProgressCallback } from '../types.js';
import log from '../logger.js';

export interface DownloadServiceOptions {
  downloadDir: string;
  tempDir: string;
  concurrency: number;
  retryLimit: number;
}

export class DownloadService {
  private readonly queue: PQueue;

  constructor(private readonly options: DownloadServiceOptions, private readonly state: StateStore) {
    this.queue = new PQueue({ concurrency: options.concurrency });
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
          entry.downloadStatus = 'failed';
          entry.errors = [...(entry.errors ?? []), (error as Error).message];
          return entry;
        }
      }) as Promise<MemoryEntry>;
      promises.push(job);
    }

    return Promise.all(promises);
  }

  private async processEntry(entry: MemoryEntry, progress: ProgressCallback): Promise<MemoryEntry> {
    const persisted = this.state.get(entry.index);
    if (persisted?.downloadStatus === 'downloaded' && persisted.downloadedPath && (await fs.pathExists(persisted.downloadedPath))) {
      entry.downloadStatus = 'downloaded';
      entry.downloadedPath = persisted.downloadedPath;
      progress({ type: 'entry', entry, message: 'Already downloaded (resume)' });
      return entry;
    }

    for (let attempt = 1; attempt <= this.options.retryLimit; attempt += 1) {
      try {
        progress({ type: 'entry', entry, message: `Downloading (attempt ${attempt})` });
        const finalPath = await this.fetchAndWrite(entry);
        entry.downloadStatus = 'downloaded';
        entry.downloadedPath = finalPath;
        this.state.upsert({ index: entry.index, downloadStatus: 'downloaded', downloadedPath: finalPath, attempts: attempt });
        progress({ type: 'entry', entry, message: 'Downloaded' });
        return entry;
      } catch (error) {
        log.error('Download failed for %s: %s', entry.downloadUrl, (error as Error).message);
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
        if (attempt >= this.options.retryLimit) {
          entry.downloadStatus = 'failed';
          this.state.upsert({ index: entry.index, downloadStatus: 'failed', errors: entry.errors, attempts: attempt });
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }

    return entry;
  }

  private async fetchAndWrite(entry: MemoryEntry): Promise<string> {
    const downloadUrl = await this.resolveUrl(entry);
    const response = await fetch(downloadUrl, {
      method: 'GET',
      headers: {
        'X-Snap-Route-Tag': 'mem-dmd'
      }
    });

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
      return renamed;
    }

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
}
