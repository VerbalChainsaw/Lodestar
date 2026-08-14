[codeplan · managed-skills-transaction · IN · mode: full · confidence: high · candidates: V1 sequential compensation+list-compensate, V2 two-phase batch+two-phase-stage, V3 durable recovery+external-journal, V4 root generations+root-swap · lean: V2 · baseline: V1]

# Managed skills transaction decision

## Evidence and contract

An induced failure at the Hermes target returned `skills_write_failed` after all
six Codex and all six Claude skills had already been installed. This contradicts
the documented single managed transaction and makes retry/recovery ambiguous.
The repair must preserve unrelated skills, existing backups, one-shot execution,
Windows/WSL path behavior, and the current CLI/envelope. It must add no service,
database, dependency, or quality-threshold change.

## Variants and hard gates

- V1 `list-compensate`: keep sequential staging and append an undo action after
  each successful rename. On an ordinary failure, undo in reverse order.
  `G: pass`; it fixes caught failures but starts mutation before all inputs are
  proven stageable.
- V2 `two-phase-stage`: resolve and preflight the complete batch, stage every new
  directory before mutation, then commit renames while recording exact reverse
  operations. Removal uses reversible quarantine until the batch succeeds.
  `G: pass`.
- V3 `external-journal`: persist a crash-recovery transaction log and replay it
  on later invocations. `G: fail` because it introduces a second recovery/state
  subsystem forbidden by repository governance.
- V4 `root-swap`: construct and atomically swap complete client skill roots.
  `G: fail` because the roots contain unrelated user-owned skills and span
  independent client locations.

The passing variants differ in control flow and mutation timing: V1 mutates
while discovering work; V2 carries a precomputed staged action list and does not
touch a destination until the whole batch is ready.

## Frozen rubric

Rubric frozen: axes [Style, One-shot boundary, Transactional correctness,
Cross-client portability, Error semantics, Testability, Blast radius] · weights
[1,3,3,2,2,2,1] · denominator = 70 · denominator-policy [uniform-N/A-only] ·
baseline-algo [lowest-effort gate-passer with no score of 1 on any quality axis]

`freeze: axes=Style,One-shot boundary,Transactional correctness,Cross-client portability,Error semantics,Testability,Blast radius weights=1,3,3,2,2,2,1 denom=ΣW×5 baseline=lowest-effort-gate-passer`

## Scoring

| Axis | W | V1 list-compensate | V2 two-phase-stage |
|---|---:|---:|---:|
| Style | 1 | 4 | 4 |
| One-shot boundary | 3 | 5 | 5 |
| Transactional correctness | 3 | 3 | 5 |
| Cross-client portability | 2 | 3 | 4 |
| Error semantics | 2 | 4 | 5 |
| Testability | 2 | 4 | 5 |
| Blast radius | 1 | 5 | 3 |
| Effort | - | medium | medium |
| Weighted total | - | 55/70 = 0.786 | 65/70 = 0.929 |

Arithmetic: V1 = `4+15+9+6+8+8+5 = 55`; V2 =
`4+15+15+8+10+10+3 = 65`; denominator = `(1+3+3+2+2+2+1)*5 = 70`.
V1 is the baseline because it is the lower-change gate-passer with no quality
score of 1. V2 wins because staging the entire batch closes the proven partial
write window before any destination changes.

[codeplan · managed-skills-transaction · OUT · mode: full · pick: V2 · confidence: high · beatBaseline: yes · scores: V1 0.786, V2 0.929 · reason: complete pre-staging plus reverse compensation closes the confirmed partial-write path without a new subsystem · mechanism-check: passed · corrected: compacted within the same mechanism to preserve the unchanged 5,200-line gate]
