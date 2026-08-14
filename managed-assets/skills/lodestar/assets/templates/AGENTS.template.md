# AGENTS.md for <PROJECT NAME>

> Lodestar template. Delete what does not apply. Every line should exist because an
> agent actually did the wrong thing, not because a rule sounded prudent.
> A rule you cannot trace to a real failure is a rule you will regret.

## What this project is

One paragraph. What it does, what the primary deliverable is, and what "working"
means. Agents optimize for whatever you name here, so name the *outcome*, not
the activity.

## What is authorized

State plainly whether direct implementation is allowed, or whether work must be
proposed first. Ambiguity here is why agents write plans instead of code.

- Direct implementation is authorized. <The working deliverable> is the primary goal.

## What is NOT authorized

**This is the section that does the work.** Given an ambiguous task, an agent
tends to build a test harness, a fixture system, an abstraction layer, or a
review artifact. Those resemble progress without risking a wrong answer. Close
those routes off explicitly.

- Do not invoke planning, TDD/test-first, review, verification, soak, or audit
  workflows automatically.
- Do not create a plan unless explicitly asked, and do not split ordinary
  implementation into tiny slices.
- Do not build broad test suites, fixture systems, soak tests, verification
  frameworks, or review artifacts as a substitute for the actual change.
- Do not turn theoretical risks or reviewer suggestions into requirements.
- Do not add or upgrade dependencies without explicit approval and a
  compatibility check.

## Tests

Say what a test is *for* here, or you will get coverage instead of correctness.

- Tests are diagnostics, not the product. Add only focused checks that reproduce
  or prevent a specific observed defect.
- A passing test never substitutes for the real outcome working.
- Tests and quality gates are measuring instruments, not negotiation targets. Never
  weaken, partition, raise, or rewrite an existing gate because implementation grew.
  A genuine threshold change requires explicit Director approval and evidence that
  the product contract changed.

## Inspect and reuse before you build

The rule that prevents the most wasted work: agents rebuild what libraries
already do, because writing new code is easier than reading existing code.

- The project owns *judgment*: goals, policy, safety, budgets, verification, reporting.
- Mature libraries own *mechanics* whenever they already implement them.
- Before writing or expanding an algorithm, inspect the core APIs, installed
  plugins and versions, upstream docs and issues, then established packages.
- Prefer configuring, wrapping, adapting, or upgrading an existing package over
  duplicating it.
- A custom implementation requires live evidence that the installed package
  cannot safely do it and that a thin adapter is insufficient.
- Never create a parallel engine beside an installed one because one case failed.

## The development loop

Describe the loop you actually want, in order. Without this, agents invent their own.

1. Start from a broad, real, user-visible outcome. Do not invent a microscopic
   task before the work demands one.
2. Run it, observe the **first material blocker**, repair the smallest shared seam.
3. Rerun the same scenario. Repeat until it works or a named blocker remains.
4. Add at most one focused regression check for the exposed contract.
5. Verify independently, through real state, not self-report.
6. Commit one meaningful checkpoint and stop.

## Freeze

The rule that stops infinite polishing:

- Once a capability passes real acceptance, **freeze it**. Do not reopen it for
  naming permutations, quantity variations, caller variations, or exhaustive
  edge-case certification unless new evidence exposes a materially different
  failure, or the code is directly changed again.
- Refactors, abstraction cleanup, and duplicate removal are not deliverables by
  themselves. Do them when they remove an observed blocker, not because
  duplication exists.
- Record non-blocking debt for later; prefer a deferred note over expanding the
  active piece of work.

## Scope accretion stop

- Correct orientation does not authorize scope growth. A discovered blocker permits
  only the smallest seam needed to clear it; it does not pull adjacent cleanup,
  refactors, extra test categories, broader audits, or newly found debt into the
  active tranche.
- Hard-stop when work materially exceeds declared scope, requires a second
  independent subsystem or ownership boundary, adds abstractions mainly to satisfy
  size or complexity gates, or successive blockers require different mechanism
  changes.
- Preserve all WIP, freeze the dirty-file inventory, run the smallest useful proof,
  and checkpoint only the coherent completed slice if authorized. Report the trigger
  and propose the next smallest independently gateable tranche; do not continue into
  it automatically.
- Accepted inner capabilities remain frozen unless contradictory evidence or a
  direct change reopens their contract.

## Stop conditions

- Stop when the requested outcome works.
- Stop and report if the work needs credentials, publication authority, a
  destructive operation, or an approval you were not given.
- Never convert a failed runtime result into a documentation-only "complete."
