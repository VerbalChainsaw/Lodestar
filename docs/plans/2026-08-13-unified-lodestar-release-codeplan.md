# Unified Lodestar repair and release codeplan

## Decision

Ship one suite named **Lodestar** with one public command family:

```text
lodestar start|get|find|links|put|work|handoff
```

The current universal-record implementation remains the persistence mechanism.
This tranche repairs its compatibility seams, proves the installed Windows and
WSL paths, consolidates active agent guidance, and publishes the resulting
package. It does not add a daemon, a second database, a second executable, or a
compatibility launcher under an old product name.

## Frozen rubric

| Axis | Weight | Measurement |
| --- | ---: | --- |
| Data and concurrency safety | 0.25 | Preserves existing records and assigns mutations inside the existing transaction boundary |
| Behavioral compatibility | 0.20 | Existing record forms and the absorbed work/handoff functions remain readable and operable |
| Single-suite consistency | 0.20 | Active CLI, skills, hooks, and instructions use only Lodestar vocabulary |
| Cross-platform operability | 0.15 | Windows and WSL resolve one project and reach the same installed product |
| Regression risk | 0.10 | Small change surface with focused tests and the complete suite |
| Packaging and maintenance | 0.10 | One dependency-free npm package and the existing release pipeline |

Hard gates: preserve the live database; preserve the current dirty worktree;
keep one SQLite store; keep one executable; keep one-shot execution; do not
weaken tests; do not revive retired services or launchers.

## Variants

### V1 — Boundary adapters in the existing core (selected)

Add narrow canonical adapters where old record content and cross-dialect paths
enter the universal envelope. Make startup initialize an absent disposable
registry through the existing safe reservation path. Extend doctor and focused
tests at those same seams. Keep all domain mutations in the existing universal
record transaction core. Update active guidance and plugin text to call the
same Lodestar commands, then package through the existing npm/tag workflow.

Mechanism class: internal reuse plus extracted helpers.

### V2 — Rewrite stored legacy records into the new shape

Transform every old direct-content record in the live database and preserve
only the new wrapper shape. This makes current reads simpler but mutates
authoritative data, cannot protect future imported legacy records, and expands
the repair into another data migration.

Mechanism class: migration transform.

Hard-gate result: **fail**. It changes live durable data when a read-boundary
adapter is sufficient.

### V3 — Add a parallel compatibility schema and command facade

Keep old and new record shapes in separate tables and expose old command names
as wrappers around the new product. This retains legacy vocabulary but creates
another durable representation and makes the supposed single suite visibly
fragmented.

Mechanism class: new module, new schema, compatibility facade.

Hard-gate result: **fail**. It adds a durable store shape and multiple public
interfaces contrary to the approved architecture.

## Scoring

Only V1 passes all hard gates.

| Variant | Safety | Compatibility | Consistency | Cross-platform | Regression | Packaging | Weighted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 | 0.95 | 0.92 | 0.95 | 0.90 | 0.88 | 0.95 | **0.932** |

Baseline comparison: leaving the current implementation untouched scores lower
because valid pre-1.1 records can fail `get`/`find`, first-run startup is not
self-initializing, and active guidance still advertises retired product names.

## Repair contract

1. Normalize both supported content forms through one read adapter without
   rewriting stored records.
2. Normalize Windows and WSL absolute paths before host-specific resolution.
3. Let `start` and handoff mutations safely create the one database through the
   existing reservation/schema path.
4. Keep `work` and handoff writes atomic universal-record mutations with
   database revisions assigned in their transaction.
5. Preserve `get`, `find`, `links`, and `put` behavior and envelope consistency.
6. Replace active old-suite instructions with Lodestar syntax; keep old stores
   only as inert rollback material.
7. Publish the dependency-free npm tarball as the executable release asset via
   the existing cross-platform workflow.

## Verification gate

- Focused compatibility, path, first-run, work, and handoff tests.
- Complete test suite with no lowered threshold and restored coverage for
  removed behavior.
- `npm run pack:check`, install the tarball, and exercise every public command.
- Native Windows and WSL smoke tests against disposable state.
- Exact Codex CLI and Desktop plugin registration/readback.
- Active-instruction search proving old product command names are absent.
- Regression Scout checks across adjacent success, error/config, installed
  consumers, and built artifacts.
