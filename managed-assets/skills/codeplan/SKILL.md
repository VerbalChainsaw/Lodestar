---
name: codeplan
description: >
  Conditional decision-making workflow for non-trivial changes where more than one
  credible mechanism exists and the mechanism choice materially affects regression
  or maintenance risk, or when the user explicitly requests variant analysis.
  Small direct fixes that are correct, compatible, testable, and safe are
  implemented directly without this workflow. Generates 2-5 mechanically distinct
  candidate approaches, calibrates a scoring rubric to THIS codebase's quality
  axes, applies non-compensatory hard viability gates, scores
  variants with frozen weights, and uses a baseline guard so a simple valid
  solution is not punished for not being complicated. Emits compact IN/OUT
  status lines (a decision trace) so the run is auditable. Self-correcting: if
  implementation diverges from the winner's mechanism, it re-plans rather than
  silently mutating the plan. Triggers include "use codeplan", "create
  variants", "don't take the easy path", "evaluate options before coding",
  "show me the best approach", "which way is better".
metadata:
  version: 1.1.0
  platforms: [linux, macos, windows]
  hermes:
    tags: [variant-analysis, decision-making, scoring, tradeoff, implementation-planning, divergence-taxonomy, normalization-guard]
    related_skills: [plan, ponytail, external-model-routing]
---

# Codeplan

Codeplan is **conditional, not a standing requirement.** Run it for non-trivial
changes where more than one credible mechanism is available and the mechanism
choice materially affects regression or maintenance risk — or when the user
explicitly asks for variant analysis. For a small direct fix that is correct,
compatible, testable, and safe, implement directly; do not run the full workflow.

When it does run, codeplan defeats the model's bias toward the *swiftest,
lowest-effort reasoning path*. It does NOT punish a *simple, correct
implementation* — simplicity is sometimes the best engineering. The job is to
stop lazy reasoning, not to force complexity. It is self-correcting: if
verification or implementation reveals the winner is wrong or must change
mechanism, it returns to variant generation rather than silently patching.

It generates 2-5 mechanically distinct variants (each tagged with a 2-word
mechanism fingerprint), calibrates a rubric to the repo, applies hard viability
gates, scores with frozen weights, preserves a compact decision trace,
implements only the winner, verifies, and records corrections if any.

Repository-specific examples in this skill are **illustrative only**. Apply them
only when verified in the active repository's instructions or existing code.

> **Tool portability.** This skill references two Hermes tools: `delegate_task`
> (parallel subagents, Step 2) and `execute_code` (arithmetic verification,
> Step 7). On runtimes without them, the skill still works: calibrate by reading
> repo files directly (no subagents), and verify arithmetic with `python3 -c`
> or inline multiplication. No analytical capability is lost — only the
> delegation/verify machinery changes.

## When to use

Run the full workflow only when at least one of these holds — otherwise implement
directly:

- The change is non-trivial and **more than one credible mechanism exists**.
- The mechanism choice **materially affects regression risk or maintenance cost**
  (hard-to-revert state, new dependency, changed surface).
- The user **explicitly requests variant analysis** or options before coding.

## When NOT to use

- **Small direct fixes** that are correct, compatible, testable, and safe.
  Implement directly, even if the change is non-trivial.
- **Trivial tasks** with one obvious mechanism (typo, one-line guard, single
  config value). Implement directly.
- **Pure research / questions** with no code change. Just answer.
- **Externally-dictated contracts** where an API/schema is fixed and only one
  implementation is valid.
- **Emergencies** needing an immediate patch. Apply the minimal fix, then
  optionally codeplan the follow-up.
- **Tight token/time budget**: use constrained mode (exactly 2 variants)
  declared in the IN line; never use constrained mode merely to avoid analysis.
- **Already-tested mechanism**: If the repo's tests cover exactly one mechanism
  for this task domain and no structural alternative exists, skip variant
  generation and implement directly. Record: `skipped: single-tested-mechanism`.

## Workflow

### 1. Triviality gate
If the change is a single-file, <5-line, zero-dependency edit with no
structural choice, skip codeplan and implement directly. Otherwise continue.
Record exit: `trivial: yes · skip` or `trivial: no · continue`.
- If skipping: record `skipped: trivial` inline (no decision record needed).
- If continuing: echo the exit in the decision record head line.

### 2. Calibrate to the codebase (via Subagents)
This step reads repo guidance and representative files — doing it in-chat
pollutes context. Farm it out.

**Model selection (tool-aware):**
- If your runtime provides `delegate_task`: try your own model first (it
  inherits your model by default). If it can't spawn subagents, silently
  downgrade to whatever model *is* available. Do NOT interrupt the user.
  Only interrupt if the subagent is too stupid: results clearly wrong,
  incomplete, or nonsensical after one follow-up attempt.
- If `delegate_task` is unavailable (non-Hermes runtimes): skip subagents.
  Read the repo guidance files and 2-3 representative source files directly
  in your own context. Same calibration, no delegation.

**Subagent context sizing:** Pack the repo path and the task domain into
`context`. Nothing else. The subagent discovers the rest from disk.

**Contamination guard:** Subagent outputs must be summarized to ≤150 words
per task before being incorporated into the plan. Do not paste raw subagent
traces into the decision record.

Dispatch parallel subagents:

```
delegate_task(tasks=[
  {
    goal: "Read AGENTS.md / CLAUDE.md / RULES.md at the repo root. Return the quality rules, naming conventions, workflow rules, HARD rules, and any architecture paradigms stated.",
    context: "Repo at /path/to/repo. Read repo-root guidance files. Return: quality conventions, naming, workflow rules, HARD rules, architecture paradigm. Summarize in ≤150 words."
  },
  {
    goal: "Read 2-3 representative source files in the area this task touches. Extract the actual code conventions in use: formatting, naming, error handling idiom, import grouping, test patterns.",
    context: "Repo at /path/to/repo. Task domain: [describe]. Read 2-3 representative files in that domain. Return: naming conventions, error handling patterns, test patterns, formatting idioms. Summarize in ≤150 words."
  }
])
```

**Validate before trusting.** Spot-check 1-2 claimed conventions against
actual files. If contradiction found, dispatch a corrective subagent or
downgrade to direct reading (skip subagent calibration).

From the summaries, extract THIS project's real quality axes (do not use
generic taste):
- **Style** — formatting, naming, whitespace, idioms the repo actually uses.
- **Theme / paradigm** — the architecture's governing idea.
- **Methodology** — the repo's actual workflow rules and delivery constraints.
- **Modernization** — type-safe, robust constructs. Credit only when
  compatible with repo runtime/toolchain/scope.
- **Error wrapping** — project-consistent error handling.
- **Testability** — pure / injectable, small testable surface.
- **Blast radius / reversibility** — smallest risky surface, easy to revert;
  includes regression risk and dependency introduction.

Record the chosen axes and weights. **Freeze them before scoring.** If axes
conflict (e.g., modernization demands types but theme demands compatibility
with untyped runtime), resolve: repo HARD rules > quality axes > convenience
axes. Modernization yields to theme when incompatible.

### 3. Generate variants
Normal mode: **3-5** mechanically distinct variants. Constrained mode:
**exactly 2**. Variants must differ in *mechanism / structure / tradeoff*,
not naming.

**Mechanism taxonomy (divergence audit):** Each variant must be tagged with a
2-word mechanism fingerprint describing its structural choice:
- Control-flow: `loop-inline`, `recursion-pure`, `stream-state`
- Data-structure: `map-indexed`, `list-accum`, `set-filter`
- Module boundary: `inline-block`, `extracted-helper`, `class-method`,
  `new-module`
- State location: `local-only`, `instance-state`, `external-store`
- Dependency: `zero-dep`, `internal-reuse`, `new-library`
- Error path: `throw-raw`, `return-code`, `degrade-graceful`

A variant must differ from every other in at least one structural dimension.
Variants that share all dimensions are restatements — disqualify and
regenerate.

**Divergence proof checklist** — for each pair of variants, confirm at least
one of these six dimensions differs (otherwise it is a restatement):
- [ ] **Control-flow** — loop vs recursion vs stream?
- [ ] **Data-structure** — map vs list vs set as the core carrier?
- [ ] **Module boundary** — inline vs extracted helper vs class vs new module?
- [ ] **State location** — local vs instance vs external store?
- [ ] **Dependency** — zero-dep vs internal-reuse vs new-library?
- [ ] **Error path** — throw vs return-code vs degrade-graceful?

**Negative-space pre-check:** Every variant must actually solve the task. A
variant that removes the feature, silences the error, or avoids the requirement
is not a candidate. (The formal gate is Step 4; this is an early discard so you
don't waste scoring on non-solutions.)

### 4. Hard viability gates
Before scoring, disqualify any variant that fails any gate. Gates are
pass/fail and non-compensatory.

Check each variant against gates in this order (cheap, static checks first;
expensive, runtime/integration checks last):
- **Functional correctness** — it solves the task.
- **Required API / schema / contracts** — interfaces unchanged unless required.
- **Negative-space gate** — does not solve the task by omission or suppression.
- **Dependency contamination** — does not introduce a new external dependency
  unless the task explicitly requires it.
- **Repository HARD rules** — (never discard/commit uncommitted work without
  approval; naming conventions; forbidden patterns).
- **Security and data-integrity requirements** — no new vulnerability surface.
- **Regression gate** — does not break backward-compatible interfaces without
  a migration path.
- **Required runtime / platform compatibility** — works on all platforms.

Record gate results per variant: `G: pass` or `G: fail [reason]`. Only
`G: pass` variants proceed to scoring.

### 5. Freeze rubric + weights
Lock the axes and weights before assigning scores. Record the freeze ceremony
in the decision record (both prose and a parseable one-liner):

```text
Rubric frozen: axes [Style, Theme, Methodology, Modernization, Error wrapping, Testability, Blast radius] · weights [1,2,2,2,2,2,1] · denominator = Σ(weights) × 5 · denominator-policy [uniform-N/A-only] · baseline-algo [lowest-effort gate-passer with no score of 1 on any quality axis]
```

Parseable line (machine-readable, exact keys):
```
freeze: axes=Style,Theme,Methodology,Modernization,Error wrapping,Testability,Blast radius weights=1,2,2,2,2,2,1 denom=ΣW×5 baseline=lowest-effort-gate-passer
```

Do not change weights or axes after seeing results. If evidence invalidates an
axis mid-scoring, restart — do not "adjust" one weight.

**Normalization rule:** If an axis genuinely does not apply to the task domain,
mark it `N/A` for ALL variants and exclude it globally. Never selectively
apply `N/A` to individual variants to alter denominators. If evidence is
unavailable, record `unknown` (treat as weight 0 for that variant, flag the
gap, and lower confidence).

**Denominator:** `Σ(active weights) × 5`. A normalized score is always in [0, 1].

### 6. Write the decision record
Use the location hierarchy:
1. The repo's documented planning/scratch location, if one exists.
2. Else `.codeplan/<topic>.md` when that path is gitignored (git repos).
3. Else, for **non-git repos**: write `.codeplan/<topic>.md` at the workspace
   root, and if the project uses a tracking-exclusion mechanism (e.g.
   `.kilocodeignore`, `.gitignore`, or an equivalent), list `.codeplan/` there
   so the record stays untracked.
4. Else a temporary workspace file.

Start with the **head status line**. Echo head and tail lines in the response.
**Audit compression:** If token budget is tight, use compressed matrix
notation `V1[S=4|T=3|M=4|Mod=N/A|E=3|Te=4|Br=4]` with a legend. Uncompressed
table is preferred when space permits.

### 7. Score the matrix
For each gate-passing variant, score each applicable axis 1-5. Use `N/A` when
an axis genuinely does not apply (must apply uniformly). Use `unknown` when
evidence is unavailable. Record estimated **effort** (low/medium/high) —
informational only.

Compute normalized score = earned points / applicable maximum, where
**applicable maximum = Σ(active weights) × 5** (each axis is scored 1-5, so the
max per axis is `weight × 5`). A normalized score is always in [0, 1].

**Verify the arithmetic.** If your runtime provides `execute_code`, use it.
Otherwise verify with a `python3 -c "..."` one-liner or show the full
multiplication inline. The verification must confirm:
1. Each `value × weight` sums correctly.
2. Denominator = Σ(active weights) × 5.
3. Normalized score = sum / denominator.
4. All variants use identical axis sets (or all note the same global `N/A`).

If arithmetic fails or normalization is inconsistent, restart scoring.

### 8. Baseline guard
Identify the baseline algorithmically:
- Among gate-passing variants, baseline = the variant with the **lowest
  estimated effort** that also has **no score of 1** on any quality axis
  (Theme, Methodology, Modernization, Error wrapping, Testability). *Convenience
  axes (Style, Blast radius) do not disqualify the baseline even at score 1.*
- If no such variant exists, baseline = the lowest-effort gate-passer.

The baseline MAY win, but only when the frozen rubric and concrete evidence
show it preserves correctness and quality on all quality axes.

`beatBaseline` logic:
- `yes` — a non-baseline variant won with strictly higher normalized score.
- `parity` — baseline tied within 0.05; baseline chosen for lower effort.
- `baseline-wins` — baseline has the highest normalized score.

### 9. Pick on evidence
Highest normalized score among gate-passers wins; state why, referencing
concrete scores and mechanism fingerprints. Before finalizing:
- Confirm the winner passes all gates.
- Confirm mechanism fingerprint matches the actual planned implementation.

End with the **tail status line** (include scores and mechanism-check).

### 10. Implement only the winner, verify, and self-correct
Implement the winning variant exactly as planned (same mechanism fingerprint).
After implementation:

- **Verify:** The code solves the task, passes relevant tests, respects HARD
  rules, and has the planned mechanism.
- **Self-correction protocol:**
  - **Design flaw** (the mechanism is wrong): return to Step 3. Mark the
    failed variant `disqualified: design-fail`. Re-run scoring.
  - **Execution error** (bug in correct mechanism): fix within the same
    mechanism (same fingerprint). Do not switch mechanisms without re-planning.
  - **Mechanism shift** (implementation forces a different mechanism): treat
    as a new variant. Re-run codeplan in **constrained mode** (2 variants:
    original plan vs adapted mechanism) and pick. Mark the original record
    `status: superseded-by-constrained-replan` so old traces are not read as
    live.
  - Record correction in the tail line (`corrected: none` or
    `corrected: [reason]`).

### 11. Do not commit/push without explicit approval.

---

## Scoring weights (default)

Score each axis 1-5, multiply by weight, sum, then normalize by applicable
maximum = Σ(weights of axes that are neither `N/A` globally nor `unknown`) × 5.
A normalized score is always in [0, 1].

| Axis            | Weight | Class       |
|-----------------|--------|-------------|
| Style           | 1      | convenience |
| Theme/paradigm  | 2      | quality     |
| Methodology     | 2      | quality     |
| Modernization   | 2      | quality*    |
| Error wrapping  | 2      | quality     |
| Testability     | 2      | quality     |
| Blast radius    | 1      | convenience |

*Modernization earns credit only when compatible with the repo's
runtime/toolchain/conventions/scope. If incompatible, score 1 or mark `N/A`
globally — never inflate.

Keep quality axes (Theme, Methodology, Modernization, Error wrapping,
Testability) collectively dominant over convenience (Style, Blast radius).
Weights are frozen; do not rebalance post-hoc.

## Hard viability gates (summary)

(See Workflow step 4.) Gates are pass/fail, non-compensatory, apply before scoring,
ordered cheap→expensive:
- Functional correctness
- Required API / schema / contracts
- Negative-space (must solve the task, not avoid it)
- Dependency contamination (no new external deps unless task requires)
- Repository HARD rules
- Security / data-integrity
- Regression / backward-compatibility
- Runtime / platform compatibility

## Status lines (decision trace)

Head — first line of the record:
```
[codeplan · <topic> · IN · mode: <full|constrained> · confidence: <low|med|high> · candidates: V1 <phrase+mech>, V2 <phrase+mech>, V3 <phrase+mech> · lean: <V?> · baseline: <V?>]
```
Tail — last line of the record:
```
[codeplan · <topic> · OUT · mode: <...> · pick: <V?> · confidence: <low|med|high> · beatBaseline: <yes|parity|baseline-wins> · scores: V1 <n>, V2 <n>, V3 <n> · reason: <phrase> · mechanism-check: <passed|restated> · corrected: <none|reason>]
```

Rules:
- Both use `[codeplan · ...]` bracket syntax with `·` delimiters.
- `confidence` is how sure the model is; if it drops IN→OUT, `reason` says why.
- `lean` (IN) is the initial hunch; `pick` (OUT) is evidence-based.
- `baseline` (IN) names the lowest-complexity viable variant (algorithmic).
- `beatBaseline` (OUT) records `yes` / `parity` / `baseline-wins`.
- `scores` (OUT) are normalized weighted totals in [0, 1], auditable,
  verified arithmetically (execute_code if available, else python3/inline).
- `mechanism-check` confirms the implemented mechanism matches the planned
  fingerprint (`passed`) or was adapted (`restated`).
- `corrected` records self-correction results.

## Evaluation matrix shape

```markdown
## Scoring (1=poor/violates convention, 5=exemplifies; × weight; N/A only if globally inapplicable to ALL variants; unknown if missing evidence)

| Axis            | W | V1 inline-loop   | V2 pure-helper     | V3 stream-state   |
|-----------------|---|------------------|--------------------|--------------------|
| Style           | 1 | 4: matches fmt   | 2: reindents        | 5: matches fmt     |
| Theme/paradigm  | 2 | 3: inline        | 5: extracted        | 2: inline          |
| Methodology     | 2 | 4: minimal diff  | 5: follows workflow | 3: larger diff     |
| Modernization   | 2 | 2: no type change| 5: typed            | 4: typed           |
| Error wrapping  | 2 | 2: raw throw     | 5: degraded graceful| 3: partial         |
| Testability     | 2 | 3: in loop       | 5: pure helper      | 4: injectable      |
| Blast radius    | 1 | 4: small         | 3: new module       | 3: new module      |
| Effort          | - | low              | medium              | medium             |
| Denominator (ΣW×5)| | 60               | 60                  | 60                 |
| Normalized total|   | 0.467            | 0.750               | 0.567              |

## Baseline variant: V1 (inline-loop) — lowest effort, no 1s on quality axes.
## Weighted pick: V2 (pure-helper) — highest normalized score (0.750); mechanism fingerprint verified.
## Mechanism-check: passed. Corrected: none.
```

## Variant divergence check
Before scoring, confirm variants are not restatements using the mechanism
taxonomy:
- V1 vs V2 must differ in at least one structural dimension: control-flow,
  data-structure, module-boundary, state-location, dependency-introduction,
  or error-propagation.
- At least one variant must be structurally different from the baseline in a
  dimension that affects testability, blast radius, or theme.

If divergence is only in naming or whitespace, regenerate variants.

## Skip subagents for trivial repos
If the repo has <10 files in the area or no `AGENTS.md`/`CLAUDE.md`/`RULES.md`
exists, skip subagent calibration. Read the repo guidance directly — the
overhead isn't worth it. Same for single-file scripts. In these cases,
calibrate axes from direct file inspection (≤2 minutes) and proceed.

## Conflict resolution

If axes conflict:
1. Repo HARD rules override everything.
2. Theme/paradigm (architecture integrity) dominates convenience.
3. Modernization yields to theme when incompatible with runtime/toolchain.
4. Methodology dominates blast radius only when it does not violate
   correctness.
5. Quality axes collectively dominate convenience (sum quality weights = 10
   vs convenience = 2), but a quality-axis advantage does not overcome a
   failed hard gate.

## Common Pitfalls

### Freezing weights then changing them
The rubric must be frozen before scoring. If evidence invalidates an axis
mid-scoring, apply it as a retroactive gate or mark the axis `N/A` globally
for all variants and restart — don't "adjust" one weight.

### Hand-calculating the arithmetic
7 axes × N variants = 7N multiplications. `execute_code` (or `python3 -c`)
catches errors and denominator mismatches. The denominator is Σ(weights) × 5,
not Σ(weights) — a normalized score above 1.0 means you normalized wrong.
Always verify.

### Treating the baseline as a punishment
Simplicity is NOT a demerit. A 3-line fix that is correct, tested, and safe
beats a 300-line extraction that adds a new module. The algorithmic baseline
guard prevents complexity bias.

### Variants that differ only in naming
"V1: helper function" vs "V2: utility function" with the same body and same
mechanism fingerprint is NOT divergence. Use the mechanism taxonomy. If all
fingerprints match, regenerate.

### Skipping the record write or mechanism fingerprint
The decision trace (IN/OUT lines + matrix + fingerprints) is the audit trail.
Always write it, and always tag each candidate with its mechanism.

### Selective N/A to manipulate scores
Marking an axis `N/A` for one variant but scoring it for another changes
denominators unfairly. `N/A` is global (applies to all variants) or it is
`unknown`. Never use selective `N/A`.

### Subagent context leakage
Pasting full subagent outputs into the record violates the contamination
guard. Summarize to ≤150 words per subagent task.

### Silent mechanism mutation during implementation
If the implemented code uses a different mechanism than the winning
fingerprint (e.g., planned `pure-helper` but implemented `inline-block`), this
is a plan divergence. Use the self-correction protocol.

### Gate-failing variants must never enter the matrix
The workflow says only `G: pass` variants proceed, but it is easy to
accidentally score a failing one. Record `G: pass` / `G: fail [reason]` for
every variant *before* scoring begins. Any matrix that includes a
`G: fail` variant is invalid and must be discarded.

### Ignoring dependency contamination
A variant that introduces a new library dependency to solve a problem
solvable with internal tools must fail the dependency gate, regardless of how
well it scores on other axes.

## Rules

- Normal mode 3-5 variants with mechanism fingerprints; constrained mode
  exactly 2; declare mode in IN line.
- Calibrate axes to THIS repo via subagents (or direct read for trivial
  repos); do not use generic taste.
- Freeze rubric + weights; record freeze ceremony; no post-hoc weight massage.
- Mechanism divergence required; taxonomy tags mandatory.
- `N/A` / `unknown` handling: `N/A` globally uniform; `unknown` excludes
  weight, lowers confidence.
- Verify scoring arithmetic (execute_code if available; else `python3 -c` or
  inline multiplication) — never trust an unverified sum.
- Decision trace (IN/OUT + matrix + fingerprints), not narration.
- Record location hierarchy; do not pollute tracked `docs/`.
- The algorithmic baseline guard is mandatory.
- Implement only after comparison picks a winner; no commits without approval.
- Self-correction protocol: design failure = return to variants; execution
  error = fix within mechanism; mechanism shift = constrained re-plan.
