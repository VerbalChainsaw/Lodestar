[codeplan · always-on-governance · IN · mode: full · confidence: high · candidates: V1 persisted seed external-store, V2 generated projection rename-compensation, V3 client hook runtime-injection, V4 duplicated policy file-rewrite · lean: V2 · baseline: V4]

## Calibration

Lodestar is a zero-dependency, one-shot Node CLI with a generated managed-assets
payload, deterministic JSON envelopes, bounded startup output, explicit client
roots, and rename-based compensating transactions. Repository rules forbid a
daemon, Codex hooks, direct WSL database access, compatibility products, and any
quality-gate change. This tranche must not mutate the live database and must
preserve the existing 5,200-line runtime gate.

Quality axes use the repository's actual constraints: compact existing style,
one-package/one-shot architecture, scope and WIP discipline, current Node 24
facilities without new dependencies, typed Lodestar errors with reversible
writes, disposable testability, and bounded blast radius.

## Variants and hard gates

- **V1 — persisted seed / external-store.** Insert or migrate a required global
  governance row into every database and install client bootstrap files.
  `G: fail` — violates the explicit no-live-database-mutation constraint and
  makes package policy depend on per-database migration state.
- **V2 — generated projection / rename-compensation.** Keep one canonical
  harness-neutral governance source in `managed-assets`, generate a small runtime
  payload plus the Director skill reference and client bootstrap block, prepend
  the package-owned required record in `lodestar start`, and transact bootstrap
  files in the existing staged rename/rollback batch.
  `G: pass` — no new dependency, no database write, one package boundary, and
  reversible client adoption.
- **V3 — client hook / runtime-injection.** Inject policy through Codex or client
  lifecycle hooks and leave `lodestar start` unchanged.
  `G: fail` — Lodestar explicitly forbids Codex hooks, Hermes would not share the
  mechanism, and AgentLink/startup projections would still omit governance.
- **V4 — duplicated policy / file-rewrite.** Hard-code one startup record in
  runtime code and separately hard-code marked instruction blocks and the
  Director skill text.
  `G: pass` — functionally viable and small, but three independently maintained
  copies can drift and verification cannot prove common provenance.

## Frozen rubric

Rubric frozen: axes [Style, Theme, Methodology, Modernization, Error wrapping, Testability, Blast radius] · weights [1,2,2,2,2,2,1] · denominator = Σ(weights) × 5 · denominator-policy [uniform-N/A-only] · baseline-algo [lowest-effort gate-passer with no score of 1 on any quality axis]

freeze: axes=Style,Theme,Methodology,Modernization,Error wrapping,Testability,Blast radius weights=1,2,2,2,2,2,1 denom=ΣW×5 baseline=lowest-effort-gate-passer

## Scoring

Only gate-passing variants are scored.

| Axis | W | V2 generated projection | V4 duplicated policy |
| --- | ---: | ---: | ---: |
| Style | 1 | 4 | 4 |
| Theme/paradigm | 2 | 5 | 3 |
| Methodology | 2 | 5 | 3 |
| Modernization | 2 | 4 | 3 |
| Error wrapping | 2 | 5 | 3 |
| Testability | 2 | 5 | 4 |
| Blast radius | 1 | 4 | 5 |
| Effort | - | medium | low |
| Weighted total | - | 56 | 41 |
| Denominator | - | 60 | 60 |
| Normalized | - | 0.933 | 0.683 |

Arithmetic: V2 = `4 + 10 + 10 + 8 + 10 + 10 + 4 = 56`; V4 =
`4 + 6 + 6 + 6 + 6 + 8 + 5 = 41`; denominator =
`(1+2+2+2+2+2+1)×5 = 60`. Both use the same axes.

## Decision

V4 is the algorithmic baseline: lowest effort and no quality-axis score of 1.
V2 wins because generated common provenance is the only gate-passing mechanism
that prevents drift while retaining the existing reversible transaction model.
Implementation must remain `generated-payload + rename-compensation`; a move to
database seeding, hooks, or independent policy copies requires replanning.

[codeplan · always-on-governance · OUT · mode: full · pick: V2 · confidence: high · beatBaseline: yes · scores: V2 0.933, V4 0.683 · reason: one generated provenance feeds startup, skill, and marked client files without database mutation · mechanism-check: passed · corrected: none]
