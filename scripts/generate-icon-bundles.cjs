// Generates Windows .ico and macOS .icns from the 1024 PNG
// Usage: node scripts/generate-icon-bundles.cjs

const path = require('node:path');
const fs = require('node:fs');
const iconGen = require('icon-gen');

(async () => {
  const srcPng = path.resolve('resources/bin/icons/icon-1024.png');
  const outDir = path.resolve('resources/bin/icons');
  if (!fs.existsSync(srcPng)) {
    console.error('Missing', srcPng, '- run "npm run build:icons" first.');
    process.exit(1);
  }
  await iconGen(srcPng, outDir, {
    report: true,
    ico: { name: 'app' },
    icns: { name: 'app' },
    modes: ['ico', 'icns']
  });
  console.log('Wrote app.ico and app.icns to', outDir);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
