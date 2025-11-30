import path from 'node:path';
import fs from 'fs-extra';
import { ensureAppDirectories, getAppPaths } from '../config/app-paths.js';
import { ImportService } from '../services/import-service.js';
import { IndexParser } from '../services/index-parser.js';
import { StateStore } from '../services/state-store.js';
import type { EntryStateRecord } from '../services/state-store.js';
import { DownloadService } from '../services/download-service.js';
import { PostProcessService } from '../services/post-process-service.js';
import { MetadataService } from '../services/metadata-service.js';
import { DedupService } from '../services/dedup-service.js';
import { ReportService } from '../services/report-service.js';
import { VerificationService } from '../services/verification-service.js';
import { DiagnosticsService } from '../services/diagnostics-service.js';
import { InvestigationJournal } from '../services/investigation-journal.js';
import { PipelineControl } from './pipeline-control.js';
import { toFilenameStamp } from '../utils/date.js';
import log from '../logger.js';
import type { PipelineStatsPayload } from '../../shared/types/pipeline-stats.js';
import type { MemoryEntry, PipelineOptions, PipelineRunRequest, PipelineRunSummary } from '../../shared/types/memory-entry.js';
import type { ProgressCallback } from '../types.js';

export class PipelineRunner {
  private readonly parser = new IndexParser();
  private readonly metadataService = new MetadataService();
  private readonly verificationService = new VerificationService();
  private readonly diagnosticsService = new DiagnosticsService();
  private readonly control = new PipelineControl();
  private isRunning = false;
  private lastReportPath?: string;
  private lastOutputDir?: string;

  async run(request: PipelineRunRequest, progress: ProgressCallback): Promise<PipelineRunSummary> {
    if (this.isRunning) {
      throw new Error('Pipeline is already running.');
    }
    this.isRunning = true;
    this.control.reset();
    await ensureAppDirectories();
    const startedAt = new Date();
    const { reportDir } = getAppPaths();
    const importService = new ImportService(path.join(request.outputDir, 'work'));
    const stateStore = new StateStore(request.outputDir);
    await stateStore.load().catch(() => stateStore.clear());
    const investigation = new InvestigationJournal();

    try {
      progress({ type: 'phase', phase: 'import-export' });
      const importResult = await importService.extract(request.exportZipPath);
      if (!importResult.jsonPath) {
        progress({ type: 'log', message: 'memories_history.json missing; falling back to HTML index.' });
      }

      progress({ type: 'phase', phase: 'parse-index' });
      const indexFile = importResult.jsonPath ?? importResult.htmlPath!;
      let entries = await this.parser.parse(indexFile);
      const stateSnapshot = stateStore.snapshot();
      this.restoreEntriesFromState(entries, stateSnapshot);
      if (request.options.retryFailedOnly) {
        const failedIndexes = new Set(
          Object.values(stateSnapshot)
            .filter((record) => record.downloadStatus === 'failed')
            .map((record) => record.index)
        );
        entries = entries.filter((entry) => failedIndexes.has(entry.index));
        if (entries.length === 0) {
          progress({ type: 'log', message: 'No failed entries remain; finishing without rerun.' });
          const finishedAt = new Date();
          const summary = this.buildSummary(entries, startedAt, finishedAt);
          progress({ type: 'phase', phase: 'complete' });
          return summary;
        }
      }
      this.emitStats(entries, 'parsed', progress);

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

      if (request.options.verifyOnly) {
        await this.populateFinalPathsFromDisk(entries, finalDir);
      } else {
        progress({ type: 'phase', phase: 'download' });
        const downloadService = new DownloadService(
          {
            downloadDir,
            tempDir,
            concurrency: request.options.concurrency,
            retryLimit: request.options.retryLimit,
            throttleDelayMs: request.options.throttleDelayMs,
            attemptTimeoutMs: request.options.attemptTimeoutMs
          },
          stateStore,
          this.control,
          investigation
        );
        await downloadService.run(entries, progress);
        this.emitStats(entries, 'download', progress);

        progress({ type: 'phase', phase: 'post-process' });
        const postProcessService = new PostProcessService(
          {
            outputDir: finalDir,
            tempDir,
            keepZipPayloads: request.options.keepZipPayloads
          },
          investigation
        );
        await postProcessService.run(entries, progress, this.control);
        this.emitStats(entries, 'post-process', progress);

        progress({ type: 'phase', phase: 'metadata' });
        await this.metadataService.run(entries, progress, this.control);
        this.emitStats(entries, 'metadata', progress);

        progress({ type: 'phase', phase: 'dedup' });
        const dedupService = new DedupService({ duplicatesDir, strategy: request.options.dedupeStrategy });
        await dedupService.run(entries, progress, this.control);
        this.emitStats(entries, 'dedup', progress);
      }

      progress({ type: 'phase', phase: 'verify' });
      await this.verificationService.run(entries, progress, this.control);
      this.emitStats(entries, 'verify', progress);

      const finishedAt = new Date();
      const summary = this.buildSummary(entries, startedAt, finishedAt);
      const reportService = new ReportService(reportDir);
      const reportPath = await reportService.create(entries, summary);
      summary.reportPath = reportPath;
      await stateStore.save();
      await this.metadataService.dispose();
      await investigation.writeReport(reportDir);
      await this.cleanupOutputArtifacts(request.outputDir, request.options);
      this.lastReportPath = reportPath;
      this.lastOutputDir = request.outputDir;
      progress({ type: 'phase', phase: 'complete' });
      return summary;
    } finally {
      this.control.resume();
      this.isRunning = false;
    }
  }

  private buildSummary(entries: MemoryEntry[], startedAt: Date, finishedAt: Date): PipelineRunSummary {
    const total = entries.length;
    const downloaded = entries.filter((e) => e.downloadStatus === 'downloaded').length;
    const processed = entries.filter((e) => e.downloadStatus === 'processed').length;
    const metadata = entries.filter((e) => e.downloadStatus === 'metadata').length;
    const deduped = entries.filter((e) => e.downloadStatus === 'deduped').length;
    const failures = entries.filter((e) => e.downloadStatus === 'failed').length;
    const reattempts = entries.reduce((sum, entry) => {
      if (!entry.attempts || entry.attempts <= 1) {
        return sum;
      }
      return sum + (entry.attempts - 1);
    }, 0);

    return {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      total,
      downloaded,
      processed,
      metadataWritten: metadata,
      deduped,
      failures,
      reattempts,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      reportPath: ''
    };
  }

  getStatus(): { running: boolean; paused: boolean } {
    return { running: this.isRunning, paused: this.control.paused };
  }

  getLastOutputDir(): string | undefined {
    return this.lastOutputDir;
  }

  pause(): void {
    if (!this.isRunning) {
      return;
    }
    this.control.pause();
  }

  resume(): void {
    this.control.resume();
  }

  async createDiagnosticsBundle(): Promise<string> {
    if (!this.lastOutputDir || !this.lastReportPath) {
      throw new Error('No completed runs yet. Execute the pipeline before exporting diagnostics.');
    }
    const { reportDir, logDir } = getAppPaths();
    return this.diagnosticsService.createBundle({
      destinationDir: reportDir,
      logsDir: logDir,
      reportPath: this.lastReportPath,
      statePath: path.join(this.lastOutputDir, 'state.json')
    });
  }

  private emitStats(entries: MemoryEntry[], stage: string, progress: ProgressCallback): void {
    const payload: PipelineStatsPayload = {
      stage,
      total: entries.length,
      downloaded: entries.filter((e) => e.downloadStatus === 'downloaded').length,
      processed: entries.filter((e) => e.downloadStatus === 'processed').length,
      metadataWritten: entries.filter((e) => e.downloadStatus === 'metadata').length,
      deduped: entries.filter((e) => e.downloadStatus === 'deduped').length,
      failures: entries.filter((e) => e.downloadStatus === 'failed').length,
      images: entries.filter((e) => e.mediaType === 'image').length,
      videos: entries.filter((e) => e.mediaType === 'video').length,
      withGps: entries.filter((e) => e.hasGps).length,
      withoutGps: entries.filter((e) => !e.hasGps).length,
      reattempts: entries.reduce((sum, entry) => {
        if (!entry.attempts || entry.attempts <= 1) {
          return sum;
        }
        return sum + (entry.attempts - 1);
      }, 0)
    };
    progress({ type: 'stats', stats: payload });
  }

  private async populateFinalPathsFromDisk(entries: MemoryEntry[], finalDir: string): Promise<void> {
    if (!(await fs.pathExists(finalDir))) {
      return;
    }
    const files = await fs.readdir(finalDir);
    const map = new Map<string, string>();
    for (const file of files) {
      const full = path.join(finalDir, file);
      const base = path.parse(file).name;
      map.set(base, full);
    }
    for (const entry of entries) {
      const stamp = toFilenameStamp(entry.capturedAtUtc);
      const baseKey = `${stamp}_${entry.mediaType}_${entry.index.toString().padStart(6, '0')}`;
      const existing = map.get(baseKey);
      if (existing) {
        entry.finalPath = existing;
        entry.downloadStatus = 'processed';
      }
    }
  }

  private async cleanupOutputArtifacts(outputDir: string, options: PipelineOptions): Promise<void> {
    const downloadDir = path.join(outputDir, 'downloads');
    const tempDir = path.join(outputDir, '.tmp');
    const workDir = path.join(outputDir, 'work');
    const duplicatesDir = path.join(outputDir, 'duplicates');
    const legacyStateDir = path.join(outputDir, 'state');
    const tasks: Array<Promise<void>> = [];

    tasks.push(this.removeIfExists(tempDir));
    tasks.push(this.removeIfExists(workDir));
    tasks.push(this.removeLegacyStateDir(legacyStateDir));
    tasks.push(this.handleDownloadsCleanup(downloadDir, options.cleanupDownloads));
    tasks.push(this.removeDuplicatesIfEmpty(duplicatesDir));

    await Promise.allSettled(tasks);
  }

  private async removeIfExists(target: string): Promise<void> {
    if (!(await fs.pathExists(target))) {
      return;
    }
    try {
      await fs.remove(target);
    } catch (error) {
      log.warn('Failed to remove %s: %s', target, (error as Error).message);
    }
  }

  private async removeDuplicatesIfEmpty(dir: string): Promise<void> {
    if (!(await fs.pathExists(dir))) {
      return;
    }
    try {
      const contents = await fs.readdir(dir);
      if (contents.length === 0) {
        await fs.remove(dir);
      }
    } catch (error) {
      log.warn('Failed to inspect duplicates directory %s: %s', dir, (error as Error).message);
    }
  }

  private async handleDownloadsCleanup(downloadDir: string, shouldDelete: boolean): Promise<void> {
    if (!(await fs.pathExists(downloadDir))) {
      return;
    }
    try {
      if (shouldDelete) {
        await fs.remove(downloadDir);
        return;
      }
      const contents = await fs.readdir(downloadDir);
      if (contents.length === 0) {
        await fs.remove(downloadDir);
      }
    } catch (error) {
      log.warn('Failed to clean downloads directory %s: %s', downloadDir, (error as Error).message);
    }
  }

  private async removeLegacyStateDir(dir: string): Promise<void> {
    if (!(await fs.pathExists(dir))) {
      return;
    }
    try {
      await fs.remove(dir);
    } catch (error) {
      log.warn('Failed to remove legacy state directory %s: %s', dir, (error as Error).message);
    }
  }

  private restoreEntriesFromState(entries: MemoryEntry[], snapshot: Record<number, EntryStateRecord>): void {
    for (const entry of entries) {
      const stored = snapshot[entry.index];
      if (!stored) {
        continue;
      }
      if (stored.downloadStatus) {
        entry.downloadStatus = stored.downloadStatus;
      }
      if (stored.downloadedPath) {
        entry.downloadedPath = stored.downloadedPath;
      }
      if (stored.finalPath) {
        entry.finalPath = stored.finalPath;
      }
    }
  }
}
