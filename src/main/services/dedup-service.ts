import path from 'node:path';
import fs from 'fs-extra';
import type { MemoryEntry } from '../../shared/types/memory-entry.js';
import { streamHash } from '../utils/files.js';
import type { ProgressCallback } from '../types.js';

export interface DedupOptions {
  duplicatesDir: string;
  strategy: 'move' | 'delete' | 'none';
}

export class DedupService {
  constructor(private readonly options: DedupOptions) {}

  async run(entries: MemoryEntry[], progress: ProgressCallback): Promise<void> {
    await fs.ensureDir(this.options.duplicatesDir);
    const urlMap = new Map<string, MemoryEntry>();
    const hashMap = new Map<string, MemoryEntry>();

    for (const entry of entries) {
      if (!entry.finalPath || entry.downloadStatus === 'failed') {
        continue;
      }

      const urlKey = entry.downloadUrl;
      if (urlMap.has(urlKey)) {
        await this.handleDuplicate(entry, progress, `Duplicate download URL: ${urlKey}`);
        continue;
      }
      urlMap.set(urlKey, entry);

      const hash = await streamHash(entry.finalPath);
      entry.contentHash = hash;
      if (hashMap.has(hash)) {
        await this.handleDuplicate(entry, progress, 'Matching content hash');
        continue;
      }
      hashMap.set(hash, entry);
      entry.downloadStatus = entry.downloadStatus === 'metadata' ? 'deduped' : entry.downloadStatus;
    }
  }

  private async handleDuplicate(entry: MemoryEntry, progress: ProgressCallback, reason: string): Promise<void> {
    progress({ type: 'log', entry, message: `Duplicate detected: ${reason}` });
    entry.downloadStatus = 'deduped';
    if (this.options.strategy === 'none') {
      return;
    }
    if (this.options.strategy === 'delete') {
      await fs.remove(entry.finalPath!);
      return;
    }
    const target = path.join(this.options.duplicatesDir, path.basename(entry.finalPath!));
    await fs.move(entry.finalPath!, target, { overwrite: true });
    entry.finalPath = target;
  }
}
