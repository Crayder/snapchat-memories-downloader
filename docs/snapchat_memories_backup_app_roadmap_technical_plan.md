# Snapchat Memories Backup App — Roadmap & Technical Plan

This document is a complete, implementation-oriented plan for a desktop application that:

1. Ingests a Snapchat “My Data” export ZIP.
2. Extracts and parses the Memories index (HTML and/or JSON).
3. Downloads **all** Memories media locally (photos/videos).
4. Repairs filenames and missing extensions.
5. Unpacks “caption ZIPs,” overlays captions onto the underlying photo/video, and emits a single final media file per Memory.
6. Writes correct metadata (capture time and GPS) into the files.
7. Removes duplicates.
8. Produces a reproducible, auditable archive.

The proposed implementation target is an Electron desktop app (Windows/macOS/Linux). The pipeline is deliberately modular so you can later split it into (a) a CLI engine plus (b) a GUI wrapper.

---

## 0. Scope, assumptions, and non-goals

### Scope
- You are downloading **your own** Snapchat Memories using the official export mechanism.
- The app runs locally and downloads media to a user-chosen local folder.
- The app performs local processing only (no cloud upload, no server relay).

### Assumptions
- Snapchat exports contain either:
  - **HTML** listing each memory and a JavaScript-driven download routine.
  - A **JSON** listing each memory with fields including a download link.
  - Sometimes both, depending on export options.
- Snapchat download links can expire. The user should run the app soon after receiving the export.

### Non-goals
- No login automation.
- No “screen scraping” of the Snapchat mobile app.
- No bypass of Snapchat security; the app uses only the signed URLs contained in the export.

---

## 1. What the Snapchat export ZIP contains (HTML and JSON variants)

### 1.1 What you actually provided (your `mydata.zip`)
Your uploaded ZIP contains **three HTML files**:

- `index.html`
- `html/faq.html`
- `html/memories_history.html`

There is **no JSON** in this particular ZIP.

The file of interest is:

- `html/memories_history.html`

This file contains:

- A single table with column headers:
  - `Date`
  - `Media Type`
  - `Location`
  - (a blank header for the download link)
- Rows where the last column includes a link whose `onclick` calls a JavaScript function:

```html
<a href="#" onclick="downloadMemories('https://.../dmd/mm?...', this, true); return false;">Download</a>
```

Important: in the copy you provided, the URLs appear **redacted with literal `...`** in the middle (they are not usable for real downloads). Real Snapchat exports should contain complete URLs.

### 1.2 HTML format (typical)
The memories HTML is effectively a self-contained webpage:

- The table provides metadata (timestamp, media type, location string).
- Each row provides a way to download the memory by calling `downloadMemories(url, linkElement, isGetRequest)`.
- The HTML also includes JavaScript helper functions to:
  - Perform GET downloads with a special header.
  - Perform POST “proxy” requests that return a final download URL.
  - Trigger browser download via a synthetic `<a>` click.
  - Perform sequential “download all” behavior.

#### Table semantics
- `Date` appears as a UTC timestamp string:
  - Example pattern: `YYYY-MM-DD HH:MM:SS UTC`
- `Media Type` is usually `Image` or `Video`.
- `Location` is either:
  - `Latitude, Longitude: <lat>, <lon>`
  - or indicates no location (varies; treat any non-matching string as “no GPS”).

#### Download link semantics (critical)
The onclick contains:

- a URL string
- a boolean `isGetRequest`

That boolean must be preserved. Snapchat’s own JavaScript uses it to select GET vs POST handling.

### 1.3 JSON format (recommended by this plan)
Snapchat can provide a `memories_history.json` (naming may vary). In the most common community format, each memory entry contains keys such as:

- `Date`
- `Media Type`
- `Location`
- `Download Link`

JSON is preferred because:

- Parsing is simpler and less brittle than scraping HTML.
- You can avoid coupling to Snapchat’s HTML layout changes.

### 1.4 App policy: ask users for JSON export
Your app should **strongly recommend** that users request Snapchat data in a way that yields **JSON**:

- Primary input: `memories_history.json` (or equivalent)
- Secondary input: `memories_history.html` (fallback)

UI copy should say, plainly:

- “For best results, request an export that includes a Memories JSON listing. HTML-only exports are supported, but are more fragile.”

Because users may only have HTML (as in your ZIP), your app must still support HTML.

---

## 2. Observed download mechanics in the HTML (reverse-engineered from your ZIP)

Your `memories_history.html` includes a JavaScript download routine that behaves as follows.

### 2.1 GET mode
When `isGetRequest === true`, the page uses an `XMLHttpRequest` GET with:

- `X-Snap-Route-Tag: mem-dmd`
- `responseType = 'blob'`

Then it converts the blob to an object URL and triggers a download.

### 2.2 POST mode (“proxy download”)
When `isGetRequest === false`, the page does:

1. Split `url` into `parts = url.split("?")`
2. `POST parts[0]` with header:
   - `Content-type: application/x-www-form-urlencoded`
3. Send body:
   - `parts[1]` (the querystring)
4. On HTTP 200, it calls `triggerFileDownload(xhttp.responseText)`

Meaning:

- The POST response body is **a URL string**.
- The browser then downloads that URL (by clicking a synthetic anchor).

### 2.3 What this means for your app
Your app must implement the same two-path logic:

- GET path:
  - GET the provided URL
  - set `X-Snap-Route-Tag: mem-dmd`
  - stream response to disk

- POST path:
  - POST to the base URL (before `?`)
  - send querystring as form body
  - parse response text as a URL
  - GET that returned URL (often a direct file URL)
  - stream to disk

The boolean `isGetRequest` comes directly from:

- HTML onclick third parameter
- or JSON may include an equivalent hint, or the link structure may imply it

If JSON does not provide a GET/POST hint, you must detect it by:

- trying GET first and, on a specific server error (e.g., “GET not supported”), fall back to POST.

---

## 3. Product requirements (what the app must do)

### 3.1 Inputs
- A Snapchat export ZIP file (preferred)
  - The app must unzip it in a working directory.
- One of:
  - `memories_history.json` (preferred)
  - `memories_history.html` (fallback)

### 3.2 Outputs
- A user-chosen destination folder containing:
  - one finalized media file per memory
  - consistent filenames
  - embedded metadata (time, GPS)
  - captions burned in (where applicable)
  - duplicates removed

### 3.3 Core features
- Import/export ZIP
- Locate and parse metadata index
- Bulk downloader with retry/resume
- Caption ZIP unpack + overlay
- Metadata injection
- Deduplication
- Logs + exportable report

### 3.4 Quality and safety
- Never transmit export data to any third party.
- Store only what is needed; avoid keeping OAuth/session tokens (not used anyway).
- Provide a “dry run” mode: parse only, show counts.
- Provide a “verify” mode: check that all expected outputs exist.

---

## 4. High-level architecture (Electron)

### 4.1 Processes
Electron naturally splits into:

- **Main process**
  - file pickers (open ZIP, choose output)
  - orchestration
  - worker process management
  - persistent state

- **Renderer process**
  - UI (wizard + progress)
  - log display
  - settings

- **Worker(s)**
  - downloads
  - ZIP extraction
  - image compositing
  - ffmpeg overlay
  - metadata writing
  - hashing

You should **not** do heavy work in the renderer.

### 4.2 Core modules

1. `ImportService`
   - open ZIP
   - extract to work dir
   - find `memories_history.(json|html)`

2. `IndexParser`
   - JSON parser
   - HTML parser
   - output normalized `MemoryEntry[]`

3. `DownloadService`
   - GET/POST logic
   - streaming writes
   - retries + backoff
   - concurrency limiting

4. `PostProcessService`
   - file-type detection
   - extension repair
   - caption ZIP detection and merge

5. `MetadataService`
   - exiftool integration
   - file mtime setting

6. `DedupService`
   - hashing
   - duplicate decision + removal policy

7. `StateStore`
   - persistent progress DB (SQLite or JSONL)

8. `ReportService`
   - summary
   - errors
   - skipped
   - outputs

### 4.3 Suggested libraries (Node)
- ZIP:
  - `yauzl` / `adm-zip` / `node-stream-zip` (choose one)
- HTML parsing:
  - `cheerio` (robust) or `jsdom`
- HTTP:
  - `undici` (Node core-quality) or `axios`
- Concurrency:
  - `p-queue` or `bottleneck`
- Images:
  - `sharp` (libvips)
- Video:
  - bundle ffmpeg via `ffmpeg-static` or ship platform binaries
- Metadata:
  - `exiftool-vendored` (recommended)
- Hashing:
  - Node `crypto` streaming

---

## 5. Data model (normalized memory entries)

Define a single internal schema regardless of HTML/JSON source.

```ts
type MemoryEntry = {
  index: number;                 // stable row index
  capturedAtUtc: string;         // ISO string (e.g., 2025-11-24T18:41:51Z)
  capturedAtRaw: string;         // original string from export
  mediaType: 'image' | 'video' | 'unknown';

  hasGps: boolean;
  latitude?: number;
  longitude?: number;

  downloadUrl: string;           // may be signed
  downloadMethodHint?: 'GET' | 'POST';

  // runtime fields
  downloadStatus: 'pending' | 'downloading' | 'downloaded' | 'failed' | 'skipped';
  downloadedPath?: string;
  finalPath?: string;

  isZipPayload?: boolean;        // downloaded file was zip
  errors?: string[];
};
```

Key points:

- Store both `capturedAtRaw` and normalized ISO time.
- Store GPS only if present and parsed.
- Store a method hint from HTML boolean where available.

---

## 6. Parsing the export index

### 6.1 JSON parsing (preferred)

Algorithm:

1. Read JSON.
2. Identify memory list:
   - It may be a top-level array or nested.
3. For each entry:
   - parse `Date` (capture time)
   - parse `Media Type` (image/video)
   - parse `Location`
   - parse `Download Link`
4. Normalize to `MemoryEntry`.

Robustness rules:

- Key names may vary in capitalization.
- Location may be:
  - `Latitude, Longitude: a, b`
  - empty
  - `No Location`

### 6.2 HTML parsing (fallback)

From your ZIP, the HTML contains a single `<table>`.

Algorithm:

1. Load HTML.
2. Find the first table that has headers containing `Date` and `Media Type`.
3. For each data row (`<tr>` with `<td>` cells):
   - `td[0]` date
   - `td[1]` media type
   - `td[2]` location string
   - `td[3]` contains `<a onclick="downloadMemories('URL', this, BOOL); return false;">`
4. Extract:
   - URL between the first pair of `'` after `downloadMemories(`
   - BOOL from the third argument

Regex example (for onclick):

```js
const re = /downloadMemories\('([^']+)'\s*,\s*this\s*,\s*(true|false)\)/;
```

Mapping:

- `true`  → hint `GET`
- `false` → hint `POST`

### 6.3 Parsing date

Input format observed:

- `YYYY-MM-DD HH:MM:SS UTC`

Normalize:

- Replace space between date/time with `T`.
- Replace trailing ` UTC` with `Z`.

Example:

- `2025-11-24 18:41:51 UTC`
- → `2025-11-24T18:41:51Z`

### 6.4 Parsing location

Observed format:

- `Latitude, Longitude: 39.645145, -85.14941`

Regex:

```js
const re = /Latitude,\s*Longitude:\s*([+-]?\d+(?:\.\d+)?),\s*([+-]?\d+(?:\.\d+)?)/;
```

Rules:

- If regex fails: `hasGps = false`.
- If values are both 0: treat as “no GPS” unless you have evidence otherwise.

---

## 7. Download engine

### 7.1 Requirements
- Must support both GET and POST modes.
- Must stream to disk.
- Must handle large batches (thousands).
- Must allow pause/resume.
- Must retry transient failures.
- Must throttle concurrency.

### 7.2 File naming strategy

You want stable, chronological, unique names.

Recommended naming format:

```
YYYY-MM-DD_HH-MM-SSZ_<type>_<index>.<ext>
```

Example:

- `2025-11-24_18-41-51Z_image_000123.jpg`

Why include index:

- Multiple memories can share the same second.
- The original export ordering is stable.

### 7.3 Determining extension

Preferred order:

1. `Content-Disposition` filename extension if present.
2. `Content-Type` mapping.
3. Magic-byte detection (read first 16 bytes).
4. Fallback by mediaType:
   - image → `.jpg`
   - video → `.mp4`

Magic bytes:

- JPEG: starts with `FF D8 FF`
- PNG: starts with `89 50 4E 47 0D 0A 1A 0A`
- ZIP: starts with `50 4B 03 04`
- MP4: contains `ftyp` within first ~32 bytes

### 7.4 GET flow

Pseudo:

```ts
async function downloadGet(entry) {
  const res = await fetch(entry.downloadUrl, {
    method: 'GET',
    headers: { 'X-Snap-Route-Tag': 'mem-dmd' },
  });
  // Validate status
  // Stream to temp file
  // Determine ext
  // Rename to final download filename
}
```

### 7.5 POST flow

Pseudo:

```ts
async function downloadPost(entry) {
  const [base, query] = entry.downloadUrl.split('?');
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: query,
  });
  const directUrl = await res.text();
  // Then GET directUrl (stream to disk)
}
```

### 7.6 Robust “unknown” method fallback
If no hint is available:

1. Try GET with header.
2. If response indicates GET unsupported (or 4xx with known signature), try POST.

### 7.7 Concurrency and throttling

- Use a queue with `concurrency = 3..10`.
- Insert a small delay after each completed request group.

Implement exponential backoff for:

- 429
- 5xx
- network timeouts

### 7.8 Resume logic

Maintain a persistent state store:

- key by `index` and `downloadUrl`.
- store `downloadedPath` and `hash` once known.

On restart:

- if final output exists and passes sanity checks, mark as done.

Sanity checks:

- file exists
- file size > minimum threshold
- magic bytes match expected type

---

## 8. Handling ZIP payloads (caption overlays)

### 8.1 What they are
Some Memories download as a ZIP that typically contains:

- a base image (`.jpg`) or base video (`.mp4`)
- one or more overlay images (`.png`) containing caption/sticker/filter artwork

The goal is:

- produce a single final media file that looks like the original Snap.

### 8.2 Detecting ZIP payloads
Downloaded file is ZIP if:

- extension is `.zip`, or
- magic bytes indicate ZIP (`PK\x03\x04`).

Mark `entry.isZipPayload = true`.

### 8.3 Extraction rules
Extract ZIP to:

- `${workDir}/extract/<entry.index>/`

Identify contents:

- Base media: the largest non-PNG file with extension `.jpg|.jpeg|.mp4|.mov`.
- Overlays: all `.png` files.

If multiple candidate base files exist:

- prefer video if `entry.mediaType === 'video'`.
- else prefer the largest by bytes.

### 8.4 Overlay rules for images
Use `sharp`:

- load base image
- sequentially composite overlays in order:
  - if overlays have full dimensions, use `{ left: 0, top: 0 }`

Pseudo:

```ts
let img = sharp(basePath);
for (const overlayPng of overlays) {
  img = img.composite([{ input: overlayPng, left: 0, top: 0 }]);
}
await img.jpeg({ quality: 95 }).toFile(outPath);
```

If base is PNG, out can be PNG; but usually PNG overlays go onto JPEG base.

### 8.5 Overlay rules for videos
Use ffmpeg filter `overlay`.

If multiple overlays:

- chain overlay filters (or pre-compose PNG overlays into one PNG using sharp, then overlay once).

Preferred approach:

1. Merge overlays into a single PNG:
   - create transparent canvas matching video frame size
   - composite each overlay
2. ffmpeg overlay once.

ffmpeg pseudo command:

```
ffmpeg -y \
  -i base.mp4 \
  -i overlay.png \
  -filter_complex "[0:v][1:v]overlay=0:0:format=auto" \
  -c:a copy \
  -c:v libx264 -crf 18 -preset medium \
  out.mp4
```

Notes:

- Overlay filter requires re-encoding video.
- Use a quality setting that is visually lossless.

### 8.6 Cleanup
After producing final media:

- delete extracted temp dir
- delete downloaded ZIP (or move to `trash/` inside work dir)

### 8.7 Caption failure policy
If overlay processing fails:

- preserve the ZIP in an “unprocessed” folder
- emit a report row showing failure reason
- continue with the rest

---

## 9. Repairing missing extensions

Even outside ZIP payloads, some downloads can lack extensions.

### 9.1 Detection
A file needs repair if:

- path has no extension, or
- extension doesn’t match detected magic bytes.

### 9.2 Repair algorithm
1. Read first 32 bytes.
2. Determine file type.
3. Rename file with correct extension.
4. Update `entry.downloadedPath`.

Edge case: a file without extension might be either JPEG or PNG.

- Use magic bytes, not guesswork.

---

## 10. Metadata injection (time + GPS)

### 10.1 Why exiftool
ExifTool is the practical choice because:

- it can write photo EXIF
- it can write video QuickTime/XMP
- it handles edge cases better than ad-hoc libraries

### 10.2 Required metadata
For each final media file:

- capture timestamp
- GPS latitude/longitude if available

### 10.3 Date formatting
ExifTool generally accepts:

- `YYYY:MM:DD HH:MM:SS`

From ISO `2025-11-24T18:41:51Z`:

- convert to `2025:11:24 18:41:51`

### 10.4 Tags to write (minimum viable)
Images (JPEG):

- `DateTimeOriginal`
- `CreateDate`
- `ModifyDate`

Videos (MP4/MOV):

- `CreateDate`
- `ModifyDate`
- `TrackCreateDate`
- `TrackModifyDate`
- `MediaCreateDate`
- `MediaModifyDate`

GPS:

- `GPSLatitude`
- `GPSLongitude`
- `GPSLatitudeRef` (`N`/`S`)
- `GPSLongitudeRef` (`E`/`W`)

If you want to be thorough, also add XMP duplicates:

- `XMP:DateTimeOriginal`
- `XMP:CreateDate`

### 10.5 exiftool execution strategy
Use `exiftool-vendored`:

- ships binaries per platform
- provides a JS API

Pseudo:

```ts
await exiftool.write(filePath, {
  DateTimeOriginal: exifDate,
  CreateDate: exifDate,
  ModifyDate: exifDate,
  GPSLatitude: lat,
  GPSLongitude: lon,
});
```

Use `-overwrite_original`.

### 10.6 File system timestamps
After metadata write:

- set mtime (and atime) to captured time
- on Windows/macOS you may also want create time, but that is OS-specific

At minimum:

- mtime updated improves sorting in basic file browsers.

---

## 11. Deduplication

### 11.1 When duplicates occur
- The user merges multiple exports.
- Snapchat export contains repeated entries.
- Partial reruns or interruptions produce repeated downloads.

### 11.2 Two-stage dedup strategy
Stage A: semantic key

- Use `downloadUrl` (or a stable portion like a UID parameter) as a primary key.
- If the same key appears twice, skip the second.

Stage B: content hash

- Stream-hash final outputs (SHA-256).
- Group by hash.
- Keep the earliest entry (or highest-quality if sizes differ).

### 11.3 What to do with duplicates
Policy options:

- Default: move duplicates into `duplicates/` folder
- Optional: delete duplicates

Provide a report summary:

- how many duplicates found
- which filenames

---

## 12. UI/UX plan (basic but correct)

### 12.1 Wizard screens
1. **Welcome / warnings**
   - “This tool downloads from Snapchat’s signed links. Run soon after export.”
   - “For best results, request JSON export.”

2. **Select export**
   - choose ZIP
   - show detected files
   - show whether JSON present

3. **Choose output folder**
   - destination folder

4. **Options**
   - concurrency (default 5)
   - retry limits
   - keep originals (ZIP payloads) toggle
   - dedupe policy (move vs delete)

5. **Run**
   - progress bar
   - counters: downloaded / processed / tagged
   - current action
   - live logs
   - pause/resume

6. **Finish**
   - summary
   - open output folder
   - export report (JSON/CSV)

### 12.2 Progress granularity
Track at least these phases:

- parse index
- download
- unpack/compose
- metadata
- dedupe

### 12.3 Logging
Persist logs to:

- `${workDir}/logs/run-<timestamp>.log`

Expose:

- “Copy diagnostics” button

---

## 13. Persistent state store (resume and auditing)

### 13.1 Why you need it
A 6GB export can involve:

- thousands of downloads
- intermittent failures
- long processing time

Without state, users will repeatedly redo work.

### 13.2 Minimal schema
Store per entry:

- index
- downloadUrl
- method used
- downloadedPath
- finalPath
- completion flags
- last error
- attempts
- content hash

SQLite is strongly recommended.

---

## 14. Packaging and distribution

### 14.1 Electron packaging
Use `electron-builder`.

- Windows: NSIS installer
- macOS: DMG
- Linux: AppImage

### 14.2 Bundling ffmpeg
Options:

- Bundle platform ffmpeg binaries.
- Or depend on user-installed ffmpeg and ask for its path.

Bundling is easier for end users.

### 14.3 Bundling exiftool
Use `exiftool-vendored` to avoid external install.

### 14.4 Work directory location
Use OS-appropriate per-user app data directory:

- Windows: `%APPDATA%/<AppName>/work/`
- macOS: `~/Library/Application Support/<AppName>/work/`
- Linux: `~/.config/<AppName>/work/`

Provide “Clear cache” button.

---

## 15. Detailed end-to-end pipeline (step-by-step)

This section is the operational roadmap.

### Step 1 — Import
1. User selects export ZIP.
2. App copies ZIP into work dir.
3. App extracts ZIP.
4. App scans for:
   - `memories_history.json`
   - `memories_history.html`
5. If JSON missing:
   - show warning + instructions.
   - allow “Continue with HTML”.

### Step 2 — Parse index
1. Parse JSON if present; else parse HTML.
2. Normalize to `MemoryEntry[]`.
3. Validate:
   - non-empty list
   - each entry has date + url
4. Display stats:
   - total memories
   - images vs videos
   - with GPS count

### Step 3 — Prepare destination
1. Ensure output directory exists.
2. Create subfolders (optional):
   - `output/`
   - `duplicates/`
   - `unprocessed/`

### Step 4 — Download
For each entry:

1. Compute intended filename (timestamp + type + index).
2. If entry already completed in state store:
   - skip
3. Else download:
   - method = hint GET/POST if present
   - else fallback logic
4. Write to a temp name first:
   - `<filename>.part`
5. On success:
   - rename `.part` to final download stage name
6. Set `entry.downloadStatus`.

### Step 5 — Detect and process ZIP payloads
For each downloaded file:

1. If file is ZIP:
   - extract
   - select base media
   - collect overlays
   - compose:
     - if image → sharp composite
     - if video → ffmpeg overlay
   - output final media file
   - delete temp artifacts
2. Else:
   - final media = downloaded media

### Step 6 — Fix extensions
For each final media:

1. Validate extension matches type.
2. Rename if needed.

### Step 7 — Write metadata
For each final media:

1. Write timestamp tags.
2. If GPS:
   - write GPS tags.
3. Set filesystem mtime.

### Step 8 — Deduplicate
1. Compute hash for each output file.
2. Group duplicates.
3. Move/delete according to policy.

### Step 9 — Finish
1. Create report:
   - successes
   - failures
   - skipped
   - duplicates
2. Present summary.

---

## 16. Error handling and recovery strategies

### 16.1 Download failures
Common causes:

- expired signed URL
- rate limiting
- transient network

Mitigations:

- retries with backoff
- reduce concurrency when many failures occur
- resume support

If all retries fail:

- mark entry failed
- include in report

### 16.2 POST response is not a URL
If POST returns unexpected content:

- log response (truncate)
- mark failed
- continue

### 16.3 ffmpeg failure
Likely causes:

- unexpected codec
- overlay size mismatch

Mitigations:

- probe video dimensions (ffprobe)
- pre-compose overlay to match frame size
- use robust ffmpeg filter chain

### 16.4 exiftool failure
Likely causes:

- file locked
- unsupported container

Mitigations:

- retry
- skip metadata but keep file

---

## 17. Verification checklist (for you and for users)

### 17.1 Completeness
- Number of output files equals number of memories (minus duplicates).

### 17.2 Visual correctness
- Sample check: captioned memories render with caption burned in.

### 17.3 Metadata correctness
- Spot-check EXIF “Date Taken” matches table date.
- Spot-check GPS opens correctly in photo apps.

### 17.4 Determinism
- Re-running on same export should not duplicate output.

---

## 18. Implementation plan (milestones)

### Milestone A — Parser + model
- Import ZIP
- Find index
- Parse HTML
- Parse JSON
- Normalize entries
- Render counts in UI

### Milestone B — Downloader
- Implement GET/POST logic
- Streaming downloads
- Concurrency limiting
- Progress UI
- Resume state

### Milestone C — ZIP caption processing
- ZIP detect
- Extract
- Image composite via sharp
- Video overlay via ffmpeg
- Emit final file

### Milestone D — Metadata
- exiftool-vendored integration
- GPS tagging
- mtime

### Milestone E — Dedup and reports
- Hashing
- dedupe
- report export

### Milestone F — Packaging
- electron-builder
- bundled binaries
- signed builds (optional)

---

## Appendix A — HTML parsing example (concrete)

Given a row like:

```html
<tr>
  <td>2025-11-24 18:41:51 UTC</td>
  <td>Image</td>
  <td>Latitude, Longitude: 39.645145, -85.14941</td>
  <td>
    <a href="#" onclick="downloadMemories('https://.../dmd/mm?...', this, true); return false;">Download</a>
  </td>
</tr>
```

Extract:

- date raw: `2025-11-24 18:41:51 UTC`
- iso: `2025-11-24T18:41:51Z`
- type: image
- gps: 39.645145, -85.14941
- url: the quoted string
- hint: GET (because boolean is true)

---

## Appendix B — Output folder layout (recommended)

```
<OutputRoot>/
  memories/
    2025-11-24_18-41-51Z_image_000001.jpg
    ...
  duplicates/
    ...
  reports/
    run-2025-11-29T12-30-00Z.json
    run-2025-11-29T12-30-00Z.csv
```

---

## Appendix C — Report format

A JSON report should contain:

- run metadata (time, version)
- counts
- list of failures with reasons
- list of outputs
- duplicates mapping

---

## Appendix D — Security notes

- Treat the export ZIP and derived working files as sensitive.
- Avoid analytics.
- Avoid auto-updates unless carefully signed; keep offline-friendly.

---

## Appendix E — Practical guidance for users (copy for your UI)

1. Request your data from Snapchat.
2. Prefer exports that include **Memories JSON**.
3. Download the export ZIP.
4. Open this app, choose the ZIP, choose an output folder.
5. Start the run and keep the app open until completion.
6. When finished, verify a few captioned memories and check metadata.

---

## Appendix F — Open questions you will resolve during implementation

These are not blockers, but you must test them against real (non-redacted) exports:

1. Whether all URLs are directly retrievable with no cookies.
2. Whether POST-returned URLs require the same `X-Snap-Route-Tag` header.
3. The exact set of files inside caption ZIPs in modern exports (some may include multiple overlays).
4. Whether some memories download as formats other than JPG/MP4 (e.g., HEIC/MOV).

---

## Final note

Your current uploaded `mydata.zip` provides a verified HTML structure and verified download logic (GET header vs POST proxy). The remaining implementation risk is almost entirely empirical: you must test with an unredacted export to validate network behavior at scale and confirm ZIP payload formats. The pipeline above is designed to tolerate those variations without architectural changes.

