# Lodestar whole-system CodePlan2

Date: 2026-11-25. Model: CodePlan2 1.2.0, full decision scope. This plan covers adoption, ingress, data integrity and release. It is not approval to modify live records, enroll transcripts, install persistence, or publish a release.

## Goal and verified baseline

Agents get fresh, actionable project context without repetitive output or lifecycle coupling. Lodestar still runs at real work entry. When unavailable, only the operation that genuinely depends on its admission or guarded state stops. Keep one one-shot CLI, contract-5 envelopes, the universal record model, and one Windows-owned SQLite database. WSL/Linux clients use a supported owning route, not cross-OS writes to that file.

The installed 3.0.2 (contract 5, schema 6) matches b2024d561 for the six inspected core, writer, setup, receipt and migration assets. The local dirty Lodestar main at 4284d02 was 63 ahead/76 behind its remote ref at inspection and is not the installed release lineage. Treat its staged, unstaged, untracked work and other worktrees as Director WIP, not disposable. No whole-tree merge, reset, adoption claim or release from dirty main. Root machine help measured 142,809 bytes. Compact startup using the actual Windows store returned a 4,826-character JSON envelope in 1.625 s for this checkout; the sandbox-default database path returned database_not_found. This is one observed attempt, not a latency SLA.

## Mechanisms compared and selected

| Surface | Alternatives | Decision and why |
|---|---|---|
| Agent entry | Impose full startup every time; skip when slow; compact once | Always attempt installed Lodestar on real qualifying entry. Use compact if project pointers and next actions suffice. Full only when required instructions, actual admission, or write basis are needed. On failure finish independent work; preserve actual guards. No blanket retries. |
| Chat ingress | Embed daemon/SQLite writers; process all logs with a model; local opt-in companion | One-shot local review with explicit path/project bindings, cursor and short proposal retention. No listeners, no full transcript storage, no tool execution, no source discovery at startup, no auto-admission of a proposal. Keep it out of the installed runtime. |
| Storage | Auto-VACUUM/prune; rebuild DB; observe and reduce at writer/producer | Bounded file footprint read and existing doctor on a consistent copy. Benchmark producer-side no-op suppression and receipt retention before changing storage. Preserve replay and recovery semantics. |
| Durable context | Index every message as a knowledge record; keep less and preserve provenance | One logical record per supported change, bounded snippets with IDs/locations, append only when new evidence changes meaning. Keep duplicate, conflicting and unverified evidence out of authoritative state until reconciled. |
| Release | Replace installed build from dirty main; exact reconciliation and isolated packaging | Start from reviewed release ancestry and map WIP by ownership. Test and release only a clean integrated candidate and retain verified rollback. Separate native adoption from package install. |

## Dependency order and implemented slices

1. Identify installed versions, active worktree owners, current branch and holds; do not conflate them. Verified 3.0.2 compact is supported. The active Maxwell operating guide now uses one real startup at qualifying entry; if it fails, independent authorized work continues. Exact protected steps remain blocked without admission.
2. Add repository-side one-shot scan, status and proposal review. No foreground watch mode. Disposable fixtures cover Codex and the supported Claude final-marker shape, continuation, dedup, malformed/oversized inputs, rotation, checkpoints and retention. Use a source list and approved write policy before any real deployment; this slice intentionally does not add a runtime service.
3. Add read-only storage footprint sampling with the existing benchmark/doctor as distinct tools. Sample at deliberate baselines, not every agent startup. Do not give projections or database health claims when a live WAL or inconsistent header makes them unknowable.
4. Adopt the compact path by native harness with the slimmest command-specific guidance. Measure real command latency, bytes and required-project evidence with synthetic and real registered scope; do not bypass partial evidence checks. The installed compact implementation still selects and normalizes rows before truncation and performs intentionally repeated native membership checks. Profile selection/source costs before widening an optimization. Preserve evidence that instability is diagnosed and required context cannot silently disappear.

## Prevention at the owning boundaries

- **Bloat and repetition:** Define stable logical keys and compare normalized material fields at the producer, before creating new writes or receipts. Do not suppress confirmations that change meaning. Distinguish receipt replay identity (permanent request fence) from disposable presentation or candidate retention. Test rejected/stale/replayed writes on the same request IDs.
- **Growth:** Baseline retained DB + WAL + backups and archive bytes, bytes per 1,000 accepted writes, writer p95/worst contention, and cold-restore space. Verify counts and time budgets on disposable baseline/candidate. Inspect which table/index/receipt families are responsible on a protected SQLite snapshot only if cheap samples justify it. Never treat WAL rotation or free pages as permission to compact.
- **Corruption:** Use existing guarded transactions, request receipt reconciliation and schema checks. Separate format validation, integrity_check and recovery. Take a consistent protected backup and verify its restoring filesystem, checksum, schema, and independently sampled replay equivalence before real cutover. Do not copy a running DB file alone or delete WAL sidecars. Preserve post-snapshot accepted writes; a rollback without replay reconciliation can lose work.
- **Bad data:** Use strict typed payloads, scope, evidence locators and content caps. Treat transcript text as untrusted data. Reject malformed input, secrets, instruction-like tool output and unauthorized cross-project promotion at ingest; evaluate bounded human/source evidence before writing. Keep raw log bodies and tool payloads out of Lodestar.
- **Operational resilience:** No long work inside a SQLite writer lock. Keep expensive integrity scans away from startup. Prefer focused errors that give the next safe action; keep ordinary work moving when local context fails. Avoid broad compaction or new monitoring jobs unless a measured risk warrants them.

## Release and destructive-change stop conditions

No schema bump, data deletion, VACUUM or automatic promotion in this slice. Before future releases, reconcile published and installed lineage, prove package and source-hash parity, and exercise clean/repeat install, upgrade, rollback and real first use independently on applicable Windows/WSL/Linux harnesses. A disabled/offline path is not an adoption pass. The disposable benchmark plus playback tests must support any proposed retention loss or cleanup. Never apply a new policy on live records without the exact approved scope and recovery evidence.

Files: tools/chat-evidence/README.md; docs/storage-footprint.md; scripts/benchmark-disposable.mjs; reviewed lineage docs/client-deployment.md. Project-owned records still flow through the Lodestar writer; the private work ledger owns execution and handoff.

## November 27 reconciliation

Storage sampling and one-shot chat-evidence review now have a source-only path and synthetic tests. No chat watcher, live transcript enrollment, or write-back is enabled. The native hook review and checkpoint policy are in [the native adapter guide](../../native-codex/README.md).
