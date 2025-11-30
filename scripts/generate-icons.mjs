import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const srcSvg = path.resolve('resources/icons/stacked-cards-arrow.svg');
const outDir = path.resolve('resources/bin/icons');
const sizes = [1024, 512, 256, 128, 64, 48, 32, 16];

async function ensureOutDir() {
  await fs.mkdir(outDir, { recursive: true });
}

async function buildPngs() {
  const svgBuffer = await fs.readFile(srcSvg);
  for (const size of sizes) {
    const file = path.join(outDir, `icon-${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toFile(file);
    // eslint-disable-next-line no-console
    console.log('wrote', file);
  }
  const alias = path.join(outDir, 'icon.png');
  await fs.copyFile(path.join(outDir, 'icon-512.png'), alias);
}

(async () => {
  await ensureOutDir();
  await buildPngs();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
