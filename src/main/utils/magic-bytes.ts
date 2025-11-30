import fs from 'fs-extra';

export type MagicType = 'jpg' | 'png' | 'zip' | 'mp4' | 'mov' | 'unknown';

const MAGIC_MAP: Array<{ type: MagicType; bytes: number[]; offset?: number }> = [
  { type: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'mp4', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 },
  { type: 'mov', bytes: [0x6d, 0x6f, 0x6f, 0x76], offset: 4 }
];

export const detectMagicType = async (filePath: string): Promise<MagicType> => {
  const fd = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64);
    await fd.read(buffer, 0, 64, 0);
    for (const sig of MAGIC_MAP) {
      const start = sig.offset ?? 0;
      const sample = buffer.subarray(start, start + sig.bytes.length);
      if (sample.length < sig.bytes.length) continue;
      if (sig.bytes.every((value, idx) => sample[idx] === value)) {
        return sig.type;
      }
    }
    return 'unknown';
  } finally {
    await fd.close();
  }
};
