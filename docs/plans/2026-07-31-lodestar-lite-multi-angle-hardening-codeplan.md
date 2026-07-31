# LodestarLite multi-angle hardening codeplan

Date: 2026-07-31

Branch: `LodestarLite`

Audited commit: `7317598c23d123307325968e29f1ca81c2c1ed91`

Baseline: `main` at `27d61c3c71ed1896b6ef0828e446bf959f96221f`

## Purpose

This plan closes eight defects independently reproduced after the initial
LodestarLite reduction was committed. The audit used persistence, interface,
legacy-migration, and package lenses. Repairs remain inside the existing
one-database, one-executable architecture.

Every repair follows the same gate:

1. add a focused regression that fails against the audited commit;
2. make the smallest production change that restores the stated invariant;
3. rerun the focused test and its surrounding subsystem tests;
4. commit the coherent repair cluster;
5. finish with the complete test, coverage, package, installed-artifact,
   read-only, and source-shape gates.

## Confirmed defects and repair contracts

| ID | Severity | Defect | Smallest safe repair |
| --- | --- | --- | --- |
| H-01 | high | Schema and doctor queries use SQL `LIKE 'sqlite_%'`; `_` is a wildcard, so a non-internal object such as `sqlitehidden` escapes validation. | Exclude only the literal, case-insensitive `sqlite_` namespace and make the test oracle independent of the production predicate. |
| H-02 | medium | The public `runCli` boundary trusts a thrown object's `name`, accepts a non-string error code, and can emit unbounded forged error fields before throwing again. | Recognize only errors constructed by this module, bound the final envelope, and make exit-code classification total for arbitrary thrown values. |
| H-03 | medium | `find --type` and `find --scope` use the generic 512-byte query validator, accepting filters that no stored record can possess. | Validate each filter with the same validator used by its stored field. |
| H-04 | medium | String chunks passed to streaming JSON input allow JavaScript's UTF-8 encoder to replace unpaired UTF-16 surrogates. | Reject unpaired surrogates while allowing a valid pair split across adjacent string chunks; keep byte-stream behavior unchanged. |
| H-05 | medium | A generated legacy ID can consume an identifier that belongs to a later valid source record. | Reserve every valid original ID before allocating generated or duplicate IDs. The first valid occurrence retains its source ID. |
| H-06 | medium | The legacy reader validates `current.json.generation` but not the v0.7 pointer version. | Require `current.json.v === 1`, matching the retired v0.7 writer and reader contract. |
| H-07 | medium | Valid locator-health observations not referenced by any imported locator disappear without an imported, skipped, or unsupported report entry. | Report every residual locator-health key as bounded unsupported evidence; do not synthesize source rows. |
| H-08 | low | The shipped README contains a relative link to an architectural report omitted from the package. | Remove the artifact-relative dependency and test every packaged Markdown relative link against the package manifest. |

## Post-repair challenge findings

The first repair set was committed and then challenged again through the same
persistence, interface, and migration lenses. Five adjacent defects reached
independent terminal reproductions at commit `86d3306`:

| ID | Severity | Defect | Smallest safe repair |
| --- | --- | --- | --- |
| H-09 | high | A trigger renamed into the literal `sqlite_` namespace through SQLite's writable-schema escape hatch is treated as internal; open and doctor can accept executable corrupt schema. | Ignore only exact, inert SQLite-maintained statistics-table definitions. Treat every other reserved-prefix row as an unexpected schema object. |
| H-10 | medium | Empty yielded stdin chunks bypass the declared chunk-count limit, and oversized string/typed chunks are copied before their prospective byte size is rejected. | Count every yielded chunk before conversion and reject prospectively oversized chunks before materializing a copy. |
| H-11 | medium | Arrays and non-byte typed arrays are silently coerced and truncated by `Buffer.from`, allowing byte values the caller did not supply to become accepted JSON. | Accept only strings, Buffer, and byte-exact Uint8Array chunks; reject every other chunk representation. |
| H-12 | medium | A genuine Lodestar error's mutable code is sampled once for JSON and again for exit classification, so the two machine signals can disagree. | Normalize one bounded error snapshot and derive both the envelope and exit status from that snapshot. |
| H-13 | high | Duplicate source IDs can attach one locator-health observation to multiple records; non-string IDs can attach an observation while reporting it `not_imported`. | Normalize the legacy key once, attach health only when exactly one candidate owns it, and report ambiguous, orphan, or imported evidence exactly once. |

The follow-up also rechecked source-file additions and same-content parent-path
replacement during import. Those remain explicit nonfindings: the documented
fingerprint covers the accepted source-file set, and same-user replacement
without changed accepted bytes is outside Lodestar's filesystem trust
boundary. Expanding that policy would add a bounded re-enumeration subsystem
without changing imported data.

## Final repaired-head challenge findings

The committed second repair set was challenged once more at `098d5f8`. Five
additional defects reached deterministic terminal reproductions:

| ID | Severity | Defect | Smallest safe repair |
| --- | --- | --- | --- |
| H-14 | high | A process that reserved a new zero-byte destination could delete a valid database committed by another initializer or importer that resumed the visible reservation. | Never unlink a published reservation during failure cleanup. Preserve it for safe zero-byte resumption, and make a losing initializer recognize a concurrently completed valid database. |
| H-15 | medium | The importer classified every `COMMIT` exception as an unknown outcome, even when SQLite still reported an active transaction and rollback made the failure definite. | Use SQLite transaction state to distinguish definite pre-commit failure from post-commit ambiguity; preserve only genuinely ambiguous destinations. |
| H-16 | medium | `doctor` could report `healthy: true` for stored values that public reads rejected, including non-NFC schema fields and JSON beyond the structural-depth limit. | Apply the same bounded application validators to stored records, aliases, links, and sources during diagnosis. |
| H-17 | medium | `find` and `links` validated a summarized record's update timestamp but silently accepted an invalid creation timestamp in the same stored row. | Select and validate both record timestamps before emitting any summary. |
| H-18 | medium | A uniquely owned locator-health observation was treated as accounted for before its source and record survived conversion, so candidate rejection, invalid locators, duplicate origins, source limits, or metadata compaction could erase the evidence without a report entry. | Mark health evidence consumed only after it is retained on a source in an accepted record; report every other unique key once as `not_imported`. |

H-14 was reproduced with a forced but ordinary interleaving: process A
reserved and opened the destination, process B resumed and committed it, then
process A's failure cleanup unlinked B's healthy database. H-15 left a
zero-byte destination while claiming an unknown commit even though
`db.isTransaction` proved that the commit had not occurred. H-16 and H-17 used
schema-valid direct row changes and observed contradictory doctor/read
outcomes. H-18 was independently reproduced at both conversion and committed
import boundaries.

## Repair sequence

### 1. SQLite schema-object validation

Add a non-internal `sqlitehidden` trigger directly through SQLite. Prove that
both database open and `doctor` reject it. Change only schema enumeration;
schema version and DDL remain unchanged.

### 2. Machine interface boundaries

Add regressions for a forged thrown error, an impossible 65-byte type filter,
a lone surrogate in a string stream chunk, and a valid astral character split
across two string chunks. Repair error provenance, field validation, field
bounds, filter validators, and streaming UTF-16 handling without enlarging the
CLI dispatcher.

### 3. One-way v0.7 import

Add fixtures for a generated-ID collision with a later valid original ID, a
pointer with `v: 2`, and an orphan locator-health entry. Reserve identifiers,
reject the unsupported pointer contract, and account for residual evidence.
The old store remains read-only and no dual-write or compatibility runtime is
introduced.

### 4. Package closure and durable records

Remove the broken packaged link and add an artifact-manifest link check. Extend
the adversarial audit with the eight findings, update measured verification
figures, and update the canonical Lodestar context records only after all
gates pass.

### 5. Post-repair boundary closure

Add failing regressions for reserved-prefix schema corruption, empty and
non-byte stream chunks, changing genuine error codes, duplicate locator-health
ownership, and non-string legacy identifiers. Admit only inert exact SQLite
statistics tables, enforce a byte-exact stdin contract, normalize caught
errors once, and select locator health through one shared ownership map.

### 6. Final repaired-head closure

Add deterministic interleaving tests for initialization and import, injected
pre- and post-commit failures, direct stored-semantic violations, invalid
summary timestamps, and locator-health evidence that fails to reach a
committed source. Remove destructive reservation cleanup, classify commit
truth from SQLite state, share stored-value validators with doctor, validate
complete summary rows, and finalize health accounting only after record
acceptance.

## Verification matrix

- focused red/green regression for every finding;
- complete tests on the declared Node.js baseline;
- coverage collection with no test failures;
- syntax checks for runtime and tests;
- `git diff --check`;
- dependency tree and package manifest inspection;
- two independent deterministic package builds;
- installed-tarball execution of all public commands and help contracts;
- database hashes unchanged across read-only commands;
- v0.7 dry-run and committed import with source-tree hashes unchanged;
- forced concurrent reservation interleavings that preserve the winner;
- definite and ambiguous import commit-failure classification;
- doctor/read agreement for every stored semantic validator;
- exactly-once locator-health accounting after skipped conversion paths;
- core and per-file source-line limits;
- one executable, one runtime database, and no removed runtime framework.

## Explicit non-scope

This work does not restore generations, custom locks, snapshots, installers,
provider behavior, orchestration, benchmarks, readiness scoring, or another
executable. It does not turn same-user local files into a hostile-process
security boundary. Ambiguous policy questions about salvaging unsealed legacy
generations remain documented limitations unless concrete evidence requires a
different migration contract.
