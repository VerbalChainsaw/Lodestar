# Unified Lodestar repair and release codeplan

## Decision

Ship one suite named **Lodestar** with one public command family:

```text
lodestar start|get|find|links|put|work|handoff
lodestar skills install|sync|verify|remove
```

The current universal-record implementation remains the persistence mechanism.
This tranche repairs its compatibility seams, proves the installed Windows and
WSL paths, consolidates active agent guidance, and publishes the resulting
package. It does not add a daemon, a second database, a second executable, or a
compatibility launcher under an old product name. The external release cutover
is separate from this locally installed integration tranche.

## Absorption inventory

- Six managed skill trees: director protocol, Codeplan, multigeometry,
  Center Audit, Ladder Audit, and Lodestar.
- AGENTS, CLAUDE, SOUL, project, and stub templates bundled as native Lodestar
  skill assets rather than a second template installer.
- Install, sync, replacement backup, root migration, verification, and removal
  behavior generated from `managed-assets/` into the published runtime payload.
- Windows Codex, Windows Hermes, WSL Codex, and WSL Hermes client roots, with
  Linux-local staging for WSL atomic replacement.

## Compatibility mapping

| Retired surface | Lodestar operation |
| --- | --- |
| Keel install / update | `lodestar skills install` / `lodestar skills sync` |
| Keel verify / uninstall | `lodestar skills verify` / `lodestar skills remove` |
| Keel templates | Lodestar skill `assets/templates/` |
| Glimpse status / start / done / history | `lodestar work status|start|done|history` |
| Standalone handoff validation / store | `lodestar handoff validate|save|status|clear` |
| Context Buddy start / project | `lodestar start` |
| Context Buddy get / resolve | `lodestar get` |
| Context Buddy find / doctor / put | `lodestar find|doctor|put` |

AgentLink retains only the deprecated `context_buddy_*` MCP names required for
compatibility. Each alias directly calls the corresponding Lodestar controller
method. AgentLink health exposes one Lodestar capability and runs one read-only
`lodestar doctor`; it has no controller or durable state for the retired tools.

## Retirement gate

Only after package, plugin, WSL, client-sync, and AgentLink checks pass:

- retire separate launchers and stores;
- remove standalone handoff skill roots;
- move historical product repositories intact to the cutover backup so dirty
  work remains recoverable;
- retain no active client config or model-facing skill instruction that invokes
  an old command.

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
7. Build and install the dependency-free npm tarball locally. Do not publish or
   cut an external release until that separate cutover is authorized.

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

## Implementation status — 2026-08-13

Implemented and locally installed. The complete Lodestar suite, AgentLink suite,
packed-artifact startup/handoff/client checks, plugin transports on Windows and
WSL, four requested client sync/verify paths, and real AgentLink doctor health
all passed. The live database hash and timestamp were unchanged across the
read-only health proof. No external package publish or release cutover occurred.
