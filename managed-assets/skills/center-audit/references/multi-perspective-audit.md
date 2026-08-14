# Multi-perspective audits and the subagent-timeout recovery pattern (added 2026-06-24)

## When to use multiple perspectives

Multi-perspective audits are warranted when:

- The surface is large (>2,000 lines) and a single lens cannot cover all the defect shapes (data-flow, contract, lifecycle, cross-process, UI, spec).
- The audit's "Independent witness and convergence" rule requires genuinely independent channels. Different lenses read different artifacts and test different invariants; agreement raises confidence, disagreement becomes a contradiction.
- A single-perspective finding would need a second confirmation to be HIGH-confidence (per `references/severity-rubric.md`).

When NOT to use multiple perspectives:

- The defect is well-localized (one file, one invariant). One perspective is enough.
- The surface is small (<1,000 lines) and the audit lens is unambiguous.
- The user wants a single answer, not a converged cross-lens synthesis.

## The 2026-06-24 multi-perspective audit pattern (worked example)

The VerbalChainsaw/opencode GUI/Desktop audit on 2026-06-24 used 6 independent perspectives. The structure:

| Perspective | Lens | Typical verdict |
|---|---|---|
| 1 | Data-flow (state propagation plugin → renderer → UI) | DEFECT_CONFIRMED on polling-vs-event-stream |
| 2 | Contract (renderer ↔ server ↔ preload ↔ main boundary shapes) | Often NO_DEFECT_CONFIRMED — contract audits are usually clean |
| 3 | Lifecycle (boot, handoff, restart, corrupt-state recovery) | DEFECT_CONFIRMED on cross-session terminal state, corrupt recovery, lazy handoff |
| 4 | Cross-process state mutation (renderer ↔ Electron main ↔ HTTP ↔ plugin) | DEFECT_CONFIRMED on silent-drop on IPC write rejection |
| 5 | UI contract drift (spec ↔ renderer ↔ i18n ↔ tokens) | Often DEFECT_CONFIRMED on spec/implementation drift |
| 6 | Spec drift (spec files ↔ implementation ↔ HANDOFF claims) | Often NO_DEFECT_CONFIRMED — specs and fixes usually hold |

The combined report merges defects found by 2+ perspectives into a single cluster. Disagreements become contradiction entries in the contradiction ledger; agreement raises confidence.

## Subagent dispatch discipline

**Subagents may time out.** The 2026-06-24 audit dispatched 5 subagents in parallel for perspectives 2-6. Three returned cleanly. One (perspective 4, cross-process) returned with a truncated file (CASE FILE + CLAIM + FUSION only — missing the evidence ledger and repair contract). One (perspective 6, spec drift) timed out at 600s with 53 API calls and no file written.

**The discipline that worked:**

1. **Always require a written file as the subagent deliverable.** Specify the exact path in the prompt. Do not accept "the work was done" as a deliverable.
2. **Subagent prompt must specify the lens, allowed/forbidden files, evidence channel, and expected output format.** The 2026-06-24 subagent prompts included all of these explicitly.
3. **Subagent prompt must include the schema reference path** so the subagent can read `references/output-format.md` directly. Provide both the Hermes path (`C:\Hermes\skills\software-development\center-audit\SKILL.md`) and the Codex path (`<HOME>\.codex\skills\center-audit\SKILL.md`) as fallbacks.
4. **Background-delegated work should be tracked in the lead auditor's todo** so a timeout doesn't go unnoticed.

## Subagent timeout recovery — the verify-then-append pattern

When a subagent times out without writing a file, or returns a truncated file, the lead auditor's recovery pattern:

1. **Verify the central claim directly.** The 2026-06-24 P4 subagent's central claim was "IPC store wrapper in `renderer/index.tsx:97-100` catches every IPC rejection silently." The lead auditor opened the cited file at the cited line numbers and confirmed the pattern. For P6, the central claims were "HANDOFF_AUTOGOAL_AUDIT.md Defects 1/2/3 still hold at HEAD" — confirmed by running the three pinned test files directly (`bridge-chain-webhook.test.mjs`, `session-idle-corrupt.test.mjs`, `goal-chain.test.mjs:455-485`).

2. **File a post-hoc supplement** with the verified-by-hand claims and the explicit coverage gaps. Do not silently rewrite the subagent's evidence. The supplement should make clear what was verified directly vs. what was already covered by adjacent perspectives.

3. **Update the combined report** to reference the supplement instead of "did not return." Change the line counts and verdict tables accordingly.

4. **Do NOT block the workstream** waiting for a subagent that may have already failed silently. The audit's verdict and defect inventory should not depend on a single perspective that timed out.

5. **Log the truncation in the audit log** if you maintain one (`C:\Hermes\arbiter\arbiter.log`). This creates a record of the subagent's failure for future sessions.

## Demonstrating failing-before when the fix is already merged

When auditing a defect whose fix is already in HEAD (e.g. the audit is verifying a prior fix, or the audit is post-fix retrospective), demonstrate failing-before by:

1. **Author the test** asserting the audit invariant (not the proposed diff).
2. **Run the test GREEN** against the current code to confirm the test infrastructure works.
3. **Temporarily revert the fix** to the buggy behavior in the smallest possible patch.
4. **Re-run the test RED** — it must fail for the *expected* reason (the invariant is violated), not for an unrelated reason (mock shape, missing dependency, test framework issue).
5. **Restore the fix** and confirm GREEN.
6. **Commit the test + the fix as a single unit.**

The 2026-06-24 P4 IPC silent drop audit used this pattern:
- Wrote `storage.test.ts` with 13 cases including "setItem propagates the rejection when the bridge rejects" (the audit invariant).
- Confirmed all 13 pass with the fix in place.
- Reverted `setItem` to `bridge.storeSet(name, key, value).catch(() => undefined)` (the old silent-drop pattern).
- Re-ran: exactly the two `setItem propagates the rejection` tests failed. The other 11 tests stayed green.
- Restored the fix: 13/13 green.
- Committed test + fix as a single commit.

The pattern works because the test asserts the invariant, not the diff. A failure due to mock shape would be visible immediately (all 13 fail, not just the 2 invariant-related ones).

## The seven pitfalls of multi-perspective audits (added 2026-06-24)

1. **Subagent truncation looks like a normal return.** Always check the file exists AND has the expected line count before treating a subagent as "done." The 2026-06-24 P4 subagent returned with 200 lines; the expected line count was 600+.
2. **Same-agent restating is not independence.** Dispatching 6 subagents to audit the same code with the same prompt gives 6x the same bias, not 6 independent channels. Each perspective must use a different lens (data-flow vs contract vs lifecycle vs cross-process vs UI vs spec) and a different evidence channel.
3. **Cross-perspective convergence is a high-confidence signal, not a closed-case signal.** If 2 perspectives converge on the same defect, raise confidence to HIGH and merge into one cluster. Do not skip the contradiction ledger — disagreement still needs resolution.
4. **NO_DEFECT_CONFIRMED is a legitimate outcome.** Perspective 2 of the 2026-06-24 audit returned NO_DEFECT_CONFIRMED with 13 disproven concerns. This is the audit's clean-audit-is-success rule working as designed. Do not push back on a NO_DEFECT_CONFIRMED verdict by inventing a finding.
5. **Defect merging loses evidence IDs.** When merging two perspectives' findings of the same defect, the combined report must reference both perspectives' evidence IDs (e.g. "P1 E1-E5 + P5 E1, E11, E13, E14") so the source is traceable.
6. **The combined report is not a copy-paste of the perspective reports.** It is a synthesis: defect clusters, cross-perspective contradictions, priority ordering, and explicit non-scope. The perspective reports stay as the source-of-truth evidence; the combined report is the action surface.
7. **The audit's verdict is independent of how many perspectives found it.** A single perspective that finds a HIGH-confidence, fully-traversed defect (evidence IDs, trajectory, test meta-check) is more trustworthy than 3 perspectives that all stop at suspicion. Quality over quantity.
