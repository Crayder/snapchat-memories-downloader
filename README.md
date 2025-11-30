![Snapchat Memories Downloader icon](resources/icons/stacked-cards-arrow.svg)

# Snapchat Memories Downloader

Guided Electron app that ingests a Snapchat "My Data" export, repairs every memory deterministically, and emits a verifiable archive with full audit artifacts.

## Highlights

- **Guided wizard** – six clear steps (Welcome → Select Export → Choose Output → Options → Run → Finish) keep every operator on the happy path.
- **Local-only processing** – the ZIP stays on disk; downloads, parsing, metadata, and reports all run on your device. No cloud uploads, no third-party services.
- **Live run control** – start, pause, resume, and auto-pause-on-error so you can safely inspect issues mid-run.
- **Real-time telemetry** – the Run view surfaces live stats (totals, GPS counts, failures, stage) plus a streaming activity log for up to 200 entries.
- **Resilient media pipeline** – downloads resume, caption ZIPs are composed (corrupt overlays skipped with warnings), dedupe enforces hash/url uniqueness, and verification replays ffprobe/sharp integrity checks.
- **Metadata stamping** – ExifTool injects timestamps, GPS coordinates, and media metadata, then normalizes file mtimes for filesystem portability.
- **Automatic cleanup** – temp dirs, downloads, and legacy state are purged after each successful run (with a toggle to keep downloads if needed).
- **Retry failures workflow** – the Finish screen can jump back to Run with `retryFailedOnly`, targeting only entries that actually failed in the prior attempt. Helpful for intermittent network issues and rate limit issues.
- **Deep diagnostics** – per-run JSON + CSV reports, investigation journal artifacts, and optional diagnostics bundles (logs + state) aid support and forensics.

## Getting Started

1. **Install dependencies**
   ```powershell
   npm install
   ```
2. **Run in development**
   ```powershell
   npm run dev
   ```
3. **Build a distributable**
   ```powershell
   npm run build
   ```

Point the wizard at your untouched Snapchat export ZIP, choose an empty output directory, tweak options (concurrency, delay, dedupe strategy, dry/verify modes), then start the run. Monitor live stats, inspect logs, and use auto-pause to investigate anomalies. When finished, open the output folder or copy the run report path for further auditing.
