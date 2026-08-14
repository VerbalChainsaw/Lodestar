---
name: ladder-audit
description: "Use when a meaningful end-to-end feature, workflow, agent task, or runtime outcome crosses several plausible failure owners and the full test is slow, expensive, stateful, or ambiguous. Produces a read-only inside-out scaffold-fading plan: preserve the unchanged real outcome, start at the deepest unproven capability boundary with outer prerequisites supplied, remove one capability-class scaffold per rung, qualify independent oracles, reset ordinary state, pre-fix only proven shared contradictions, and graduate through the unchanged outcome plus recovery when relevant. Also use to review an existing test plan for coupled variables, hidden state, overfitting, weak oracles, or unnecessary runtime discovery. Do not use for one localized defect, routine unit-test design, random fuzzing, broad certification, or as a substitute for final end-to-end proof."
metadata:
  version: "1.1.0"
  methodology: "outcome-anchored-scaffold-fading"
  tags: [testing, debugging, integration, curriculum, capability, preflight, audit]
  compatibility: "Agent Skills-compatible coding agents with repository read access. Test runners, fixtures, disposable environments, observability, and subagents are optional accelerators. The audit itself is read-only."
---

# Ladder Audit

Turn one real outcome into the smallest sequence of experiments that makes each failure informative.

The method is inside-out, but execution begins at the **deepest unproven boundary**, not automatically at the innermost loop:

1. Preserve the unchanged final outcome.
2. Freeze capabilities already proven by relevant evidence.
3. Supply outer prerequisites around the deepest unproven capability.
4. Remove one capability-class scaffold per rung.
5. Stop at the first material failure and route it to one owner.
6. Graduate through the unchanged real outcome.

This is not a recipe generator, a test matrix factory, or permission to teach production the answers.

## Progressive disclosure

This file is sufficient for ordinary use.

- Load [the formal output template](references/output-template.md) only when the user requests a reusable audit artifact, a downstream implementation contract, or a complex multi-track plan.
- Load [worked examples](references/worked-examples.md) only when applying the method to an unfamiliar domain or when rung orthogonality is disputed.
- Do not load both references merely for reassurance.

## Relationship to other skills

- Use **Center Audit** when one falsifiable defect claim already owns the failure.
- Use **Ladder Audit** when a broad outcome still has two or more plausible failure owners.
- Use **Regression Scout** after a repair to check adjacent surfaces touched by the change.

A failed rung should usually become a bounded Center Audit case. Implementation is a separate phase.

## Applicability and value gate

Use Ladder Audit when either condition holds:

- At least two independently failing capability classes remain plausible.
- A full run is costly or ambiguous enough that focused separation materially improves diagnosis.

Return `NOT_APPLICABLE` when one owner is already localized, the outcome is simple, or the proposed ladder costs roughly as much as the broad run without reducing uncertainty.

Every detailed rung must pass this value test:

```text
Will this rung materially narrow failure ownership, prove a reusable boundary,
or reject a source-level contradiction earlier than the broad run?
```

If not, remove or merge it.

Default to **3-7 detailed rungs in the next diagnostic tranche**. If the full capability graph needs more, group later work into provisional tracks and recommend only the next tranche. Do not manufacture a twenty-rung master ceremony before evidence reaches it.

## Core doctrine

1. **Outcome first.** Start from one real user or product result, not a toy capability list.
2. **Unchanged graduation.** Record the exact final request or workflow before designing rungs.
3. **Deepest unproven boundary.** Do not re-prove accepted inner primitives without new contradictory evidence. Every freeze is scoped to its revision, environment, and contract.
4. **One new material uncertainty per rung.** Remove one capability-class scaffold while holding other unproven conditions fixed. A paired boundary is allowed only when evidence shows the responsibilities cannot be isolated.
5. **External scaffolds only.** Fixtures and supplied prerequisites live in test setup, not hidden production branches.
6. **Qualified independent oracle.** Success must be observable outside the action's own claim and sensitive to failure.
7. **Clean ordinary rungs.** Restore relevant durable and environmental state unless the rung explicitly tests recovery.
8. **Evidence-gated pre-fixes.** Pre-fix only proven shared contradictions at existing ownership seams.
9. **Stop at first material failure.** Localize and repair before advancing outward.
10. **Bounded transfer.** Use one or two meaningful variations to detect test-shaped production logic.
11. **Final authority remains broad.** Component success never replaces unchanged end-to-end acceptance.
12. **Recovery is explicit.** Add Stop, retry, restart, timeout, or duplicate-request rungs only when the real outcome claims them.

## Terms

- **Outcome contract**: the real result, permissions, identities, and observable postconditions.
- **Capability class**: one responsibility that can fail independently, such as parsing, binding, execution, persistence, or verification.
- **Scaffold**: a test-only supplied condition that removes one capability class from the current rung.
- **Rung**: one experiment that activates one newly unproven capability class.
- **Transfer probe**: one bounded variation proving the repair is shared rather than memorized.
- **Graduation gate**: the unchanged broad outcome from its natural starting condition.

## Audit frame

Capture this before exploring implementation details:

```text
LADDER AUDIT FRAME
  Mode:                    DESIGN | TRIAGE | REVIEW
  Repository / system:     <path, service, package, or N/A>
  Target revision/state:   <commit, snapshot, build, environment>
  Workspace state:         CLEAN | DIRTY | NON-GIT | UNKNOWN
  Real outcome:            <one sentence>
  Unchanged graduation:    <exact request, API call, workflow, or scenario>
  Independent final oracle:<observable final postconditions>
  Current failure:         <observation or none>
  Full-run cost:           <time, money, mutation, setup, ambiguity>
  Reset mechanism:         <fixture, snapshot, fresh namespace, container, transaction>
  Proven contracts:        <relevant boundaries to freeze>
```

## Workflow

### 1. Define the outcome contract

Record:

- exact requested result
- authorized and forbidden mutations
- exact identities that must survive, such as user, order, record, target, site, fixture, transaction, or artifact
- final observable postconditions
- natural graduation state
- retry, cancellation, or restart expectations

A rung may supply prerequisites. It may not weaken the final contract.

### 2. Build the bounded capability map

Trace only capabilities required by the outcome. Mark each node:

```text
PROVEN       relevant evidence already accepts the boundary
UNPROVEN     required but not independently established
CONTRADICTED source or runtime evidence violates the required invariant
EXTERNAL     owned by a dependency or environment outside this codebase
```

Common classes include intent and authorization, plan compilation, state representation, dependency acquisition, target binding, deterministic execution, ownership/concurrency, persistence, verification/settlement, recovery, and cleanup.

Do not turn the map into a whole-repository architecture tour.

### 3. Choose the deepest unproven boundary

Find the shortest path from supplied prerequisites to one independently verifiable effect.

Examples:

- build system: validated graph -> execute one target -> verify artifact
- import service: parsed row -> persist normalized record -> verify transaction state
- agent workflow: typed tool invocation -> correlated result -> verify exact target effect
- game builder: audited next cell -> place -> verify

If this inner loop is already proven, skip it. Start at the nearest outward boundary that remains unproven or contradicted.

### 4. Inventory scaffolds

List every supplied simplification and the capability it temporarily removes:

- final inputs supplied
- exact target prebound
- plan prevalidated
- authentication established
- dependency or workstation already available
- concurrency disabled
- retries disabled
- natural-language interpretation bypassed
- clean process and durable state supplied

Every in-scope scaffold needs a removal rung or an explicit statement that it is outside the final outcome.

### 5. Design the next diagnostic tranche

Use only tracks required by the capability map, typically:

- execution and verification
- dependency acquisition
- environment and target binding
- intent and orchestration
- persistence and recovery

For each rung, record:

```text
RUNG <ID>
  Claim:                    <one capability invariant>
  Proven baseline held:     <what remains fixed>
  Scaffold removed:         <one material simplification>
  Newly active capability:  <one owner>
  Initial state:            <exact manifest or fixture>
  Request:                  <command, API call, workflow, or scenario>
  Qualified oracle:         <external postconditions and identity checks>
  Failure route:            <owner and next method>
  Reset rule:               <fresh, restore, or intentional persistence>
  Transfer probe:           <one bounded variation or N/A>
  Passing freezes:          <the accepted reusable boundary>
```

Before execution, mark the rung `READY` or `BLOCKED`. After execution, use `PASS`, `FAIL`, or `INCONCLUSIVE`. Setup, reset, or observer failure is `BLOCKED`; ambiguous evidence is `INCONCLUSIVE`; neither is a product failure.

Reject or split a rung when one removed item activates several unproven classes. If two responsibilities are physically inseparable, mark a minimal paired boundary, name both owners, and use a contrast or ablation that can distinguish their contributions. For nondeterministic systems, specify the repetition count or statistical threshold before execution; one lucky pass is not proof.

### 6. Qualify the oracle

An oracle is acceptable only when it includes:

1. **Pre-state** proving the outcome was not already satisfied.
2. **Expected delta** or exact final identity.
3. **Independent observer** such as database state, filesystem hash, server state, external API response, or separately captured runtime state.
4. **Sensitivity evidence** through a failing-before case, negative control, or a demonstrated ability to detect a known wrong state when practical.

If the oracle is unavailable, stale, or cannot distinguish the requested target from an easier substitute, the rung is `INCONCLUSIVE`, not passed.

### 7. Run the pre-fix gate

A pre-fix is eligible only when all are true:

1. Prior runtime evidence or current source directly contradicts the required invariant.
2. The invariant is shared, not a scenario noun or known-answer route.
3. The repair belongs at an existing ownership seam.
4. A focused failing-before and passing-after check is possible.
5. Final broad acceptance will still run.

Typical eligible contradictions include flattened multiblock state, lost exact identity, false acceptance correlation, non-idempotent replay, terminal results erased before acknowledgement, premature ownership release, or success recorded before verification.

Suspicion alone becomes a rung or Center Audit case, not a speculative edit.

### 8. Isolate and reset

Every ordinary rung needs a manifest covering relevant revision, dependencies, runtime, namespace, initial data/files/inventory, active jobs or locks, configuration, and log or trace correlation.

Fail closed on stale state, wrong environment, failed setup, concurrent test traffic, unexpected identity, or an already-satisfied oracle.

Only recovery rungs intentionally preserve partial state, and they must name exactly what survives.

### 9. Execute and route

For each rung:

1. Assert the initial-state manifest.
2. Run the request without coaching production behavior.
3. Capture the qualified oracle.
4. Stop at the first material failure.
5. Route an unproven localized defect to Center Audit, or implement an already-proven repair separately.
6. Rerun the same rung, then its transfer probe.
7. Freeze the accepted boundary for the tested revision, environment, and contract, then advance.

Do not compensate with longer timeouts, extra retries, or scripted shortcuts unless evidence proves the budget itself is the defect.

### 10. Transfer and graduate

Use one or two materially different probes after a meaningful tranche, such as another valid input family, orientation, target, dependency implementation, batch size, or a closer decoy that must not satisfy exact identity.

Graduation requires:

- the exact unchanged request or workflow
- the natural initial state
- independent final-state verification
- no hidden rung provisioning
- no scenario-specific production branch
- one controlled recovery replay when recovery is claimed

A ladder without graduation proves components, not the product.

## Review mode

When reviewing an existing plan, flag:

- several new capability classes introduced in one scenario
- a claimed one-class rung whose responsibilities are not actually separable
- no exact initial-state manifest or reset rule
- cumulative state leakage
- fixtures that expose the expected answer to production
- weak or vacuous oracles, or no distinction between `BLOCKED`, `INCONCLUSIVE`, and product `FAIL`
- scenario-name, rung-ID, fixed-coordinate, or canned-route logic
- arbitrary input removal that activates several owners
- repeated testing of already accepted primitives
- no transfer probe or unchanged graduation gate
- runtime used to discover an obvious source-model contradiction
- a ladder whose setup cost exceeds its diagnostic value

## Stop conditions

Stop and report rather than expanding when:

- one failed rung has localized the defect
- a safety, permission, or irreversible-mutation boundary is reached
- the oracle cannot be qualified
- the environment cannot be reset or isolated truthfully
- the next rung does not reduce uncertainty
- the next rung costs roughly as much as graduation
- more than seven detailed rungs are needed before any implementation; group them into tracks and recommend one tranche

## Do not encode

Never add production logic for rung IDs, fixture names, campaign IDs, known coordinates, expected action sequences, or supplied answers. Never let a nearer substitute satisfy an exact-identity continuation. Never reuse leftovers between ordinary rungs. Never call a scaffolded pass full autonomy.

## Default output

For ordinary requests, use these headings:

### Applicability
### Outcome and Graduation
### Capability Map
### Next Ladder Tranche
### Pre-Fix Candidates
### Isolation and Oracles
### Failure Routing
### Recommended First Rung
### Do Not Encode

Keep the answer proportional. Use [the formal output template](references/output-template.md) only when a durable downstream contract is needed.

## Completion standard

The audit is complete when it gives an applicability verdict, one unchanged outcome, a bounded capability map, explicit scaffolds, a valuable orthogonal next tranche, qualified oracles and reset rules, evidence-gated pre-fixes, bounded transfer probes, defect routing, and exactly one recommended first rung.

The audit does not claim the system works. It creates a path where the next failure teaches us something useful.
