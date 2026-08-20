# Ladder Audit Formal Output Template

Use this template only when the result must become a durable implementation or verification contract. For ordinary conversation, use the compact headings in `SKILL.md`.

## Applicability

`APPLICABLE`, `APPLICABLE_WITH_LIMITS`, or `NOT_APPLICABLE`.

State the diagnostic value of a ladder versus direct implementation, Center Audit, or the unchanged broad run.

## Outcome and Graduation

```text
Mode:
Repository / system:
Target revision/state:
Workspace state:
Real outcome:
Exact unchanged graduation request/workflow:
Authorized mutations:
Forbidden mutations:
Identity requirements:
Independent final oracle:
Natural starting condition:
Recovery expectation:
Full-run cost:
Reset mechanism:
```

## Capability Map

List only outcome-relevant nodes and proven edges.

```text
C1 <capability> [PROVEN | UNPROVEN | CONTRADICTED | EXTERNAL]
  depends on: <C# or none>
  owner: <module, service, dependency, or unknown>
  evidence: <path, symbol, test, trace, runtime observation, or none>
```

State the deepest unproven boundary selected for the next tranche.

## Scaffold Inventory

| Scaffold | Capability temporarily removed | Why supplied | Removal rung or outside scope |
|---|---|---|---|
| <condition> | <capability> | <diagnostic reason> | <rung ID / outside> |

Every in-scope scaffold needs a removal rung.

## Next Ladder Tranche

Detail only the smallest evidence-useful next tranche. Stop adding rungs when another rung no longer reduces material uncertainty or when the tranche's cost approaches unchanged graduation. Keep later capability paths provisional until evidence reaches them.

| Rung | Readiness/result | Proven baseline held | Scaffold removed | Newly active capability | Initial state | Request | Qualified oracle | Failure route | Reset |
|---|---|---|---|---|---|---|---|---|---|
| A0 | READY / BLOCKED / PASS / FAIL / INCONCLUSIVE | <fixed evidence> | <one scaffold> | <one owner or proven minimal pair> | <manifest> | <request> | <external checks> | <owner/method> | <fresh/restore/preserve> |

For any non-obvious rung, add:

```text
RUNG <ID>
  Claim:
  Readiness/result: READY | BLOCKED | PASS | FAIL | INCONCLUSIVE
  Proven baseline held:
  Scaffold removed:
  Newly active capability:
  Initial state:
  Request:
  Oracle pre-state:
  Expected delta / identity:
  Independent observer:
  Sensitivity check:
  Failure route:
  Reset rule:
  Transfer probe(s), limited to evidence-useful variation:
  Passing freezes:
```

## Pre-Fix Candidates

```text
PF-<N> <title>
  Status: ELIGIBLE | NEEDS_CENTER_AUDIT | SPECULATIVE_DO_NOT_FIX
  Evidence:
  Shared invariant:
  Existing ownership seam:
  Failing-before check:
  Passing-after check:
  Why graduation remains necessary:
```

Do not mark a pre-fix eligible without source or prior runtime evidence.

## Isolation and Oracles

```text
Revision / dependency lock:
Runtime / platform:
Namespace or environment:
Initial files / records / inventory / queues:
Active jobs / goals / locks / sessions:
Configuration:
Log offset / trace ID:
Setup assertions:
Fail-closed conditions:
Ordinary reset method:
Recovery-state preservation:
```

Name any nondeterministic rung's required repetition count or statistical threshold.

## Transfer and Graduation Gates

| After rung/tranche | Evidence-useful material variation | Invariant that must transfer | Independent oracle |
|---|---|---|---|
| <ID> | <bounded variation> | <shared behavior> | <evidence> |

Then restate:

```text
Exact unchanged graduation request/workflow:
Natural initial state:
Independent postconditions:
No-hidden-scaffold proof:
No-test-shaped-production proof:
Recovery replay:
```

## Failure Routing

| Failed rung | First owner | Next method | Stop condition |
|---|---|---|---|
| <ID> | <module/capability> | Center Audit / proven repair / dependency escalation | <what must pass> |

## Recommended First Rung

Name the rung to run first. Explain why it has the highest diagnostic value with the lowest new uncertainty in the selected tranche.

## Do Not Encode

List known answers, test identifiers, fixed paths, fixture coordinates, canned sequences, hidden state, or relaxed contracts that production code must never learn.

## Reporting rules

- Separate evidence from design assumptions.
- Keep each rung to one newly unproven capability class, or one evidence-proven minimal inseparable pair.
- Distinguish harness `BLOCKED`, ambiguous `INCONCLUSIVE`, and product `FAIL`.
- Qualify every oracle.
- State reset and failure routing for every detailed rung.
- Stop extending the tranche or transfer set when added experiments no longer reduce uncertainty or their cost approaches unchanged graduation.
- Keep later tracks provisional until evidence reaches them.
- Never claim ladder completion proves product completion without the unchanged graduation gate.
