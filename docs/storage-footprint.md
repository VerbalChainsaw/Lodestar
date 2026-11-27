# Lodestar storage observation and prevention

CodePlan2 1.2.0, concise implementation. Source baseline b2024d561f67a3a6789005bc7e9d93880419756c. Keep the one-shot command boundary, schema-5 guards and validated receipt identity. Existing doctor owns expensive SQLite integrity and semantic checks, while scripts/benchmark-disposable.mjs owns comparative disposable workload measurement. Neither belongs on Agent startup. The new script is opt-in and independent of the installed CLI.

Run from the source checkout with Node 24.15 or newer. Select a protected, consistent offline copy; the script does not locate or default to your configured registry:

    node scripts/storage-footprint.mjs "<explicit local SQLite snapshot path>"
    node --test test/storage-footprint.test.mjs

The script does not connect to SQLite or write files. It reports the sampled lengths of the main DB and named WAL/SHM/journal sidecars. A matching header on a stable, sidecar-free sample can estimate reusable page bytes, not bytes the OS would reclaim. If sidecars exist, the sample changes, or header fields are not trustworthy, the script suppresses the page estimates. It does not inspect integrity. Exit status 2 indicates a missing or extra argument; status 1 indicates the observation could not be made. A successful measurement can still report a header warning.

This is not total retained or physical allocated disk usage: measure protected originals, backup copies, compressed archives, restored caches, and temporary allocations separately. Compare like-for-like observations against accepted-write counts; do not treat WAL rollover, reused pages, apparent growth or claimed free bytes alone as a cleanup signal. File lengths and metadata checks are best effort, not an atomic snapshot. An invalid header is a reason to preserve evidence and verify the copy, not proof that the authoritative store is corrupt.

## Conservative next decisions

1. Use the existing disposable benchmark before changing retention. Compare baseline and candidate using the same accepted trace, replay/state parity, bytes per 1,000 accepted writes, steady and peak total bytes, writer latency and handoff size. Avoid duplicate producer emissions only when stable logical identity and measured redundancy prove equivalence. Keep distinct evidence and permanent request fences.
2. If unexplained growth persists, attribute it on a SQLite-consistent protected snapshot with an explicit budget. Distinguish reusable pages from growing payload, index cost, stale caches and duplicated backups. Do not perform live VACUUM, automatic aging/pruning or archive expansion based on one sample.
3. Use existing doctor on the same protected candidate copy for actual health; rehearse verified recovery before any intervention. Preserve untouched originals and reconcile accepted post-snapshot writes exactly once before a future cutover. Do not swap back a snapshot blindly.

No live DB was opened for validation. Tests compare real disposable SQLite page/freelist values and WAL/SHM/rollback-journal lengths, verify source-file bytes are unchanged, and check CLI behavior and failure labeling. Scope is diagnostics and decision support, not installation or enforcement.
