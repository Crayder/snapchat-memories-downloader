# Snapchat Memories Backup App — Checklist

## Foundational Scope & Policies
- [x] Confirm app processes only user-provided exports locally with no external transmission.
- [x] Remind users to request JSON-inclusive exports and to run soon after link issuance.
- [x] Enforce non-goals: no login automation, no scraping, no security bypasses.

## Inputs, Outputs, and Safety
- [x] Implement ZIP ingestion with extraction to a controlled work directory.
- [x] Detect `memories_history.json` or `memories_history.html`; warn when JSON missing.
- [x] Produce finalized media folder with consistent filenames, burned-in captions, metadata writes, and duplicate handling.
- [x] Provide dry-run (parse only) and verify modes plus comprehensive logging/report export.

## Architecture & Services
- [x] Establish Electron main/renderer/worker separation (main orchestrates, renderer is UI, workers run heavy jobs).
- [x] Implement services: ImportService, IndexParser, DownloadService, PostProcessService, MetadataService, DedupService, StateStore, ReportService.
- [x] Wire persistent state storage (SQLite or equivalent) for resume/audit data.

## Parsing & Data Modeling
- [x] Normalize entries into `MemoryEntry` schema with timestamps, GPS, download hints, and runtime status.
- [x] Build JSON parser that tolerates key casing/nesting variance and extracts metadata fields.
- [x] Build HTML parser that locates the memories table and scrapes onclick download info safely.
- [x] Provide helpers for date normalization and GPS extraction from text strings.

## Download Engine
- [x] Implement GET downloads with `X-Snap-Route-Tag: mem-dmd`, streaming to disk with temp files.
- [x] Implement POST proxy downloads (split query, POST form, follow returned URL) plus fallback detection.
- [x] Add concurrency limiting, retries with exponential backoff, and pause/resume support.
- [x] Infer file extensions using disposition header, MIME type, and magic bytes before renaming.
- [x] Persist progress and sanity-check outputs before marking entries complete.

## ZIP Payload & Post-Processing
- [x] Detect ZIP payloads by extension or magic bytes and track via `isZipPayload`.
- [x] Extract caption ZIPs per entry, choosing base media vs overlay PNGs intelligently.
- [x] Composite overlays on images using `sharp` and on videos using ffmpeg overlay filters, pre-merging multiple overlays when needed.
- [x] Clean up temporary extraction artifacts while retaining failures for diagnostics.

## Metadata & Filesystem Hygiene
- [x] Repair missing or incorrect extensions based on magic-byte detection.
- [x] Integrate `exiftool-vendored` to write EXIF/XMP/QuickTime timestamps and GPS tags.
- [x] Update filesystem timestamps (mtime/atime) to capture time for all finalized media.

## Deduplication & Reporting
- [x] De-duplicate first by semantic key (download URL or UID) and then by SHA-256 content hashes.
- [x] Move or delete duplicates per policy while keeping canonical outputs.
- [x] Generate JSON/CSV reports summarizing successes, failures, skipped items, and duplicates.

## UI/UX Workflow
- [x] Build wizard screens: Welcome, Select Export, Choose Output, Options, Run (with logs/progress), Finish.
- [x] Surface stats (counts, GPS presence), live logs, pause/resume, and diagnostics export.
- [x] Allow configuration of concurrency, retries, ZIP retention, dedupe policy, and dry-run/verify toggles.

## Packaging & Distribution
- [x] Configure electron-builder for Windows (NSIS), macOS (DMG), and Linux (AppImage).
- [x] Bundle ffmpeg binaries and rely on `exiftool-vendored` for metadata tooling.
- [x] Place work directories under platform-specific app data paths and expose cache-clearing.

## Pipeline Execution & QA
- [x] Implement the nine-step operational pipeline (import → parse → prep → download → ZIP process → fix extensions → metadata → dedupe → finish).
- [x] Handle common failure scenarios (expired URLs, POST anomalies, ffmpeg/exiftool errors) with retries and user-facing guidance.
- [ ] Verify completeness, visual correctness, metadata accuracy, and determinism via automated checks.

## Milestones & Open Questions
- [x] Deliver milestone sequence A–F (parsers through packaging) with test coverage per stage.
- [ ] Investigate outstanding empirical questions (URL auth needs, POST headers, ZIP contents, alt formats) using real exports during QA.
