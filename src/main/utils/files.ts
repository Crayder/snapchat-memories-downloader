import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';

export const ensureDir = async (dir: string) => {
  await fs.ensureDir(dir);
  return dir;
};

export const streamHash = async (filePath: string, algorithm: string = 'sha256'): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    hash.once('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
};

export const tempPath = (dir: string, filename: string): string => path.join(dir, `${filename}.part`);

export const replaceExtension = (filePath: string, ext: string): string => {
  const { dir, name } = path.parse(filePath);
  return path.join(dir, `${name}${ext.startsWith('.') ? ext : `.${ext}`}`);
};
