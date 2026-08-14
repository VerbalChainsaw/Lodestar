# Changelog

## 1.2.0 - 2026-08-13

- Generate one required governance record and one canonical bootstrap from the
  managed assets, return the rule on every startup, and transactionally manage
  explicitly configured client bootstrap files alongside the skill payload.
- Fold work presence, continuity, and durable decisions into the Lodestar
  umbrella skill while keeping one executable and one SQLite authority.
- Bundle the managed client skills and instruction templates in the Lodestar
  package, with one `skills install|sync|verify|remove` lifecycle for Codex,
  Claude, Hermes, and OpenCode.
- Add session-isolated `handoff arm|status|checkpoint|now|disarm`, atomic
  next-session startup claiming, append-only `decision` events, and deterministic
  FACTS/DEAD startup projection.
- Import supported historical knowledge, work, decision, continuity, and current
  Lodestar state through one checksummed, backup-first, idempotent manifest.
- Keep WSL skill staging and backups on the Linux filesystem, translate client
  roots at the one-shot shim boundary, and verify the installed shim is
  executable before returning success.
- Preflight and stage the complete managed-skill batch before client mutation,
  compensate handled cross-client failures in reverse order, and keep each
  stage on its destination filesystem.
- Exercise the packed package through every public command family, the real
  Codex MCP stdio transport, real AgentLink subprocess delegation, and a
  disposable live-scale latency/concurrency benchmark.
- Open the current-schema migration probe read-only and document the exact
  mutation boundary for startup, schema migration, state, and skill commands.

## 1.1.0 - 2026-08-13

- Unify startup context, durable knowledge, advisory work presence, and
  cross-session handoff behind one `lodestar` executable and one JSON envelope.
- Add monotonic database and record revisions allocated inside every mutation
  transaction.
- Normalize Windows and WSL project paths and cross the Windows-owned one-shot
  runtime boundary from WSL.
- Preserve original direct-content and wrapped record forms through one
  universal output adapter.
- Replace specialized continuity persistence with typed universal records;
  schema-v2 migration drops its old tables only when all are empty.
- Include the Lodestar Codex plugin for one startup injection and the validated,
  redacted natural `handoff now` flow.
- Retire old service, discovery, successor-creation, and separate-suite runtime
  surfaces.
- Rebuild the GitHub and npm front page and publish the packed executable with
  cross-platform verification.
- Normalize WSL, MSYS, and Cygwin path arguments at the Windows process
  boundary, including `--db`, `--file`, and legacy import sources.
- Route WSL execution through `/init` so Lodestar remains available when a
  second distro changes the shared `WSLInterop` binary-format registration.
- Enforce the 16 KiB startup budget before transaction commit, cap oversized
  handoff heads, report exact omitted counts, and roll back an unreturned
  handoff claim.
- Make the complete test suite portable across Windows, Linux, and macOS
  fixtures under the required Node 24.15 runtime.

## 1.0.3 - 2026-07-31

- Put the central original-to-1.0 product comparison near the top of the
  GitHub and npm front page.
- Credit the original Lodestar for proving structured project context while
  explaining, in first person, why the reduced SQLite architecture is the
  stronger product for Lodestar's current job.
- Show the concrete reduction from custom generations, lifecycle machinery,
  installers, readiness claims, provider experiments, and multiple executables
  to one database, one CLI, direct facts, and provider-neutral JSON.
- Keep every runtime command, schema, database behavior, migration contract,
  package file, dependency boundary, and executable identical to 1.0.2.

## 1.0.2 - 2026-07-31

- Publish a clearer GitHub and npm front page with an honest product summary,
  direct install path, current verification badges, and the zero-setup first
  write contract above the fold.
- Add original launch hero and social-card artwork plus reusable announcement
  copy.
- Attach both launch graphics to the GitHub release alongside the exact npm
  tarball and checksums.
- Improve npm discovery metadata without adding dependencies, executables, or
  runtime behavior.
- Keep the database schema, storage behavior, CLI commands, migration contract,
  and all other runtime semantics identical to 1.0.1.

## 1.0.1 - 2026-07-31

- Remove the mandatory first-run setup step: the first structurally valid
  `lodestar put` now initializes an absent or resumable zero-byte database
  before writing.
- Keep invalid first writes, every read-only command, help, version, and
  deletion against a missing registry side-effect free.
- Reuse the existing exclusive reservation, bounded busy window, and SQLite
  transactions so overlapping first writers cannot replace the winning
  registry. Contention beyond that bound remains an explicit, retryable
  `database_busy` error.
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
