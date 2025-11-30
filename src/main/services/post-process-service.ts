import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import StreamZip from 'node-stream-zip';
import type { MemoryEntry } from '../../shared/types/memory-entry.js';
import { buildOutputName } from '../utils/naming.js';
import { detectMagicType } from '../utils/magic-bytes.js';
import type { ProgressCallback } from '../types.js';
import type { PauseSignal } from '../pipeline/pipeline-control.js';
import type { InvestigationJournal } from './investigation-journal.js';

const resolvedFfmpegBinary = typeof ffmpegStatic === 'string' ? ffmpegStatic : null;
if (resolvedFfmpegBinary) {
  ffmpeg.setFfmpegPath(resolvedFfmpegBinary);
}
if (ffprobe && ffprobe.path) {
  ffmpeg.setFfprobePath(ffprobe.path);
}

export interface PostProcessOptions {
  outputDir: string;
  tempDir: string;
  keepZipPayloads: boolean;
}

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.heic'];

export class PostProcessService {
  constructor(private readonly options: PostProcessOptions, private readonly investigation?: InvestigationJournal) {}

  async run(entries: MemoryEntry[], progress: ProgressCallback, control?: PauseSignal): Promise<MemoryEntry[]> {
    await fs.ensureDir(this.options.outputDir);
    await fs.ensureDir(this.options.tempDir);
    for (const entry of entries) {
      await control?.waitIfPaused();
      if (entry.downloadStatus !== 'downloaded' || !entry.downloadedPath) {
        continue;
      }
      try {
        progress({ type: 'entry', entry, message: 'Post-processing' });
        if (entry.isZipPayload || path.extname(entry.downloadedPath).toLowerCase() === '.zip') {
          await this.handleZipPayload(entry);
        } else {
          await this.copyAndFix(entry);
        }
        entry.downloadStatus = 'processed';
      } catch (error) {
        entry.downloadStatus = 'failed';
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
        progress({ type: 'error', entry, error: error as Error });
      }
    }
    return entries;
  }

  private async copyAndFix(entry: MemoryEntry): Promise<void> {
    const magic = await detectMagicType(entry.downloadedPath!);
    let desiredExt = this.extFromMagic(magic, entry.mediaType);
    if (!desiredExt) {
      desiredExt = entry.mediaType === 'video' ? '.mp4' : '.jpg';
    }
    const finalName = buildOutputName(entry.capturedAtUtc, entry.mediaType, entry.index, desiredExt);
    const finalPath = path.join(this.options.outputDir, finalName);
    await fs.copy(entry.downloadedPath!, finalPath, { overwrite: true });
    entry.finalPath = finalPath;
  }

  private async handleZipPayload(entry: MemoryEntry): Promise<void> {
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-zip-'));
    const zip = new StreamZip.async({ file: entry.downloadedPath! });
    try {
      await zip.extract(null, extractDir);
    } finally {
      await zip.close();
    }
    const files = await this.listFiles(extractDir);
    if (!files.length) {
      throw new Error('Caption ZIP did not contain any files.');
    }
    const base = await this.pickBaseFile(files, entry.mediaType);
    const overlays = files.filter((file) => path.extname(file).toLowerCase() === '.png' && file !== base);

    this.investigation?.recordZipPayload({
      index: entry.index,
      fileCount: files.length,
      overlayCount: overlays.length,
      extensions: this.countExtensions(files)
    });

    if (!base) {
      throw new Error('Unable to identify base media within caption ZIP.');
    }

    if (entry.mediaType === 'video' && VIDEO_EXTS.includes(path.extname(base).toLowerCase())) {
      const overlayAsset = overlays.length ? await this.mergeOverlays(overlays, await this.getVideoDimensions(base)) : undefined;
      await this.overlayVideo(base, overlayAsset, entry);
    } else {
      await this.composeImage(base, overlays, entry);
    }

    if (!this.options.keepZipPayloads) {
      await fs.remove(entry.downloadedPath!);
    }
    await fs.remove(extractDir);
  }

  private async composeImage(basePath: string, overlays: string[], entry: MemoryEntry): Promise<void> {
    let pipeline = sharp(basePath);
    if (overlays.length) {
      const comps = overlays.map((overlay) => ({ input: overlay, left: 0, top: 0 }));
      pipeline = pipeline.composite(comps);
    }
    const finalName = buildOutputName(entry.capturedAtUtc, 'image', entry.index, path.extname(basePath) || '.jpg');
    const finalPath = path.join(this.options.outputDir, finalName);
    await pipeline.toFile(finalPath);
    entry.finalPath = finalPath;
  }

  private async overlayVideo(basePath: string, overlayPath: string | undefined, entry: MemoryEntry): Promise<void> {
    const finalName = buildOutputName(entry.capturedAtUtc, 'video', entry.index, path.extname(basePath) || '.mp4');
    const finalPath = path.join(this.options.outputDir, finalName);

    if (!overlayPath) {
      await fs.copy(basePath, finalPath, { overwrite: true });
      entry.finalPath = finalPath;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      ffmpeg(basePath)
        .input(overlayPath)
        .complexFilter(['[0:v][1:v]overlay=0:0:format=auto[vout]'])
        .outputOptions(['-map', '[vout]', '-map', '0:a?', '-c:a', 'copy', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart'])
        .save(finalPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err));
    });

    entry.finalPath = finalPath;
  }

  private async mergeOverlays(paths: string[], dimensions: { width: number; height: number }): Promise<string> {
    const canvas = sharp({
      create: {
        width: dimensions.width,
        height: dimensions.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });
    const composites = paths.map((overlay) => ({ input: overlay, left: 0, top: 0 }));
    const tempFile = path.join(this.options.tempDir, `overlay-${Date.now()}.png`);
    await canvas.composite(composites).png().toFile(tempFile);
    return tempFile;
  }

  private async getVideoDimensions(videoPath: string): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (error: Error | null, metadata: FfprobeData) => {
        if (error) {
          reject(error);
          return;
        }
        const stream = metadata.streams?.find((s) => s.width && s.height);
        if (!stream?.width || !stream?.height) {
          reject(new Error('Unable to read video dimensions.'));
          return;
        }
        resolve({ width: stream.width, height: stream.height });
      });
    });
  }

  private async listFiles(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.listFiles(fullPath)));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  private async pickBaseFile(files: string[], mediaType: string): Promise<string> {
    const candidates = files.filter((file) => {
      const ext = path.extname(file).toLowerCase();
      if (mediaType === 'video') {
        return VIDEO_EXTS.includes(ext);
      }
      return IMAGE_EXTS.includes(ext) && ext !== '.png';
    });

    if (candidates.length) {
      return candidates[0];
    }

    let largest = files[0];
    let size = 0;
    for (const file of files) {
      const stats = await fs.stat(file);
      if (stats.size > size) {
        size = stats.size;
        largest = file;
      }
    }
    return largest;
  }

  private extFromMagic(magic: string, mediaType: string): string | undefined {
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

  private countExtensions(files: string[]): Record<string, number> {
    return files.reduce<Record<string, number>>((acc, file) => {
      const ext = path.extname(file).toLowerCase() || 'unknown';
      acc[ext] = (acc[ext] ?? 0) + 1;
      return acc;
    }, {});
  }
}
