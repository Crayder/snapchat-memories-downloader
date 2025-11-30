import path from 'node:path';
import fs from 'fs-extra';
import type { MemoryEntry, PipelineRunSummary } from '../../shared/types/memory-entry.js';

export class ReportService {
  constructor(private readonly reportDir: string) {}

  async create(entries: MemoryEntry[], summary: PipelineRunSummary): Promise<string> {
    await fs.ensureDir(this.reportDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const jsonPath = path.join(this.reportDir, `run-${timestamp}.json`);
    const csvPath = path.join(this.reportDir, `run-${timestamp}.csv`);

    await fs.writeJson(jsonPath, { summary, entries }, { spaces: 2 });
    await fs.writeFile(csvPath, this.buildCsv(entries));

    return jsonPath;
  }

  private buildCsv(entries: MemoryEntry[]): string {
    const header = ['index', 'capturedAtUtc', 'mediaType', 'status', 'finalPath', 'hasGps', 'latitude', 'longitude', 'downloadUrl', 'errors'];
    const rows = entries.map((entry) => [
      entry.index,
      entry.capturedAtUtc,
      entry.mediaType,
      entry.downloadStatus,
      entry.finalPath ?? '',
      entry.hasGps,
      entry.latitude ?? '',
      entry.longitude ?? '',
      entry.downloadUrl,
      entry.errors?.join(' | ') ?? ''
    ]);
    return [header, ...rows]
      .map((cols) =>
        cols
          .map((value) => {
            if (typeof value === 'string') {
              const escaped = value.replace(/"/g, '""');
              return `"${escaped}"`;
            }
            return value;
          })
          .join(',')
      )
      .join('\n');
  }
}
