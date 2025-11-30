import fs from 'fs-extra';
import path from 'node:path';
import { DownloadStatus } from '../../shared/types/memory-entry.js';

export interface EntryStateRecord {
  index: number;
  downloadStatus: DownloadStatus;
  downloadedPath?: string;
  finalPath?: string;
  contentHash?: string;
  errors?: string[];
  attempts?: number;
}

interface PersistedState {
  lastRunAt?: string;
  entries: Record<number, EntryStateRecord>;
}

export class StateStore {
  private readonly statePath: string;
  private readonly legacyStateDir: string;
  private state: PersistedState = { entries: {} };

  constructor(outputDir: string) {
    this.statePath = path.join(outputDir, 'state.json');
    this.legacyStateDir = path.join(outputDir, 'state');
  }

  async load(): Promise<void> {
    await fs.ensureDir(path.dirname(this.statePath));
    if (await fs.pathExists(this.statePath)) {
      this.state = await fs.readJson(this.statePath);
      return;
    }

    const legacyPath = path.join(this.legacyStateDir, 'state.json');
    if (await fs.pathExists(legacyPath)) {
      this.state = await fs.readJson(legacyPath);
      await fs.remove(this.legacyStateDir).catch(() => undefined);
      await fs.writeJson(this.statePath, this.state, { spaces: 2 });
    }
  }

  async save(): Promise<void> {
    await fs.ensureDir(path.dirname(this.statePath));
    this.state.lastRunAt = new Date().toISOString();
    await fs.writeJson(this.statePath, this.state, { spaces: 2 });
  }

  get(index: number): EntryStateRecord | undefined {
    return this.state.entries[index];
  }

  upsert(record: EntryStateRecord): void {
    this.state.entries[record.index] = { ...this.state.entries[record.index], ...record };
  }

  clear(): void {
    this.state = { entries: {} };
  }
}
