# Worked Example — AutoGoal Bridge-Webhook Defect (Retrospective Audit)

This is a worked end-to-end CENTER-AUDIT v2.0.1 run on a real defect that was already fixed at the time of the audit. The point is to show the methodology producing an equivalent finding from the same evidence the original audit captured, including a K1 self-correction.

The target: `packages/autogoal/src/control-state.ts:388 [startGoalChain]` paired with `packages/autogoal/src/goal-chain.ts:518-528 [applyChainWebhookToState]`.

## The defect (one-line)

The bridge's `startGoalChain` does not promote the pre-chain state's `metadata.webhook` onto the new chain. `applyChainWebhookToState`'s deletion branch then fires on the first advance because `chain.webhook === undefined`. The CLI path does this correctly via `webhook: "from-state"` in `createGoalChain`; the bridge path does not.

## The case file

```
AUDIT FRAME:
  Mode:             INTERACTIVE
  Repository root:  <HOME>\Development\opencode-source
  Target revision:  c855887a1 (HEAD, with dirty audit scratchpad)
  Baseline:         984434b34 (the commit that bundled the fix 7322f23d2)
  Workspace state:  DIRTY (parallel WIP scratchpad, no code changes)
  Package/service:  packages/autogoal
  Environment:      Node 22+, tsconfig strict, node --test, Windows + bash

DEFECT CLAIM C0:
  Observation:        After a bridge-started chain (via
                      runGoalControlStateFile / startGoalChain) makes its first
                      advance, the new step's metadata.webhook is undefined.
  Expected invariant: The chain advance path must preserve a pre-chain webhook
                      on every step in the chain. The CLI path satisfies this
                      via `webhook: "from-state"` in createGoalChain.
  Suspected violation: startGoalChain in control-state.ts:388 does not read
                      or project the pre-chain state's metadata.webhook onto
                      the new chain. applyChainWebhookToState then deletes
                      state.metadata.webhook because chain.webhook is undefined.
  Center anchor:      EDGE @ packages/autogoal/src/control-state.ts:388-419
                      [startGoalChain] paired with
                      packages/autogoal/src/goal-chain.ts:518-528
                      [applyChainWebhookToState]
  Falsifier:          A reproduction that sets metadata.webhook, starts a chain
                      via the bridge, advances one step, and observes
                      metadata.webhook still defined and equal to the pre-chain
                      value on the new state. If that holds, C0 fails.
  Confidence:        HIGH
  Alt candidates:    none
```

## Pre-flight (5 operations, all committed)

1. `git log --oneline -- packages/autogoal/test/v042-corrupt-surfacing.test.mjs` — baseline for the protected test surface.
2. `git log --oneline -- src/control-state.ts` — recent commits touching the bridge.
3. `grep -nE "writeTextAtomic|writeGoalStateAtomic" packages/autogoal/src/control-state.ts` — atomic write path.
4. Focused read of `packages/autogoal/src/control-state.ts:388-419 [startGoalChain]`.
5. Focused read of `packages/autogoal/src/goal-chain.ts:518-528 [applyChainWebhookToState]`.

No broad greps. No repository tour. The pre-flight surfaced two paths to the same defect — the bridge start and the chain advance — which is the actual contract edge.

## The trajectory

```
CENTER packages/autogoal/src/control-state.ts:388 [startGoalChain]
  -> VALUE existingState.metadata.webhook (if defined), evidence E4
       [no projection of pre-chain webhook onto chain literal]
CENTER packages/autogoal/src/control-state.ts:419 [chain object literal]
  -> STATE chain.webhook === undefined, evidence E4
BOUNDARY packages/autogoal/src/goal-chain.ts:518 [applyChainWebhookToState]
  -> CONTROL deletion branch (chain.webhook === undefined), evidence E1
TERMINAL IMPACT: state.metadata.webhook deleted on first advance
                 for every bridge-started chain

CONTROL packages/autogoal/src/command.ts:755 [CLI chain start]
  -> VALUE webhook: "from-state" opt passed to createGoalChain, evidence E3
CONTROL packages/autogoal/src/goal-chain.ts:362 [createGoalChain]
  -> VALUE sanitizeChainWebhook(existingState.metadata.webhook),
     evidence E2, E3
BOUNDARY chain.webhook === sanitized webhook, evidence E3
TERMINAL IMPACT: CLI-started chains preserve webhook on every advance

Unproven links: none
Hypothesis-only branches: none
```

The defect shape is a PAIRED center (startGoalChain ↔ applyChainWebhookToState) where one side does the projection and the other deletes when it's missing. The CLI path closes the loop; the bridge path leaves it open.

## The K1 self-correction

Mid-audit, I cited the spec as `packages/autogoal/specs/v0.5.0-feature-work-orders.md §E-1`. The actual webhook spec lives at `packages/autogoal/specs/v0.4.0-roadmap.md` Phase 3 ("Webhook Notifications"), lines 313-345. The v0.5.0 file does not name webhook as section E-1.

**The wrong move** would have been to silently rewrite the evidence row. That conflates "I checked this" with "I want to have checked this." The evidence row would no longer be the audit's claim at the time; it would be a back-edited version.

**The right move** is what the audit actually did:

```
CONTRADICTIONS:

- K1: E7 (spec citation) was originally written as
      "packages/autogoal/specs/v0.5.0-feature-work-orders.md §E-1" —
      which is wrong. The actual webhook spec lives at
      packages/autogoal/specs/v0.4.0-roadmap.md Phase 3 ("Webhook
      Notifications"), lines 313-345, plus the CLI hardening work
      order. The v0.5.0 file does not name webhook as section E-1.
      This is an evidence-anchor error, not a code claim error.
    Status: RESOLVED (E7 re-anchored to the correct spec section;
            the surrounding conclusion is unchanged: the bridge
            path is unnamed in the spec, which is itself a spec
            coverage gap)
    Resolution/confidence effect: C0 confidence unchanged. The
            defect trajectory is independent of which spec section
            is referenced. Spec gap captured as a non-center
            observation below.

- K2: E7 (spec coverage) vs E1+E4 (code)
    Spec Phase 3 documents the webhook metadata field and the
    server-webhook contract test but does not explicitly require
    the bridge path to promote the pre-chain webhook onto
    chain.webhook. Code shows the bridge path violates the
    implicit invariant.
    Status: NONMATERIAL for C0 (the runtime contract holds
            regardless of spec coverage); MATERIAL-UNRESOLVED
            for the spec owner.
    Resolution/confidence effect: C0 confidence unchanged. Spec
            gap captured as a non-center observation.
```

The auditor caught its own mistake and used the contradiction ledger to log it honestly. C0 confidence is unchanged because the defect trajectory is independent of which spec section is cited. The error is recorded; the audit trail is intact.

## The repair contract

```
SMALLEST SUFFICIENT SAFE CHANGE / REPAIR CONTRACT:

Objective:       Promote the pre-chain state's metadata.webhook onto
                 chain.webhook in startGoalChain so applyChainWebhookToState's
                 "delete" branch never fires for a bridge-started chain
                 that inherited a webhook from set.
Required invariant: After a bridge-started chain's first advance, the new
                 step's metadata.webhook must equal the pre-chain webhook.
Allowed scope:   packages/autogoal/src/control-state.ts (startGoalChain,
                 GoalControlChain type).
                 packages/autogoal/test/ (new file pinning the contract).
Forbidden scope: packages/autogoal/src/goal-chain.ts (do not touch
                 applyChainWebhookToState — its deletion branch is correct
                 for chains that genuinely have no webhook).
                 packages/autogoal/src/command.ts (CLI path is correct).
Compatibility:   CLI-started chains must continue to behave identically.
                 Bridge-started chains with no pre-chain webhook must
                 continue to behave identically (the no-prior-webhook
                 case in the existing test).
Reversibility:   Single-function edit + one new test file. Revert by
                 git revert of the fix commit.
```

## Verification

```
VERIFICATION PLAN:
  Failing-before mechanism:
    - Add test/bridge-chain-webhook.test.mjs (positive promotion,
      positive advance-survival, negative no-prior-webhook).
      RED on unfixed code: 1/3 pass.
  Passing-after requirements:
    - All 3 subtests pass.
    - All protected tests (dispatcher-parity, control-state-bridge,
      v042-corrupt-surfacing) remain green.

TEST META-CHECK:
  - test/bridge-chain-webhook.test.mjs (new file)
      Status:             PASSING (after fix lands)
      Assertion match:    YES — asserts metadata.webhook equality on
                          step 1's state, exactly the contract C0 names.
      Oracle independent: YES — derived from HANDOFF_AUTOGOAL_AUDIT.md
                          Defect 1 reproduction log, not from the
                          proposed diff.
      Fixture valid:      YES — uses mkdtempSync and writes a clean
                          state file; no shared fixture.
      Isolated/safe:      YES — runs against a tmp directory; no
                          production data; no network.
```

The fix landed in commit `7322f23d2`. The test `bridge-chain-webhook.test.mjs` has 3 subtests, all passing post-fix. The oracle is independent of the diff — it asserts the contract (metadata.webhook survives the first advance), not the implementation (which line was changed).

## What this example demonstrates

1. **The PAIRED center collapsed a sequence into one contract edge.** The original audit walked through set → chain start → advance as separate symptoms. CENTER-AUDIT identified the actual shape — startGoalChain ↔ applyChainWebhookToState — which is the edge where the contract is broken.

2. **The `webhook: "from-state"` opt in command.ts:755 was the key evidence.** Without reading that specific call site, the defect is invisible. The asymmetry between the two createGoalChain call sites (CLI vs bridge) is the actual defect shape.

3. **The audit caught its own mistake.** K1 was logged honestly; C0 was preserved; the audit trail is intact.

4. **The methodology drives tighter scoping than ad-hoc.** Pre-flight: 5 ops, all targeted. No broad greps. Stopped at Stop 7 because the frontier ended.

5. **The "Repair phase independence" rule (v2.0.1) would have flagged a real risk here.** The test was authored in the same commit as the fix. That's fine in this case (oracle is independent of the diff). But the rule exists so a future agent notices if the test starts asserting "the new function returns the new value" instead of "the contract holds."
