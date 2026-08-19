[codeplan · canonical-golden-governance · IN · mode: full · confidence: high · candidates: V1 structured asset+generator asset-structured, V2 embedded Markdown text-embedded, V3 registry authority registry-canonical, V4 parsed Markdown markdown-parsed · lean: V1 · baseline: V2]

# Canonical Golden Rules governance

## Calibration

- Repository theme: one durable authority, one-shot startup, generated managed payloads, deterministic bounded JSON.
- Methodology: preserve WIP, extend the existing managed-assets builder, avoid adjacent systems, verify the exact startup contract.
- Hard rules: no competing store, no quality-gate weakening, no dependency addition, no unrelated WIP edits, no commit without authority.
- Representative source: `managed-assets/governance.json`, `scripts/build-managed-assets.mjs`, `src/bootstrap.mjs`, `src/agent-state.mjs`, and their focused tests.

## Variants and hard gates

- V1 `asset-structured`: represent the doctrine as structured sections and clauses in the existing governance JSON; extend the existing builder to render the recovery Markdown and generated runtime payload. `G: pass`.
- V2 `text-embedded`: store one Markdown/prose blob inside the governance JSON and copy it into both runtime and docs. `G: pass`.
- V3 `registry-canonical`: keep the registry instruction as the full doctrine and reduce the package rule to a bootstrap pointer. `G: fail` — violates the package-owned required source and makes startup correctness depend on mutable registry state.
- V4 `markdown-parsed`: make the Markdown canonical and parse it into the governance record during generation. `G: fail` — violates the requested machine-readable canonical source and adds a fragile parser contract.

Rubric frozen: axes [Style, Theme, Methodology, Modernization, Error wrapping, Testability, Blast radius] · weights [1,2,2,2,2,2,1] · denominator = 60 · denominator-policy [uniform-N/A-only] · baseline-algo [lowest-effort gate-passer with no score of 1 on any quality axis]

`freeze: axes=Style,Theme,Methodology,Modernization,Error wrapping,Testability,Blast radius weights=1,2,2,2,2,2,1 denom=60 baseline=lowest-effort-gate-passer`

## Scoring

| Axis | W | V1 asset-structured | V2 text-embedded |
| --- | ---: | ---: | ---: |
| Style | 1 | 5 | 4 |
| Theme/paradigm | 2 | 5 | 4 |
| Methodology | 2 | 5 | 4 |
| Modernization | 2 | 5 | 3 |
| Error wrapping | 2 | 4 | 4 |
| Testability | 2 | 5 | 4 |
| Blast radius | 1 | 4 | 5 |
| Effort | - | medium | low |
| Weighted total | - | 57 | 47 |
| Normalized | - | 0.950 | 0.783 |

Arithmetic: V1 = `5 + 10 + 10 + 10 + 8 + 10 + 4 = 57`; V2 = `4 + 8 + 8 + 6 + 8 + 8 + 5 = 47`; denominator = `(1+2+2+2+2+2+1)×5 = 60`.

## Decision

V1 wins. It makes the source genuinely machine-readable, reuses the existing generation path, makes runtime and recovery views mechanically inseparable, and keeps all authority in the package-owned record. V2 is the baseline because it is lower effort, but it preserves a second prose-parsing burden for agents and makes clause-level validation weak.

[codeplan · canonical-golden-governance · OUT · mode: full · pick: V1 · confidence: high · beatBaseline: yes · scores: V1 0.950, V2 0.783 · reason: one structured package source generates both runtime and recovery views · mechanism-check: passed · corrected: none]
