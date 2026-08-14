# CENTER-AUDIT: Evidence Model

Load this file when grading evidence, proving absence, resolving indirect edges, handling contradictions, or using an independent witness.

## Evidence ledger

Every material statement in the final report should trace to an evidence ID.

| Field | Meaning |
|---|---|
| ID | Stable identifier such as `E1` |
| Channel | SOURCE, RUNTIME, TEST, CONTRACT, HISTORY, STATIC-TOOL, HUMAN |
| Strength | A, B, C, or D |
| Anchor | Revision plus path/symbol/line, trace/span, schema version, command, or artifact ID |
| Method | How the evidence was obtained |
| Result | What was directly observed, without interpretation inflation |
| Relation | SUPPORTS, CONTRADICTS, CONTEXT, or ABSENCE |
| Independence group | Which evidence shares an origin and therefore is not independent |

### Strength grades

Strength measures directness and reproducibility, not prestige.

- **A: Executed and reproducible.** Captured command, input, target revision/environment, output, and status; or a correlated runtime trace that directly observes the mechanism.
- **B: Direct anchored evidence.** Exact source, schema, contract, persisted state, generated mapping, or deterministic static path at the target revision.
- **C: Corroborating inference.** LSP references, call graph, history, coverage, static analyzer, search result, or indirect runtime signal that narrows the case but does not alone prove the mechanism.
- **D: Report or hypothesis.** Human description, comment, issue text, stale documentation, model summary, or unverified assumption.

A test is not automatically grade A. A stale assertion or mocked-away path can be weaker than direct source evidence. A human report is valuable for anchoring but does not prove mechanism.

## Stable anchor format

Prefer:

```text
repo@<revision>:path/to/file.ts:L120-L136 [symbolName]
```

Other valid anchors:

```text
trace:<trace-id>/span:<span-id> [service.operation]
schema:<name>@<version> [field/path]
state:<table-or-key>@<environment> [record identity]
command:<exact command> [exit code + captured output artifact]
build:<build-id> -> source-map:<artifact> -> original:<path:line>
```

Line numbers without revision and symbol are supporting coordinates, not stable identity.

## Evidence channels and independence

Two pieces of evidence are independent only when one is not mechanically derived from the other.

Examples of independent channels:

- source path plus runtime trace
- schema contract plus consumer test
- production log correlation plus database state
- static analyzer plus manually inspected source
- fresh subagent inspection plus deterministic test output

Examples that are not independent:

- two summaries of the same stack trace
- a test and a coverage report from that same test
- generated client code and the schema that generated it, unless the comparison is specifically about generator drift
- two agents that received the first agent's conclusion and repeated it
- multiple log lines emitted from the same failed operation without a distinct causal observation

Use `independence_group` to avoid accidental double counting.

## Convergence protocol

Use for HIGH/CATASTROPHIC impact, disputed claims, AI/LLM nondeterminism, or distributed paths.

1. Give the witness the raw observation, center anchor, invariant, falsifier, and target revision.
2. Do not provide the current fused conclusion.
3. Ask the witness to either prove, disprove, or leave the claim unresolved using a different channel or fresh inspection.
4. Compare evidence IDs and mechanisms, not verdict labels.
5. Agreement raises confidence only when evidence is independent.
6. Disagreement enters the contradiction ledger and must be resolved or reflected in lower confidence.

Do not use majority vote as causal proof.

## Contradiction ledger

```text
CONTRADICTION K#:
  Evidence A: [E# and claim]
  Evidence B: [E# and conflicting claim]
  Possible explanations: [revision drift, config drift, stale test, mock, race, partial rollout, wrong contract authority]
  Resolution action: [targeted operation]
  Status: RESOLVED | MATERIAL-UNRESOLVED | NONMATERIAL
  Confidence effect: [none / downgrade]
```

When code, tests, runtime, and documentation disagree, identify which artifact is authoritative for the specific contract. Do not apply a universal hierarchy blindly.

## Edge proof

Each trajectory hop must identify a mechanism:

```text
FROM [anchor]
  -> EDGE TYPE [token]
  -> TO [anchor]
  Evidence: [E#]
  Mechanism: [what transfers value, control, state, contract, time, config, provenance, test coverage, or runtime causality]
```

A call graph edge proves potential control flow, not that the failing input traversed it. A runtime trace proves execution, not necessarily that the observed value caused the failure. Fuse channels carefully.

## Indirect edge resolution

The current stop may reveal an exact edge token without revealing the destination file. Resolve it narrowly using:

- definition, implementation, references, or call hierarchy
- exact symbol/key/route/event search
- dependency injection or registry binding lookup
- build graph or package ownership
- schema registry or generated-client metadata
- trace/span parent-child context
- source maps or generator manifests
- database catalog, migration graph, or query plan

The resolver output is a lead until the target artifact is read or observed directly.

## Evidence of absence

A clean audit needs positive disproof evidence, not “I did not notice anything.”

Strong evidence of absence may include:

- exhaustive references within a clearly bounded package and revision
- all switch/union variants inspected and accounted for
- a deterministic test or property check that exercises the claimed failure condition
- trace evidence showing the value never crosses the suspected edge
- schema validation proving the prohibited state cannot enter
- a recorded exact search whose scope, exclusions, and limitations are explicit

Weak absence claims:

- zero grep results with unknown ignores
- reading only the center line
- assuming type declarations equal runtime validation
- a passing test that targets another property
- absence in one environment while configuration differs elsewhere

## Likelihood versus confidence

Keep these separate:

- **Likelihood** estimates whether the mutation propagates.
- **Confidence** estimates how trustworthy that estimate is.
- **Impact** estimates consequence if it propagates.
- **Reproducibility** describes observational stability.

Example:

```text
Likelihood: POSSIBLE
Impact: CATASTROPHIC
Confidence: LOW
Reproducibility: NOT_REPRODUCED
```

This is a serious hypothesis requiring more evidence, not a CRITICAL confirmed defect.

## Example trajectory

```text
CENTER repo@a1b2:src/parser.ts:L44-L58 [parseMessage]
  -> CONTRACT `MessageV2.kind`, E3
CONSUMER repo@a1b2:src/router.ts:L91-L112 [routeMessage]
  -> CONTROL default branch swallows unknown kind, E6
BOUNDARY trace:7f.../span:router.consume
  -> RUNTIME message acknowledged without handler, E9
TERMINAL IMPACT: silent record drop

Unproven links: none
```
