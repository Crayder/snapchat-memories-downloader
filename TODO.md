# Snap Export Worker – Temporary TODO

- [x] Enhance Options step with adjustable delay/timeout controls and explain Snapchat rate limiting impacts.
- [x] Fix Finish page stats aggregation so deduped counts roll up and add a "Reattempts" counter.
- [x] Move the report path into its own row with a copy-to-clipboard control.
- [x] Ensure the "Export Diagnostics Bundle" button performs its export action.
- [x] Add Finish page continuation options (retry failures, restart, exit).
- [x] Implement post-run cleanup: relocate state.json to output root, delete .tmp/work, optional downloads purge, remove empty duplicates.
- [x] Add Finish page action to open the output folder.
- [x] Ensure packaged app taskbar icon uses the new stacked-cards artwork.
- [x] Resolve ZIP payload processing so composed media lands in the memories folder without errors.
- [x] Add a Run-page "auto-pause on error" toggle that halts automatically when failures hit the log.
- [x] Make "Retry failures" only reattempt entries that previously failed instead of redownloading everything.
- [x] Add a batch pause option (configurable count, runtime toggle) to auto-pause after N operations.
- [x] Instrument post-process/post-run failures with stage tagging, ffprobe path validation, and captured ZIP artifacts.
- [x] Surface per-stage failure counts on the Run stats and Finish summary.
