import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import StreamZip from 'node-stream-zip';
import type { FailureStage, MemoryEntry, MemoryMediaType } from '../../shared/types/memory-entry.js';
import { buildOutputName } from '../utils/naming.js';
import { detectMagicType } from '../utils/magic-bytes.js';
import type { ProgressCallback } from '../types.js';
import type { PauseSignal } from '../pipeline/pipeline-control.js';
import type { InvestigationJournal } from './investigation-journal.js';
import log from '../logger.js';

const resolvePackedBinary = (label: string, absolutePath: string | null): string | null => {
  if (!absolutePath) {
    log.warn('%s binary not provided by static dependency; falling back to PATH.', label);
    return null;
  }
  const candidate = absolutePath.replace('app.asar', 'app.asar.unpacked');
  if (!fs.existsSync(candidate)) {
    log.warn('%s binary missing at %s. Ensure it is unpacked for packaged builds.', label, candidate);
    return null;
  }
  return candidate;
};

const resolvedFfmpegBinary = (typeof ffmpegStatic === 'string' ? ffmpegStatic : null) as string | null;
const unpackedFfmpeg = resolvePackedBinary('ffmpeg', resolvedFfmpegBinary);
if (unpackedFfmpeg) {
  ffmpeg.setFfmpegPath(unpackedFfmpeg);
}
const unpackedFfprobe = resolvePackedBinary('ffprobe', ffprobe?.path ?? null);
if (unpackedFfprobe) {
  ffmpeg.setFfprobePath(unpackedFfprobe);
}

export interface PostProcessOptions {
  outputDir: string;
  tempDir: string;
}

const VIDEO_EXTS = ['.mp4', '.mov', '.m4v'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp'];

interface VideoStreamInfo {
  width: number;
  height: number;
  codecName?: string;
  bitRate?: number;
  frameRate?: string;
  pixFmt?: string;
  profile?: string;
  level?: number;
}

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
        this.recordFailure(entry, 'post-process', error as Error);
        progress({ type: 'error', entry, error: error as Error });
        log.error('Post-process failed for #%d (%s): %s', entry.index, entry.downloadedPath ?? 'unknown', (error as Error).stack ?? (error as Error).message);
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

    let failure: Error | null = null;
    try {
      const files = await this.listFiles(extractDir);
      if (!files.length) {
        throw new Error('Caption ZIP did not contain any files.');
      }
      const base = await this.pickBaseFile(files, entry.mediaType);
      const overlays = files.filter((file) => path.extname(file).toLowerCase() === '.png' && file !== base);
      const usableOverlays = await this.filterUsableOverlays(overlays, entry);

      this.investigation?.recordZipPayload({
        index: entry.index,
        fileCount: files.length,
        overlayCount: usableOverlays.length,
        extensions: this.countExtensions(files)
      });

      if (!base) {
        throw new Error('Unable to identify base media within caption ZIP.');
      }

      const baseExt = path.extname(base).toLowerCase();
      const inferredType = this.inferMediaTypeFromExt(baseExt);
      const targetMediaType: MemoryMediaType = (inferredType ?? entry.mediaType ?? 'image');
      entry.mediaType = targetMediaType;

      if (targetMediaType === 'video') {
        const videoInfo = await this.getVideoMetadata(base);
        const overlayAsset = usableOverlays.length
          ? await this.mergeOverlays(usableOverlays, { width: videoInfo.width, height: videoInfo.height })
          : undefined;
        await this.overlayVideo(base, overlayAsset, entry, targetMediaType, videoInfo);
      } else {
        await this.composeImage(base, usableOverlays, entry, targetMediaType);
      }

    } catch (error) {
      failure = error as Error;
      await this.captureZipFailure(entry, extractDir, failure);
      throw error;
    } finally {
      await this.safeRemoveDir(extractDir, `zip-${entry.index}${failure ? '-failed' : ''}`);
    }
  }

  private async composeImage(basePath: string, overlays: string[], entry: MemoryEntry, mediaType: MemoryMediaType = 'image'): Promise<void> {
    const baseImage = sharp(basePath);
    const metadata = await baseImage.metadata();
    let pipeline = baseImage;
    if (overlays.length) {
      const comps = await Promise.all(
        overlays.map(async (overlay) => ({
          input: await this.normalizeOverlay(overlay, metadata.width, metadata.height),
          left: 0,
          top: 0
        }))
      );
      pipeline = pipeline.composite(comps);
    }
    const finalName = buildOutputName(entry.capturedAtUtc, mediaType === 'video' ? 'video' : 'image', entry.index, path.extname(basePath) || '.jpg');
    const finalPath = path.join(this.options.outputDir, finalName);
    await pipeline.toFile(finalPath);
    entry.finalPath = finalPath;
  }

  private async overlayVideo(
    basePath: string,
    overlayPath: string | undefined,
    entry: MemoryEntry,
    mediaType: MemoryMediaType = 'video',
    videoInfo?: VideoStreamInfo
  ): Promise<void> {
    const finalName = buildOutputName(entry.capturedAtUtc, mediaType === 'image' ? 'image' : 'video', entry.index, path.extname(basePath) || '.mp4');
    const finalPath = path.join(this.options.outputDir, finalName);

    if (!overlayPath) {
      await fs.copy(basePath, finalPath, { overwrite: true });
      entry.finalPath = finalPath;
      return;
    }

    const encodingOptions = this.buildVideoEncodingOptions(videoInfo);
    await new Promise<void>((resolve, reject) => {
      ffmpeg(basePath)
        .input(overlayPath)
        .complexFilter(['[0:v][1:v]overlay=0:0:format=auto[vout]'])
        .outputOptions(encodingOptions)
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
    const composites = await Promise.all(
      paths.map(async (overlay) => ({
        input: await this.normalizeOverlay(overlay, dimensions.width, dimensions.height),
        left: 0,
        top: 0
      }))
    );
    const tempFile = path.join(this.options.tempDir, `overlay-${Date.now()}.png`);
    await canvas.composite(composites).png().toFile(tempFile);
    return tempFile;
  }

  private async getVideoMetadata(videoPath: string): Promise<VideoStreamInfo> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (error: Error | null, metadata: FfprobeData) => {
        if (error) {
          log.error('ffprobe failed for %s: %s', videoPath, error.message);
          reject(error);
          return;
        }
        const stream = metadata.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
        if (!stream?.width || !stream?.height) {
          reject(new Error('Unable to read video dimensions.'));
          return;
        }
        const bitRate = Number(stream.bit_rate ?? metadata.format?.bit_rate ?? 0) || undefined;
        const fps = this.parseFrameRate(stream.avg_frame_rate);
        const rawProfile = stream.profile as string | number | undefined;
        const normalizedProfile = typeof rawProfile === 'number' ? rawProfile.toString() : rawProfile;
        const rawLevel = stream.level as number | string | undefined;
        const parsedLevel = typeof rawLevel === 'string' ? Number(rawLevel) : rawLevel;
        const normalizedLevel = typeof parsedLevel === 'number' && Number.isFinite(parsedLevel) ? parsedLevel : undefined;
        resolve({
          width: stream.width,
          height: stream.height,
          codecName: stream.codec_name ?? undefined,
          bitRate,
          frameRate: fps,
          pixFmt: stream.pix_fmt ?? undefined,
          profile: normalizedProfile ?? undefined,
          level: normalizedLevel
        });
      });
    });
  }

  private buildVideoEncodingOptions(info?: VideoStreamInfo): string[] {
    const codec = (info?.codecName ?? 'h264').toLowerCase();
    const encoder = codec.includes('265') || codec.includes('hevc') ? 'libx265' : 'libx264';
    const options = ['-map', '[vout]', '-map', '0:a?', '-c:a', 'copy', '-c:v', encoder];

    if (info?.bitRate) {
      const kbps = Math.max(1, Math.round(info.bitRate / 1000));
      options.push('-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${Math.max(kbps * 2, 1000)}k`);
    } else {
      options.push('-crf', '18');
    }

    if (info?.frameRate) {
      options.push('-r', info.frameRate);
    }

    const pixFmt = this.normalizePixelFormat(info?.pixFmt);
    options.push('-pix_fmt', pixFmt);

    if (encoder === 'libx264') {
      const profile = this.normalizeProfile(info?.profile);
      if (profile) {
        options.push('-profile:v', profile);
      }
      const level = this.normalizeLevel(info?.level);
      if (level) {
        options.push('-level', level);
      }
    }

    options.push('-preset', 'medium', '-movflags', '+faststart');
    return options;
  }

  private normalizePixelFormat(pixFmt?: string): string {
    if (!pixFmt) {
      return 'yuv420p';
    }
    if (pixFmt === 'yuvj420p') {
      return 'yuv420p';
    }
    if (!pixFmt.startsWith('yuv')) {
      return 'yuv420p';
    }
    return pixFmt;
  }

  private normalizeProfile(profile?: string): string | undefined {
    if (!profile) {
      return undefined;
    }
    return profile.toLowerCase().replace(/\s+/g, '-');
  }

  private normalizeLevel(level?: number): string | undefined {
    if (!level) {
      return undefined;
    }
    if (level >= 10) {
      return (level / 10).toFixed(1);
    }
    return level.toFixed(1);
  }

  private parseFrameRate(rate?: string): string | undefined {
    if (!rate || rate === '0/0') {
      return undefined;
    }
    if (!rate.includes('/')) {
      return rate;
    }
    const [num, den] = rate.split('/').map((value) => Number(value));
    if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
      return undefined;
    }
    return (num / den).toFixed(3);
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

  private inferMediaTypeFromExt(ext: string): MemoryMediaType | undefined {
    if (VIDEO_EXTS.includes(ext)) {
      return 'video';
    }
    if (IMAGE_EXTS.includes(ext)) {
      return 'image';
    }
    return undefined;
  }

  private async normalizeOverlay(overlayPath: string, targetWidth?: number, targetHeight?: number): Promise<Buffer | string> {
    if (!targetWidth && !targetHeight) {
      return overlayPath;
    }
    const meta = await sharp(overlayPath).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (targetWidth && targetHeight && width === targetWidth && height === targetHeight) {
      return overlayPath;
    }
    return sharp(overlayPath)
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: 'inside',
        withoutEnlargement: false
      })
      .png()
      .toBuffer();
  }

  private async safeRemoveDir(dir: string, context?: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt === 2) {
          log.warn('Failed to remove temp directory %s (%s): %s', dir, context ?? 'cleanup', (error as Error).message);
          return;
        }
        await this.delay(200 * (attempt + 1));
      }
    }
  }

  private async captureZipFailure(entry: MemoryEntry, extractDir: string, error: Error): Promise<void> {
    try {
      if (!(await fs.pathExists(extractDir))) {
        return;
      }
      const failureDir = path.join(this.options.outputDir, '_zip_failures');
      await fs.ensureDir(failureDir);
      const target = path.join(failureDir, `entry-${entry.index}-${Date.now()}`);
      await fs.copy(extractDir, target, { overwrite: true });
      await fs.writeJson(path.join(target, '_failure.json'), {
        index: entry.index,
        downloadedPath: entry.downloadedPath,
        mediaType: entry.mediaType,
        error: error.message,
        capturedAt: new Date().toISOString()
      });
      log.warn('ZIP failure artifacts persisted to %s for entry #%d', target, entry.index);
    } catch (captureError) {
      log.warn('Unable to capture ZIP failure artifacts for #%d: %s', entry.index, (captureError as Error).message);
    }
  }

  private recordFailure(entry: MemoryEntry, stage: FailureStage, error: Error): void {
    entry.downloadStatus = 'failed';
    entry.failureStage = stage;
    entry.errors = [...(entry.errors ?? []), error.message];
  }

  private async filterUsableOverlays(paths: string[], entry: MemoryEntry): Promise<string[]> {
    const usable: string[] = [];
    for (const overlay of paths) {
      try {
        const stats = await fs.stat(overlay);
        if (stats.size === 0) {
          throw new Error('overlay file is empty');
        }
        await sharp(overlay).metadata();
        usable.push(overlay);
      } catch (error) {
        const reason = (error as Error).message;
        log.warn('Discarding caption overlay %s for entry #%d: %s', path.basename(overlay), entry.index, reason);
        entry.errors = [...(entry.errors ?? []), `Caption overlay ignored (${path.basename(overlay)}): ${reason}`];
      }
    }
    return usable;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
