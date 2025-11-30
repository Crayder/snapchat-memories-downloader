import path from 'node:path';
import fs from 'fs-extra';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths.js';
import { ImportService } from '../services/import-service.js';
import { IndexParser } from '../services/index-parser.js';
import { StateStore } from '../services/state-store.js';
import { DownloadService } from '../services/download-service.js';
import { PostProcessService } from '../services/post-process-service.js';
import { MetadataService } from '../services/metadata-service.js';
import { DedupService } from '../services/dedup-service.js';
import { ReportService } from '../services/report-service.js';
import type { MemoryEntry, PipelineRunRequest, PipelineRunSummary } from '../../shared/types/memory-entry.js';
import type { ProgressCallback } from '../types.js';

export class PipelineRunner {
  private readonly parser = new IndexParser();
  private readonly metadataService = new MetadataService();

  async run(request: PipelineRunRequest, progress: ProgressCallback): Promise<PipelineRunSummary> {
    await ensureAppDirectories();
    const startedAt = new Date();
    const { reportDir } = getAppPaths();
    const importService = new ImportService(path.join(request.outputDir, 'work'));
    const stateStore = new StateStore(path.join(request.outputDir, 'state'));
    await stateStore.load().catch(() => stateStore.clear());

    progress({ type: 'phase', phase: 'import-export' });
    const importResult = await importService.extract(request.exportZipPath);

    progress({ type: 'phase', phase: 'parse-index' });
    const indexFile = importResult.jsonPath ?? importResult.htmlPath!;
    const entries = await this.parser.parse(indexFile);

    if (request.options.dryRun) {
      const summary = this.buildSummary(entries, startedAt, new Date());
      return summary;
    }

    const downloadDir = path.join(request.outputDir, 'downloads');
    const finalDir = path.join(request.outputDir, 'memories');
    const tempDir = path.join(request.outputDir, '.tmp');
    const duplicatesDir = path.join(request.outputDir, 'duplicates');
    await fs.ensureDir(downloadDir);
    await fs.ensureDir(finalDir);
    await fs.ensureDir(tempDir);

    if (!request.options.verifyOnly) {
      progress({ type: 'phase', phase: 'download' });
      const downloadService = new DownloadService(
        {
          downloadDir,
          tempDir,
          concurrency: request.options.concurrency,
          retryLimit: request.options.retryLimit
        },
        stateStore
      );
      await downloadService.run(entries, progress);

      progress({ type: 'phase', phase: 'post-process' });
      const postProcessService = new PostProcessService({
        outputDir: finalDir,
        tempDir,
        keepZipPayloads: request.options.keepZipPayloads
      });
      await postProcessService.run(entries, progress);

      progress({ type: 'phase', phase: 'metadata' });
      await this.metadataService.run(entries, progress);

      progress({ type: 'phase', phase: 'dedup' });
      const dedupService = new DedupService({ duplicatesDir, strategy: request.options.dedupeStrategy });
      await dedupService.run(entries, progress);
    } else {
      progress({ type: 'phase', phase: 'verify' });
      for (const entry of entries) {
        if (entry.finalPath && (await fs.pathExists(entry.finalPath))) {
          continue;
        }
        entry.downloadStatus = 'failed';
        entry.errors = [...(entry.errors ?? []), 'Missing final output during verify'];
      }
    }

    const finishedAt = new Date();
    const summary = this.buildSummary(entries, startedAt, finishedAt);
    const reportService = new ReportService(reportDir);
    const reportPath = await reportService.create(entries, summary);
    summary.reportPath = reportPath;
    await stateStore.save();
    await this.metadataService.dispose();
    progress({ type: 'phase', phase: 'complete' });
    return summary;
  }

  private buildSummary(entries: MemoryEntry[], startedAt: Date, finishedAt: Date): PipelineRunSummary {
    const total = entries.length;
    const downloaded = entries.filter((e) => e.downloadStatus === 'downloaded').length;
    const processed = entries.filter((e) => e.downloadStatus === 'processed').length;
    const metadata = entries.filter((e) => e.downloadStatus === 'metadata').length;
    const deduped = entries.filter((e) => e.downloadStatus === 'deduped').length;
    const failures = entries.filter((e) => e.downloadStatus === 'failed').length;

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      total,
      downloaded,
      processed,
      metadataWritten: metadata,
      deduped,
      failures,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      reportPath: ''
    };
  }
}
