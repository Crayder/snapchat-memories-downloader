import fs from 'fs-extra';
import { ExifTool } from 'exiftool-vendored';
import type { MemoryEntry } from '../../shared/types/memory-entry.js';
import { toExifTimestamp } from '../utils/date.js';
import type { ProgressCallback } from '../types.js';
import type { PauseSignal } from '../pipeline/pipeline-control.js';
import log from '../logger.js';

export class MetadataService {
  private exif = new ExifTool();

  async run(entries: MemoryEntry[], progress: ProgressCallback, control?: PauseSignal): Promise<void> {
    for (const entry of entries) {
      await control?.waitIfPaused();
      if (!entry.finalPath || entry.downloadStatus !== 'processed') {
        continue;
      }
      try {
        progress({ type: 'entry', entry, message: 'Writing metadata' });
        await this.writeMetadata(entry);
        await this.alignFileTimestamp(entry);
        entry.downloadStatus = 'metadata';
      } catch (error) {
        entry.downloadStatus = 'failed';
        entry.errors = [...(entry.errors ?? []), (error as Error).message];
        entry.failureStage = 'metadata';
        log.error('Metadata write failed for %s: %s', entry.finalPath, (error as Error).message);
      }
    }
  }

  async dispose(): Promise<void> {
    await this.exif.end();
    this.exif = new ExifTool();
  }

  private async writeMetadata(entry: MemoryEntry): Promise<void> {
    const exifTimestamp = toExifTimestamp(entry.capturedAtUtc);
    const tags: Record<string, string | number> = {
      DateTimeOriginal: exifTimestamp,
      CreateDate: exifTimestamp,
      ModifyDate: exifTimestamp
    };
    if (entry.mediaType === 'video') {
      tags.TrackCreateDate = exifTimestamp;
      tags.TrackModifyDate = exifTimestamp;
      tags.MediaCreateDate = exifTimestamp;
      tags.MediaModifyDate = exifTimestamp;
    }
    if (entry.hasGps && typeof entry.latitude === 'number' && typeof entry.longitude === 'number') {
      tags.GPSLatitude = entry.latitude;
      tags.GPSLongitude = entry.longitude;
      tags.GPSLatitudeRef = entry.latitude >= 0 ? 'N' : 'S';
      tags.GPSLongitudeRef = entry.longitude >= 0 ? 'E' : 'W';
    }

    await this.exif.write(entry.finalPath!, tags, ['-overwrite_original']);
  }

  private async alignFileTimestamp(entry: MemoryEntry): Promise<void> {
    const mtime = new Date(entry.capturedAtUtc);
    await fs.utimes(entry.finalPath!, mtime, mtime);
  }
}
