import fs from 'fs-extra';
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import ffprobe from 'ffprobe-static';
import type { MemoryEntry } from '../../shared/types/memory-entry.js';
import type { ProgressCallback } from '../types.js';
import type { PauseSignal } from '../pipeline/pipeline-control.js';
import { detectMagicType } from '../utils/magic-bytes.js';
import { streamHash } from '../utils/files.js';
import log from '../logger.js';

if (ffprobe && ffprobe.path) {
  const unpackedProbe = ffprobe.path.replace('app.asar', 'app.asar.unpacked');
  ffmpeg.setFfprobePath(unpackedProbe);
}

export class VerificationService {
  async run(entries: MemoryEntry[], progress: ProgressCallback, control?: PauseSignal): Promise<void> {
    for (const entry of entries) {
      await control?.waitIfPaused();
      if (!entry.finalPath || entry.downloadStatus === 'failed') {
        continue;
      }
      progress({ type: 'entry', entry, message: 'Verifying output' });
      try {
        await this.ensureFileIntegrity(entry);
      } catch (error) {
        entry.downloadStatus = 'failed';
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
        entry.failureStage = 'verification';
        log.error('Verification failed for %s: %s', entry.finalPath ?? 'unknown', (error as Error).message);
        progress({ type: 'error', entry, error: error as Error });
      }
    }
  }

  private async ensureFileIntegrity(entry: MemoryEntry): Promise<void> {
    if (!(await fs.pathExists(entry.finalPath!))) {
      throw new Error('Final output missing on disk.');
    }
    const stats = await fs.stat(entry.finalPath!);
    if (stats.size === 0) {
      throw new Error('Final output is empty.');
    }

    const magic = await detectMagicType(entry.finalPath!);
    if (entry.mediaType === 'video' && magic === 'jpg') {
      throw new Error('Expected video but detected image payload.');
    }
    if (entry.mediaType === 'image' && (magic === 'mp4' || magic === 'mov')) {
      throw new Error('Expected image but detected video payload.');
    }

    if (entry.mediaType === 'video') {
      await this.probeVideo(entry.finalPath!);
    } else {
      await this.inspectImage(entry.finalPath!);
    }

    const hash = await streamHash(entry.finalPath!);
    if (entry.contentHash && entry.contentHash !== hash) {
      throw new Error('Output hash mismatch detected (non-deterministic result).');
    }
    entry.contentHash = hash;
  }

  private async inspectImage(filePath: string): Promise<void> {
    const metadata = await sharp(filePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Unable to read image dimensions.');
    }
  }

  private async probeVideo(filePath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (error: Error | null, data: FfprobeData) => {
        if (error) {
          reject(error);
          return;
        }
        const hasVideo = data.streams?.some((stream) => stream.codec_type === 'video');
        if (!hasVideo) {
          reject(new Error('Video stream missing from payload.'));
          return;
        }
        resolve();
      });
    });
  }
}
