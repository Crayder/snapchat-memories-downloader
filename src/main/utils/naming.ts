import path from 'node:path';
import { toFilenameStamp } from './date.js';

export const buildOutputName = (capturedAtIso: string, mediaType: string, index: number, ext: string) => {
  const stamp = toFilenameStamp(capturedAtIso);
  const padded = index.toString().padStart(6, '0');
  const safeExt = ext.startsWith('.') ? ext : `.${ext}`;
  return `${stamp}_${mediaType}_${padded}${safeExt}`;
};

export const ensureExtension = (filename: string, fallbackExt: string): string => {
  const hasExt = path.extname(filename);
  if (hasExt) {
    return filename;
  }
  return `${filename}${fallbackExt.startsWith('.') ? fallbackExt : `.${fallbackExt}`}`;
};
