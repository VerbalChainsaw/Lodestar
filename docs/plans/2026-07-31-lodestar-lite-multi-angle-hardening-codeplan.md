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
- core and per-file source-line limits;
- one executable, one runtime database, and no removed runtime framework.

## Explicit non-scope

This work does not restore generations, custom locks, snapshots, installers,
provider behavior, orchestration, benchmarks, readiness scoring, or another
executable. It does not turn same-user local files into a hostile-process
security boundary. Ambiguous policy questions about salvaging unsealed legacy
generations remain documented limitations unless concrete evidence requires a
different migration contract.
