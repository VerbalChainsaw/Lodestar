# Changelog

## 1.0.1 - 2026-07-31

- Remove the mandatory first-run setup step: the first structurally valid
  `lodestar put` now initializes an absent or resumable zero-byte database
  before writing.
- Keep invalid first writes, every read-only command, help, version, and
  deletion against a missing registry side-effect free.
- Reuse the existing exclusive reservation, bounded busy window, and SQLite
  transactions so concurrent first writers preserve every record without
  another lock or storage mechanism.
- Keep `lodestar init` as an optional idempotent command for deliberately
  creating an empty registry or retrieving the bootstrap contract.

## 1.0.0 - 2026-07-31

- Replace the v0.7 generation platform with one local SQLite database.
- Publish one JSON-first executable, `lodestar`, with nine commands.
- Store records, exact aliases, explicit links, and source observations in five
  small tables.
- Keep `known`, `known_empty`, `unavailable`, `unknown`, and `stale` distinct.
- Add bounded deterministic search, one-hop link retrieval, canonical export,
  read-only diagnostics, and atomic put/delete transactions.
- Add a read-only, one-way v0.7 importer with dry-run, integrity validation,
  deterministic identifier mapping, loss reporting, and source-change checks.
- Harden no-replace database creation, SQLite byte/timestamp constraints,
  bounded diagnostics and growing-file reads, fail-closed stored JSON,
  incremental export limits, bounded migration reporting, concurrent imports,
  explicit unknown-commit handling with exact database identifiers, and exact
  v0.7 Unicode shard compatibility.
- Reject forged SQLite reserved-schema objects, enforce byte-exact streaming
  through typed-array intrinsic checks, make error normalization total for
  hostile in-process values, and keep JSON error codes aligned with exit
  status.
- Preserve published database reservations across definite failures, separate
  rollback-confirmed import failures from ambiguous commits, and make doctor
  apply the complete stored-value contract used by public reads.
- Preserve legacy locator paths and available locator-health observations as
  explicit source rows without converting path probes into content claims;
  report every ambiguous, orphaned, or unretained observation exactly once.
- Validate packaged documentation links and every public help path without
  touching database state.
- Remove generations, commit pointers, writer heartbeats, snapshots,
  quarantine, readiness scoring, project discovery, provider experiments,
  installer logic, benchmark commands, and every executable except `lodestar`.

## Retired v0.x platform

Versions 0.4.0 through 0.7.0 implemented the earlier generation-based context
platform. Their detailed changelogs, release notes, architecture, and package
artifacts remain available in their git tags and published GitHub releases.
They are not retained as dormant runtime code in Lodestar 1.0.
