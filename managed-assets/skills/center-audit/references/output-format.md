# CENTER-AUDIT: Final Output Format

Use this format for the final human-readable report. Keep evidence IDs stable throughout.

```text
CENTER-AUDIT RESULT: DEFECT_CONFIRMED | NO_DEFECT_CONFIRMED | INCONCLUSIVE

CASE FILE:
  Mode:             INTERACTIVE | AUTONOMOUS | CI
  Repository root:  [path or N/A]
  Target revision:  [commit/workspace/build/release]
  Baseline:         [merge base/known-good/HEAD/N/A]
  Workspace state:  CLEAN | DIRTY | NON-GIT | UNKNOWN
  Package/service:  [owner]
  Environment:      [relevant runtime/config]

CLAIM:
  Observation:        [actual behavior]
  Expected invariant: [required behavior]
  Audited claim:      [C0 or pivoted claim]
  Center kind:        LINE | SYMBOL | EDGE | STATE | EVENT | GENERATED | PAIRED
  Center anchor:      [stable anchor]
  Falsifier:          [what would disprove the claim]
  Pivots:             [none or P1/P2 summary]

FUSION:
  Likelihood:      CERTAIN | LIKELY | POSSIBLE | UNLIKELY
  Impact:          CATASTROPHIC | HIGH | MEDIUM | LOW
  Confidence:      HIGH | MEDIUM | LOW
  Reproducibility: DETERMINISTIC | INTERMITTENT | NOT_REPRODUCED | NOT_APPLICABLE
  Root cause:      [mechanism, or N/A]
  Terminal impact: [boundary consequence, or N/A]

EVIDENCE LEDGER:
  E1 [CHANNEL/strength] [stable anchor]
     Method: [how obtained]
     Result: [direct observation]
     Relation: SUPPORTS | CONTRADICTS | CONTEXT | ABSENCE
     Independence group: [group]
  E2 ...

TRAJECTORY:
  [FROM anchor]
    -> [EDGE TYPE + token], evidence [E#]
  [TO anchor]
    -> [EDGE TYPE + token], evidence [E#]
  [BOUNDARY/terminal state]

  Unproven links: [none, or exact gap and evidence needed]
  Hypothesis-only branches: [none, or explicitly separated]

CONFIRMED DEFECTS:
  - [SEVERITY] [CONFIDENCE] [anchor]
    Claim:      [specific defect]
    Root cause: [mechanism]
    Impact:     [confirmed consequence]
    Evidence:   [E#, E#]
    Tags:       [PRIME/modern tags]

  If none:
    RESULT DETAIL: NO DEFECT CONFIRMED
    Stops completed: [stops]
    Disproof quality: STRONG | MODERATE | WEAK

DISPROVEN CONCERNS:
  - [anchor] [concern]
    Evidence of absence: [E#/S# and bounded reasoning]
    Scope limits: [what was not ruled out]

CONTRADICTIONS:
  - K#: [E# versus E#]
    Status: RESOLVED | MATERIAL-UNRESOLVED | NONMATERIAL
    Resolution/confidence effect: [result]

UNKNOWNS AND GAPS:
  - [gap]
    Evidence needed: [smallest targeted artifact/action]
    Confidence effect: [downgrade]

HUMAN PAUSES OR DECISION FORKS:
  - [none, or stop/question/default/answer]

NON-CENTER OBSERVATIONS:
  - [anchor] [observation]
    Why excluded: [no causal edge to center]

BLAST RADIUS:
  Direct:       [symbols/files/state directly affected]
  Edge bundles: [bindings/generated adapters/contracts required for proven hops]
  Indirect:     [proven secondary consumers]
  Boundary:     [public/runtime surfaces]
  Excluded:     [nearby areas explicitly ruled out]

SMALLEST SUFFICIENT SAFE CHANGE / REPAIR CONTRACT:
  Objective:       [narrow root-cause correction]
  Required invariant: [what must become true]
  Allowed scope:   [symbols/files/contracts that may change]
  Forbidden scope: [unrelated behavior/refactor/dependency changes]
  Compatibility:   [behavior that must remain stable]
  Reversibility:   [rollback or containment requirement]

  If no defect confirmed:
    N/A - no evidence-backed defect to repair.

VERIFICATION PLAN:
  Failing-before mechanism:
    - [test/repro/check, exact command or method]
  Passing-after requirements:
    - [targeted regression check]
    - [boundary/contract check]
  Impacted checks:
    - [smallest relevant test set, then broader guardrail if justified]

TEST META-CHECK:
  - [test/check name and anchor]
    Status:             PASSING | FAILING | NOT_RUN
    Assertion match:    YES | STALE | WRONG_TARGET
    Oracle independent: YES | NO | UNCLEAR
    Fixture valid:      YES | FIXTURE_BREAKS | UNCLEAR
    Isolated/safe:      YES | NO | NOT_RUN

INDEPENDENT WITNESS:
  Used: [NO | evidence channel | subagent]
  Independence: [why independent, or why unavailable]
  Result: [agrees/disagrees/partial]
  Evidence: [E#]

EXPLICIT NON-SCOPE:
  - [what must not be changed or investigated further]

OVERSIZED-SCOPE SEGMENTS:
  - [none, or stop/symbol/segments/swept/skipped]

SAFETY STOPS:
  - [none, or blocked action/risk/safe substitute]

STOP REASON:
  [why the frontier ended and why the report is sufficiently bounded]
```

## Output discipline

- Lead with the result, not a diary of tool calls.
- Confirmed defects and disproven concerns both require evidence IDs.
- Keep hypotheses separate from confirmed trajectory.
- Do not assign a severity to unknowns.
- Do not include non-center observations in repair scope.
- A clean audit may be shorter than a defect report, but it must show the disproof domain and limits.
