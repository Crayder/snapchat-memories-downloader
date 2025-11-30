import path from 'node:path';
import fs from 'fs-extra';
import StreamZip from 'node-stream-zip';
import { v4 as uuid } from 'uuid';
import log from '../logger.js';
import { ensureDir } from '../utils/files.js';

export interface ImportResult {
  extractDir: string;
  jsonPath?: string;
  htmlPath?: string;
}

export class ImportService {
  constructor(private readonly workDir: string) {}

  async extract(zipPath: string): Promise<ImportResult> {
    const extractDir = path.join(this.workDir, `export-${uuid()}`);
    await ensureDir(extractDir);

    const zip = new StreamZip.async({ file: zipPath });
    try {
      const entries = await zip.entries();
      await Promise.all(
        Object.values(entries).map(async (entry) => {
          if (entry.isDirectory) return;
          const entryPath = path.join(extractDir, entry.name);
          await ensureDir(path.dirname(entryPath));
          await zip.extract(entry.name, entryPath);
        })
      );
    } finally {
      await zip.close();
    }

    const jsonPath = await this.findFile(extractDir, 'memories_history.json');
    const htmlPath = await this.findFile(extractDir, 'memories_history.html');

    if (!jsonPath && !htmlPath) {
      throw new Error('Unable to locate memories_history.(json|html) inside export.');
    }

    log.info('Extracted export to %s', extractDir);
    return { extractDir, jsonPath, htmlPath };
  }

  private async findFile(root: string, targetName: string): Promise<string | undefined> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findFile(fullPath, targetName);
        if (nested) return nested;
      } else if (entry.name.toLowerCase() === targetName.toLowerCase()) {
        return fullPath;
      }
    }
    return undefined;
  }
}
