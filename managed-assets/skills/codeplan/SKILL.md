---
name: codeplan
description: >
  Use before implementing a non-trivial code change when two or more credible
  mechanisms exist, the mechanism choice creates meaningful engineering risk,
  or the user explicitly requests variant analysis. Codeplan defines the task,
  calibrates to the active repository, compares genuinely distinct mechanisms,
  rejects non-viable candidates before scoring, freezes a task-specific rubric,
  preserves a credible simplicity baseline, implements only the selected
  mechanism, verifies it against pre-change evidence, and re-plans rather than
  silently changing design. Emits compact IN, PLAN-OUT, and EXEC-OUT status
  lines for an auditable decision trace without forcing ceremony onto trivial
  work.
version: 2.1.0
platforms: [linux, macos, windows]
metadata:
  methodology: "evidence-gated-mechanism-selection"
  tags: [variant-analysis, implementation-planning, evidence-gated, baseline-guard, divergence-audit, uncertainty-control, self-correction, regression-control]
---
# Codeplan

Codeplan prevents an implementation agent from choosing the first plausible
approach merely because it is easy to imagine.

It does **not** reward complexity. A three-line fix should beat a new abstraction
when the three-line fix is correct, compatible, verifiable, and safe. The goal is
to expose consequential mechanism choices, not manufacture architecture or
produce ceremonial paperwork.

Codeplan separates prediction from proof:

```text
task contract
→ repository evidence
→ candidate mechanisms
→ paper gates
→ frozen rubric
→ evidence-aware selection
→ PLAN-OUT
→ implementation
→ evidence gates
→ EXEC-OUT
```

`PLAN-OUT` records what should be implemented. `EXEC-OUT` records what was
actually implemented and demonstrated. Never claim implementation evidence
before implementation exists.

Repository-specific examples are illustrative only. Active repository rules,
code, tests, manifests, runtime constraints, and the user's task outrank generic
engineering preferences.

> **Tool portability**
>
> Use parallel subagents or arithmetic tools when available and helpful. They are
> optional. Direct repository inspection and executable arithmetic verification
> are equivalent. Tool availability must never change the reasoning standard.

---

## 1. Eligibility gate

Perform only enough inspection to determine whether Codeplan is warranted.

Use Codeplan when at least one condition is true:

- Two or more credible implementation mechanisms exist.
- Mechanism choice materially affects architecture, compatibility, state,
  security, data integrity, performance, operability, testability, or long-term
  maintenance.
- The obvious or local repair has already failed, or evidence has disproved the
  currently selected mechanism.
- A wrong choice would be difficult to reverse or likely to create hidden
  regressions.
- The change crosses API, schema, persistence, process, module, or runtime
  boundaries.
- The user explicitly requests variants, comparison, Codeplan, or protection
  against the easiest reasoning path.

Skip the full workflow when:

- One obvious safe mechanism exists.
- The task is a typo, literal replacement, single configuration value, or other
  mechanical edit without a consequential design choice.
- The task is a small configuration or documentation edit.
- Work is continuing an already selected mechanism and no new evidence has
  invalidated it.
- A broad gameplay or end-to-end run has merely exposed another ordinary
  blocker with a clear owner and repair.
- The request is research, explanation, review, or planning with no code change.
- An external contract dictates the only valid mechanism.
- An immediate mitigation is necessary. Apply the smallest safe mitigation,
  then Codeplan the durable follow-up when appropriate.
- Existing repository tests and structure establish one valid mechanism and no
  meaningful alternative exists.

When skipping, record:

```text
[codeplan · <topic> · SKIP · reason: <trivial|single-valid-mechanism|research-only|externally-dictated|emergency-mitigation>]
```

Do not generate fake variants to satisfy process.

After Codeplan selects a viable mechanism, implement it. Do not repeatedly
re-plan unless new evidence invalidates the selected mechanism or materially
changes the task contract.

---

## 2. Operating invariants

These rules are non-negotiable:

1. **Repository evidence outranks generic taste.**
2. **The strongest conservative mechanism must be represented honestly.**
3. **Candidates must differ materially, not cosmetically.**
4. **Hard failures are rejected before scoring.**
5. **Axes and weights freeze before candidate scores are assigned.**
6. **Missing evidence never improves a candidate's denominator.**
7. **Only the selected mechanism is implemented.**
8. **A material mechanism change requires re-planning.**
9. **User work and unrelated changes are protected.**
10. **No commit, push, merge, release, deployment, destructive reset, or
    unrelated cleanup occurs without explicit authorization.**

---

# Workflow

## Step 1: Define the task contract and protect the workspace

Translate the request into observable requirements before generating
candidates.

Record, compactly:

```text
Task:
Required behavior:
Acceptance criteria:
Must preserve:
Out of scope:
User constraints:
Known runtime/repository constraints:
Assumptions or unresolved questions:
```

Rules:

- Distinguish requirements from preferences.
- Preserve named APIs, schemas, data, behavior, and compatibility constraints.
- Resolve repository-answerable questions by inspection rather than asking the
  user.
- Record minor assumptions. Ask only when a major unresolved ambiguity would
  create materially different implementations and available evidence cannot
  resolve it.
- Every candidate and verification check must map to the same contract.

Before editing:

- Identify the repository or workspace root.
- Read applicable repository instructions.
- Inspect version-control status when available.
- Note unrelated or uncommitted work.
- Do not overwrite, discard, reformat, relocate, or “clean up” unrelated work.
- Capture a lightweight pre-change verification baseline when it is useful for
  distinguishing existing failures from regressions.

Minimum safety record:

```text
workspace: <path>
user-work: <clean|present|unknown>
protected-paths: <paths or none identified>
pre-change-checks: <results|not-run: reason>
```

The eligibility gate should already have excluded trivial work. Do not turn
workspace protection into an exhaustive repository audit.

---

## Step 2: Calibrate to the active repository

Read the minimum evidence needed to identify actual constraints and local
quality signals.

Inspect, as applicable:

1. The nearest applicable repository or workspace instruction files.
2. Representative source files in the affected area, stopping when additional files no longer change the mechanism choice.
3. Relevant tests, fixtures, and call sites.
4. Build, dependency, runtime, and type configuration.
5. Public contracts or schemas touched by the task.
6. Recent analogous implementations when they clarify the intended pattern.

Extract only decision-relevant evidence:

```text
hard rules:
architecture/paradigm:
local implementation patterns:
error and failure conventions:
test and verification patterns:
compatibility/runtime constraints:
relevant risks:
evidence references:
```

Use concrete paths, symbols, commands, or repository instructions. Do not claim
that a pattern is repository-wide after seeing one isolated file.

### Optional parallel calibration

Use subagents only when the repository or affected area is large enough to
benefit. A useful split is:

- guidance and hard rules;
- affected implementation patterns and tests.

Give each subagent the repository path and task domain and require evidence references. Incorporate only decision-relevant results. Verify every load-bearing claim needed for selection, expanding the check when evidence conflicts or remains incomplete. If delegated evidence cannot be trusted, return to direct inspection rather than imposing a retry, length, or reviewer quota.

For a small repository, single-file script, or narrow affected area, inspect
directly. Delegation is machinery, not virtue.

---

## Step 3: Establish comparison scope and record depth

Generate every credible mechanism exposed by the task contract and repository evidence. There is no candidate quota, minimum population, or special constrained mode. Stop when another entry would be a restatement, a deliberate non-solution, an implausible mechanism, or a tradeoff that cannot materially change the decision.

Use a concise record for ordinary work and a deeper record when the decision itself needs durable evidence because of safety, irreversible state, public contracts, migrations, regulation, or an explicit user request. Record depth changes documentation detail, not the number of mechanisms considered.

Record:

```text
comparison-scope: <why mechanism comparison is warranted>
record-depth: <concise|forensic>
stop-condition: <why the candidate set is sufficient>
```

Do not invent candidates to populate a matrix.

---

## Step 4: Generate credible, mechanically distinct candidates

Always include the strongest conservative candidate: the smallest credible
mechanism that fully satisfies the task without deliberate weakness.

Do not force the remaining candidates into predetermined roles. Name each by its
actual structural mechanism.

Each candidate must include:

```text
V<n> - <short name>
fingerprint: <concise structural mechanism tags>
mechanism: <how it works>
contract mapping: <how it satisfies required behavior>
files/boundaries affected:
state and data behavior:
error/failure behavior:
dependency impact:
verification approach:
estimated effort: <low|medium|high>
principal tradeoff:
```

### Mechanism fingerprints

Use concise tags that describe material structure, for example:

- boundary: `inline`, `existing-helper`, `new-module`, `adapter`, `service-layer`
- state: `local-state`, `instance-state`, `persistent-state`, `external-store`
- data: `map-index`, `set-filter`, `stream-transform`, `normalized-model`
- control: `guard-clause`, `iterative`, `event-driven`, `transactional`
- dependency: `zero-dep`, `internal-reuse`, `new-dependency`
- failure: `throw-wrapped`, `result-return`, `graceful-degrade`, `transaction-rollback`

A candidate is distinct only when at least one differing dimension changes a
meaningful tradeoff in correctness, testability, architecture, risk, cost, or
operational behavior.

Discard and regenerate candidates that:

- differ only in naming, formatting, or helper placement without meaningful
  consequences;
- weaken or omit the requirement;
- silence the symptom rather than solve the task;
- are knowingly inferior straw candidates;
- duplicate the conservative candidate under a grander label;
- introduce architecture solely to appear sophisticated.

Record enough divergence evidence to show that each surviving mechanism introduces at least one task-relevant structural difference from the conservative baseline or another viable mechanism. Compare only the pairs needed to establish that distinction. Do not create a fixed comparison grid or taxonomy quota.

---
## Step 5: Apply active paper viability gates

Paper gates assess whether a candidate is credible in principle. They do not
pretend that unimplemented behavior has already passed runtime verification.

Always activate:

- **Task fulfillment:** plausibly implements the required behavior.
- **Contract preservation:** preserves required APIs, schemas, behavior, and
  invariants unless the task explicitly changes them.
- **Negative space:** solves the requirement rather than avoiding, disabling, or
  suppressing it.
- **Repository hard rules:** respects applicable repository instructions and
  protected user work.
- **Verification feasibility:** can be meaningfully verified within the
  available environment or has an explicit evidence plan.

Activate when relevant:

- dependency justification;
- security and privacy;
- data integrity and migration safety;
- backward compatibility and rollout;
- supported runtime/platform compatibility;
- performance or resource constraints;
- concurrency, idempotency, or transaction safety;
- operability and observability.

A new dependency is not automatically forbidden, but must be justified by
repository policy, lack of suitable internal facilities, lifecycle cost,
security posture, compatibility, and removal risk.

Record each active gate as:

```text
<gate>: pass - <evidence or reasoning>
<gate>: fail - <specific reason>
<gate>: unknown - <evidence needed>
```

For an inactive gate, omit it. In forensic records, it may be recorded as
`not-applicable - <reason>` when that absence matters to the audit.

Rules:

- A `fail` candidate is disqualified immediately and never scored.
- An `unknown` hard gate blocks that candidate from scoring until the gate is
  resolved. If the uncertainty affects quality rather than viability, remove it
  from the hard-gate list and represent it honestly in the frozen rubric.
- Do not stamp irrelevant gates “pass” merely to complete a form.

---

## Step 6: Write the IN record

After credible candidates and paper gates exist, record the decision state without encoding candidate-count policy:

```text
[codeplan · <topic> · IN · depth: <concise|forensic> · confidence: <low|med|high> · candidates: <all active mechanism IDs/fingerprints> · lean: <candidate|none> · conservative: <candidate>]
```

`lean` is a disclosed initial hunch, not a decision. Confidence describes whether the candidate set and repository calibration are complete enough to compare. If material evidence is missing, resolve the smallest decision-changing gap before ordinary PLAN-OUT.

---

## Step 7: Freeze a task-specific comparison rubric

Choose only the dimensions that can materially distinguish the surviving mechanisms for this task. Typical dimensions include repository and architecture fit, verifiability, reversibility, regression risk, maintainability, compatibility, data integrity, security, performance, operability, accessibility, and delivery cost. These are prompts, not a required axis list.

Before comparing candidates, freeze the active dimensions, what each means here, the evidence accepted for each judgment, any weighting genuinely required by the task, the treatment of unknown evidence, the conservative baseline definition, and the selection/tie rules.

There is no required axis count, score scale, weight range, denominator, normalization formula, or parity threshold. Use the lightest comparison representation that makes the decision auditable. A qualitative evidence matrix is sufficient when numbers add false precision. If numeric scoring materially helps, define its scale and weights before assigning candidate results, apply the same scheme to every candidate, and verify the arithmetic.

Missing, weak, conflicting, or unverified evidence remains `unknown`. Unknown evidence never earns unsupported credit, silently leaves a denominator, or makes a candidate appear safer. If an unknown can change viability or the winner, gather the smallest discriminating evidence or stop with the decision unresolved.

If new evidence invalidates the frozen rubric, discard the affected comparison, revise from the evidence, freeze again, and re-evaluate every surviving mechanism. Never tune the rubric after seeing which candidate wins.

---

## Step 8: Compare with evidence and honest uncertainty

For every gate-passing mechanism, judge it against the same frozen dimensions and cite concrete repository, runtime, contract, or test evidence for each load-bearing advantage or weakness. Keep convenience separate from correctness and risk. Make uncertainty visible instead of forcing false precision. Verify any arithmetic or normalization actually used.

A paper-gate failure remains non-compensatory and never enters the comparison. When a candidate-specific dimension is unknown, record what evidence would resolve it and whether that evidence can change the selection. Stop investigating when additional evidence cannot materially change the decision.

---

## Step 9: Preserve the conservative baseline and select

The conservative baseline is the simplest fully viable mechanism supported by enough evidence to implement and verify. Simplicity includes low operational burden, reuse of established machinery, narrow irreversible surface, and straightforward rollback; it never excuses incomplete behavior or weak proof.

Select an alternative only when task-relevant evidence shows material lift that pays for its added complexity, surface area, dependency burden, migration cost, or operational risk. A numeric total alone cannot manufacture that proof.

When viable mechanisms are materially equivalent under the frozen rubric, prefer the conservative baseline unless a documented task requirement favors another choice. When unresolved evidence can reverse the choice, gather the smallest differentiating evidence or stop before mutation. Do not invent a fixed tie threshold.

Record the comparison as `alternative-wins`, `baseline-wins`, `equivalent`, or `not-comparable`. Do not issue ordinary PLAN-OUT while selection is `not-comparable` unless explicit user direction knowingly accepts the unresolved risk.

---

## Step 10: Write PLAN-OUT and store the record safely

Before editing, record the selected mechanism:

```text
[codeplan · <topic> · PLAN-OUT · depth: <concise|forensic> · pick: <mechanism> · baseline: <mechanism> · confidence: <low|med|high> · comparison: <alternative-wins|baseline-wins|equivalent> · evidence: <decision-changing evidence> · reason: <evidence-based sentence> · planned-fingerprint: <tags>]
```

Normal PLAN-OUT requires medium or high confidence and stable selection. A
low-confidence PLAN-OUT is valid only under the accepted-risk exception below.

When an emergency policy or explicit user direction authorizes implementation
despite decisive missing evidence, use `confidence: low` and record the
exception truthfully:

```text
risk-accepted-by: <user|emergency-policy>
unresolved-evidence: <summary>
```

Do not imply that accepted risk is resolved evidence.

Add a short implementation plan:

```text
files/boundaries:
ordered changes:
contract checks:
tests/checks:
rollback or reversibility notes:
```

### Record storage

Use this hierarchy:

1. the repository's documented planning location;
2. an existing ignored scratch location;
3. a runtime temporary file;
4. the current conversation or execution log.

Use a persistent record mainly for forensic profile work or when the repository
expects one. Never modify ignore or discovery-exclusion files merely to store Codeplan output. Do not pollute tracked documentation without an
explicit repository convention or user request.

---

## Step 11: Implement only the selected mechanism

Implement the planned fingerprint and no other candidate.

During implementation:

- preserve protected and unrelated work;
- keep changes within the selected boundaries unless evidence requires
  re-planning;
- do not blend losing candidates into the winner merely because convenient;
- do not perform unrelated refactors, formatting sweeps, dependency upgrades,
  or cleanup;
- map implementation back to the task contract and acceptance criteria;
- add or update the verification surface promised in PLAN-OUT.

A small execution mistake inside the same mechanism is not a new design. Fix it
within the mechanism. A material boundary, state, dependency, control-flow, or
failure-policy change is a mechanism shift and requires Step 12.

---

## Step 12: Apply active evidence gates and self-correct

Runtime evidence gates demonstrate the implemented result. Activate only checks
relevant to the task and repository.

Common evidence gates:

- targeted tests;
- typecheck, compile, or build;
- lint or static analysis;
- integration or end-to-end behavior;
- API/schema/contract checks;
- security or privacy checks;
- data migration, rollback, or integrity checks;
- supported runtime/platform checks;
- performance or resource measurements;
- regression comparison against pre-change results;
- planned fingerprint conformance.

Record each active gate as:

```text
<gate>: pass - <evidence>
<gate>: fail - <evidence>
<gate>: not-available - <environment limitation>
```

For forensic records, an explicitly considered but unnecessary gate may be
recorded as `not-required - <reason>`.

Compare relevant pre-change and post-change results:

```text
pre-change:
post-change:
new failures:
resolved failures:
unchanged known failures:
```

Do not call a change fully verified when a required gate is unavailable. State
what was and was not demonstrated.

### Self-correction taxonomy

**Execution error**

The selected mechanism remains valid, but implementation contains a bug or
omission. Fix it within the same fingerprint, rerun affected evidence gates, and
record the correction.

**Design flaw**

Evidence shows the selected mechanism cannot satisfy the contract safely. Mark
it `disqualified: design-fail`, return to candidate generation, and rescore the
remaining or replacement candidates.

**Mechanism shift**

Implementation requires a material fingerprint change. Stop mechanism-changing work, preserve WIP, and compare the adapted mechanism with every remaining credible alternative whose result can materially change the decision. Retain the original only when it remains genuinely viable. Do not keep a mechanism already proven impossible merely to satisfy a comparison count. Mark the old plan `superseded-by-replan` and emit a replacement PLAN-OUT before continuing.

**Task-contract change**

New evidence or user direction changes required behavior. Update the contract,
identify invalidated evidence, and restart at the earliest affected step.

**Verification-environment failure**

The mechanism may be correct, but required evidence cannot run because of tools,
credentials, services, platform, or environment. Do not switch mechanisms unless
that limitation is itself a task constraint. Record the unverified requirement
and confidence impact.

---

## Step 13: Write EXEC-OUT

After implementation and evidence checks, record the actual result:

```text
[codeplan · <topic> · EXEC-OUT · implemented: <Vn or replan ID> · confidence: <low|med|high> · verification: <passed|partial|failed> · mechanism-check: <passed|failed> · plan-history: <unchanged|replanned-from-X-to-Y> · corrected: <none|summary> · evidence: <compact check summary>]
```

Confidence reflects implementation evidence:

- `high`: all required checks pass and mechanism conformance is demonstrated;
- `med`: core checks pass but a non-critical check is unavailable or limited;
- `low`: required verification is incomplete, material uncertainty remains, or
  the result failed.

`mechanism-check` compares the implementation with the **current valid plan**.
After a successful re-plan it should be `passed`; the prior shift belongs in
`plan-history`.

A successful run has:

- a stable task contract;
- credible, distinct candidates;
- paper gates applied before scoring;
- a frozen, relevant rubric;
- verified comparison arithmetic when numeric scoring was used;
- an honest baseline;
- a stable selection or explicitly accepted risk;
- implementation matching the current plan;
- evidence mapped to acceptance criteria;
- no unauthorized repository operations.

---

# Compact decision record

Use this skeleton for ordinary work. Expand evidence only when the forensic
profile requires it.

```markdown
# Codeplan: <topic>

## Contract and safety
- Required behavior:
- Acceptance criteria:
- Must preserve:
- Out of scope:
- Workspace/user work:
- Pre-change checks:

## Repository evidence
- Hard rules:
- Local patterns:
- Tests/contracts/runtime:
- References:

## Comparison scope
- Why comparison is warranted:
- Record depth:
- Candidate-set stop condition:

## Candidates
- <ID> `<fingerprint>`: <mechanism and tradeoff>
- <repeat only for credible mechanisms>

## Divergence
- <only comparisons needed to prove material distinction>

## Paper gates
- V1: pass/fail/unknown with reason
- V2: pass/fail/unknown with reason
- V3: pass/fail/unknown with reason

## IN
<status line>

## Frozen rubric and scoring
- freeze: ...
- matrix or compressed scores
- arithmetic verification:
- formal baseline:
- selection stability:

## PLAN-OUT
<status line>

## Implementation and evidence
- Changes:
- Pre/post comparison:
- Active evidence gates:
- Corrections/re-plan:

## EXEC-OUT
<status line>
```

A compact record may compress known-safe details into a
single sentence, but must preserve the decision and evidence chain.

---

# Status-line reference

```text
[codeplan · <topic> · SKIP · reason: <reason>]

[codeplan · <topic> · IN · depth: <concise|forensic> · confidence: <low|med|high> · candidates: <all active IDs/fingerprints> · lean: <candidate|none> · conservative: <candidate>]

[codeplan · <topic> · PLAN-OUT · depth: <concise|forensic> · pick: <mechanism> · baseline: <mechanism> · confidence: <low|med|high> · comparison: <alternative-wins|baseline-wins|equivalent> · evidence: <summary> · reason: <...> · planned-fingerprint: <...>]

[codeplan · <topic> · EXEC-OUT · implemented: <mechanism or replan ID> · confidence: <low|med|high> · verification: <passed|partial|failed> · mechanism-check: <passed|failed> · plan-history: <unchanged|replanned> · corrected: <none|summary> · evidence: <...>]
```

Use the exact stage names. Candidate fields are variadic and list the active mechanisms. Keep status lines compact without hiding material uncertainty.

---
# Anti-theater checks

Before finalizing a Codeplan run, ask:

- Would the conservative candidate still look credible if it won?
- Does every alternative introduce a real mechanism or tradeoff?
- Did any irrelevant gate receive a ceremonial pass?
- Does every scoring axis help distinguish this task's candidates?
- Was any missing fact converted into a favorable score or smaller denominator?
- Does PLAN-OUT describe a prediction rather than invented runtime evidence?
- Does EXEC-OUT cite actual checks and distinguish old failures from new ones?
- Did implementation preserve the selected fingerprint or trigger a re-plan?
- Did the record become longer than the decision required?

If the answer exposes theater, compress or correct the run before presenting it.
The decision trace must be sufficient, not maximal.

---

# Final prohibitions

Codeplan never authorizes the agent to:

- discard or overwrite unrelated user work;
- reset, clean, or rewrite repository history;
- modify ignore files merely to hide planning artifacts;
- score a paper-gate failure;
- implement before stable selection, except under explicitly recorded accepted
  risk;
- silently change mechanism;
- claim unavailable verification passed;
- commit, push, merge, release, or deploy without explicit approval.
