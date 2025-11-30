import path from 'node:path';
import fs from 'fs-extra';
import archiver from 'archiver';

export interface DiagnosticsRequest {
  destinationDir: string;
  logsDir: string;
  reportPath?: string;
  statePath?: string;
  extraFiles?: string[];
}

export class DiagnosticsService {
  async createBundle(request: DiagnosticsRequest): Promise<string> {
    await fs.ensureDir(request.destinationDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(request.destinationDir, `diagnostics-${timestamp}.zip`);
    await this.writeArchive(archivePath, request);
    return archivePath;
  }

  private async writeArchive(archivePath: string, request: DiagnosticsRequest): Promise<void> {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const finalizePromise = new Promise<void>((resolve, reject) => {
      output.on('close', () => resolve());
      archive.on('error', (error: Error) => reject(error));
    });
    archive.pipe(output);

    if (request.reportPath && (await fs.pathExists(request.reportPath))) {
      archive.file(request.reportPath, { name: path.basename(request.reportPath) });
    }

    if (request.statePath && (await fs.pathExists(request.statePath))) {
      archive.file(request.statePath, { name: 'state.json' });
    }

    if (await fs.pathExists(request.logsDir)) {
      archive.directory(request.logsDir, 'logs');
    }

    for (const extraFile of request.extraFiles ?? []) {
      if (await fs.pathExists(extraFile)) {
        archive.file(extraFile, { name: path.basename(extraFile) });
      }
    }

    await archive.finalize();
    await finalizePromise;
  }
}
