# CENTER-AUDIT: Working Formats

Load this file when recording stops, segmentation, edge bundles, pivots, or interaction forks.

## Case file

```text
AUDIT FRAME:
  Mode:             INTERACTIVE | AUTONOMOUS | CI
  Repository root:  [path or N/A]
  Target revision:  [commit, workspace snapshot, build, release]
  Baseline:         [merge base, known-good revision, HEAD, or N/A]
  Workspace state:  CLEAN | DIRTY | NON-GIT | UNKNOWN
  Package/service:  [owner]
  Environment:      [runtime/config details relevant to the report]

DEFECT CLAIM C0:
  Observation:       [actual behavior]
  Expected invariant:[required behavior]
  Suspected violation:[falsifiable claim]
  Center anchor:     [LINE | SYMBOL | EDGE | STATE | EVENT | GENERATED | PAIRED]
  Falsifier:         [what would disprove the claim]
  Confidence:        HIGH | MEDIUM | LOW
  Alt candidates:    [other plausible anchors]
```

## Per-stop record

```text
STOP N: [scope]

EXPECTATIONS:
  Visibility: [what should become visible at this scope]
  Invariant:  [which claim or contract is being tested]
  Hazards:    [what dangerous behavior should be present or absent]
  Exit test:  [what evidence would justify expand, pivot, or stop]

EVIDENCE ADDED:
  E#: [channel/strength] [stable anchor]
      Method: [focused read, command, trace, test, LSP query]
      Result: [direct observation]
      Relation: SUPPORTS | CONTRADICTS | CONTEXT | ABSENCE

DELTA vs Stop N-1:
  New:         [new contract-relevant understanding]
  Contradicts: [prior expectation or evidence contradicted]
  Confirms:    [prior expectation or evidence confirmed]
  Surprise:    [unexpected fact]
  Gap:         [material unresolved fact]

FRONTIER:
  Enqueue: [EDGE-TYPE token -> exact next target]
  Deny:    [tempting path rejected, with reason]

EXIT:
  EXPAND | PIVOT | STOP-DISPROVEN | STOP-CONFIRMED | STOP-INCONCLUSIVE
  Reason: [one sentence]
```

## Search ledger entry

Use when a search result supports evidence of absence.

```text
SEARCH S#:
  Query/token: [exact search]
  Scope:       [directories, package, revision]
  Exclusions:  [generated, vendored, ignored, binary, untracked, other]
  Tool/method: [rg, LSP references, schema registry, trace query]
  Result:      [matches and anchors, or zero matches]
  Conclusion:  [what this does and does not rule out]
```

A zero-match search without scope and exclusions is not evidence of absence.

## Human pause

```text
HUMAN PAUSE at Stop N:
  Question:     [one precise question]
  Why blocking: [why code/evidence cannot resolve it]
  What changes: [which branch of the audit depends on the answer]
  Safe default: [least behavior-changing assumption, if any]
```

## Autonomous decision fork

```text
DECISION FORK at Stop N:
  Unknown:      [missing product/runtime fact]
  Branch A:     [interpretation and consequence]
  Branch B:     [interpretation and consequence]
  Default used: [least behavior-changing, reversible assumption]
  Confidence effect: [how this lowers or bounds confidence]
  Stop condition: [what would make continued work unsafe or fabricated]
```

## Scope segmentation

```text
SEGMENTATION at Stop N:
  Symbol/module:  [name and total size]
  Segments:       [logical blocks and ranges]
  Center segment: [range and reason]
  Flow links:     [VALUE/CONTROL/STATE edges between relevant segments]
  Swept:          [segments inspected]
  Skipped:        [segments skipped and why they have no proven flow]
```

## Edge bundle

```text
EDGE BUNDLE B#:
  Edge token: [symbol, route, key, event, schema, binding]
  Edge type:  VALUE | CONTROL | STATE | CONTRACT | TEMPORAL | CONFIG | PROVENANCE | TEST | RUNTIME
  Artifacts:
    - [anchor] [why required to resolve this one hop]
    - [anchor] [why required]
  Proven hop: [FROM -> TO]
  Evidence IDs: [E#, E#]
```

## Center pivot

```text
CENTER PIVOT P#:
  Prior claim:   [C0/C1]
  Disproof:      [evidence IDs]
  New claim:     [specific, falsifiable claim]
  New center:    [stable anchor]
  Why selected: [highest-risk supported alternate]
  Pivot count:   [1 or 2]
```
