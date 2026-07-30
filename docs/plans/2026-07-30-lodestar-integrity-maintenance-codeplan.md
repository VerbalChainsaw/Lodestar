# Codeplan: Lodestar integrity and maintenance

> Historical implementation record. The v0.6 release audit superseded its
> purge and no-op migration surfaces and replaced its earlier execution claim
> with the focused [v0.6 trust-recovery codeplan](2026-07-30-lodestar-v0.6-trust-recovery-codeplan.md).

## Contract and safety

- Required behavior: add deep integrity verification, durable writes, resource
  bounds, portable snapshot/restore, bounded retention, scheduler-friendly
  maintenance, schema migrations, source-drift detection, and fault-injection
  proof.
- Acceptance criteria: all mutations remain validated, atomic, audited,
  zero-dependency, Windows/WSL compatible, and machine-readable.
- Must preserve: JSON/JSONL canonical state, immutable generations, current
  CLI behavior, existing state homes, scoped reads, and the no-daemon design.
- Out of scope: database adoption, cloud synchronization, watchers, source
  ingestion, automatic curated-record mutation, release publication.
- Workspace/user work: clean `main` matching `origin/main` before edits.
- Pre-change checks: 158/158 tests passed in 4.27 seconds.

## Repository evidence

- `lib/generation.mjs` validates and builds a full immutable generation before
  atomically promoting `current.json`.
- `lib/write-lock.mjs` provides a multi-reader/single-writer directory lock
  with nonce, PID, hostname, runtime, heartbeat, and conservative stale-lock
  reclamation.
- `lib/doctor.mjs` structurally validates every retained generation.
- The live 71-project store held 16 generations in 25 MiB; full doctor took
  8.53 seconds and 135,596 KiB peak RSS.
- Runtime is Node.js 22+, with no production dependencies.

## Mode

- Candidate mode: full
- Candidate count: 3
- Record profile: forensic

## Candidates

- V1 `new-module/zero-dep/transactional/backward-compatible`: add optional
  integrity manifests to new generations, deep verification for all
  generations, isolated lifecycle modules, and explicit maintenance commands.
- V2 `format-v2/mandatory-migration/transactional`: require a new generation
  format and migrate every existing state home before use.
- V3 `object-store/copy-on-write/garbage-collected`: replace complete
  generations with content-addressed blobs and small manifests immediately.

## Divergence

- V1↔V2: V1 upgrades existing stores lazily; V2 creates an immediate
  compatibility and rollback boundary.
- V1↔V3: V1 bounds current write amplification through retention; V3 replaces
  the proven persistence mechanism before measurements require it.
- V2↔V3: V2 retains full generations; V3 changes physical ownership, sharing,
  and garbage-collection semantics.

## Paper gates

- V1: passes task fulfillment, compatibility, data integrity, cross-platform,
  transaction safety, verification feasibility, and zero-dependency gates.
- V2: passes fulfillment and integrity gates, but has a materially larger
  rollout and rollback surface.
- V3: passes fulfillment and scale gates, but adds unnecessary ownership and
  garbage-collection complexity at the currently demonstrated scale.

## IN

`[codeplan · lodestar-integrity-maintenance · IN · mode: full · profile: forensic · confidence: high · candidates: V1=backward-compatible layered integrity modules/zero-dep/transactional;V2=mandatory store-v2 migration/manifest-required/transactional;V3=content-addressed object store/copy-on-write/garbage-collected · lean: V1 · conservative: V1]`

## Frozen rubric and scoring

Axes, classes, and weights:

| Axis | Class | Weight | V1 | V2 | V3 |
|---|---|---:|---:|---:|---:|
| Data integrity | quality | 3 | 5 | 5 | 5 |
| Architecture fit | quality | 3 | 5 | 4 | 2 |
| Compatibility/reversibility | risk | 3 | 5 | 3 | 2 |
| Verifiability | quality | 2 | 5 | 4 | 3 |
| Lifecycle scalability | quality | 2 | 4 | 4 | 5 |
| Maintenance burden | convenience | 1 | 4 | 3 | 1 |

- Frozen denominator: `70`
- Arithmetic verification: V1 `67/70=0.957`; V2 `55/70=0.786`; V3
  `44/70=0.629`.
- Formal baseline: V1, the lowest-effort eligible gate passer.
- Selection stability: V1 leads by more than 0.05 with no unknown axis.

## PLAN-OUT

`[codeplan · lodestar-integrity-maintenance · PLAN-OUT · mode: full · profile: forensic · pick: V1 · baseline: V1 · confidence: high · beatBaseline: baseline-wins · scores: V1=0.957;V2=0.786;V3=0.629 · reason: Optional integrity manifests and isolated lifecycle modules add deep verification and bounded maintenance without forcing migration of existing healthy stores or replacing the proven JSON/JSONL engine. · planned-fingerprint: new-module/zero-dep/transactional/backward-compatible/fail-closed]`

## Planned implementation and evidence

- Add bounded validation before record, catalog, graph, and index construction.
- Seal new generations with a deterministic integrity manifest and synchronize
  staged data before pointer promotion.
- Extend doctor with optional deep hash/index verification.
- Add verified snapshot and restore-to-empty-home operations.
- Add dry-run-first maintenance, explicit retention, audit rotation, and
  source-drift reporting.
- Add an explicit migration registry and dry-run/apply command.
- Exercise transaction failures, corruption, resource exhaustion, restore,
  retention, drift, migration, CLI JSON, packaged execution, and performance.

## EXEC-OUT

`[codeplan · lodestar-integrity-maintenance · EXEC-OUT · implemented: V1 · confidence: high · verification: passed · mechanism-check: passed · plan-history: unchanged · corrected: Windows file synchronization changed from read-only to read/write handles after native proof; retention now prefers valid recovery points and snapshot/migration races fail closed · evidence: 169/169 WSL tests; 168 pass plus one expected symlink skip on Windows; packed snapshot/restore/maintain/migrate/deep-doctor smoke; 500-project performance gate passed; live 71-project deep verification passed]`

Implemented:

- deterministic generation integrity manifests and deep semantic doctor checks;
- cross-platform file and directory durability barriers;
- versioned resource budgets;
- portable snapshot verification and restore-to-new-home;
- dry-run-first retention, quarantine, audit rollover, and drift status;
- sequential snapshot-backed migration infrastructure;
- corruption, power-loss, copy-failure, rollback, drift, migration, package,
  and platform regression coverage.

Pre/post:

- Pre-change: 158/158 WSL tests passed.
- Post-change: 169/169 WSL tests passed; native Windows passed 168 with one
  expected symlink skip.
- Packed package: all six new modules and maintenance documentation included;
  installed artifact completed init, snapshot, verify, restore, maintain,
  migration preview, and deep doctor.
- Performance: 500-project paired benchmark retained 4/4 answer parity, no
  broad search, zero cross-project records, 98.63% fewer inspected bytes, and
  32.55% median elapsed-time reduction in the final local run.
- Live store: active generation passed deep verification; one inactive legacy
  generation with an index-content mismatch was correctly excluded from valid
  recovery points. No live generation was promoted or quarantined.
