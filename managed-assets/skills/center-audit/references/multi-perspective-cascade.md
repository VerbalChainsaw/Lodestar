# Multi-Perspective Cascade — N CENTER-AUDITs, One Surface, Convergent Findings

A single CENTER-AUDIT covers one defect at one center anchor. Some surfaces need more — a layered stack (renderer + IPC + plugin + HTTP server) where one center anchor won't reach the cross-layer defects, or where the user explicitly asks for "several perspectives, in completion." That is the cascade pattern: N parallel CENTER audits, each with a distinct lens, then merged by the lead auditor.

Cascade is right when:
- The target is a layered surface (GUI + IPC bridge + plugin + HTTP server) and one center anchor won't cover it.
- Cross-layer defects are the dominant failure mode (the data-flow perspective finds something the contract perspective can't, and vice versa).
- The user explicitly asks for multiple perspectives, "in completion," or "from several angles."

Cascade is wrong when:
- A single defect is already identified. Use one audit, not six.
- The target is one module or file. Three lenses at most.
- The user wants a fast yes/no on a specific change.

## Lens design

Choose 4-6 lenses. Each lens:

- **Covers a different surface.** Don't have two lenses read the same file as their primary artifact.
- **Reads different artifacts.** Lenses that both grep for the same string are one lens in disguise.
- **Tests a different invariant.** Data-flow tests ordering and freshness. Contract tests typed shapes. Lifecycle tests boot/restart/recovery. Cross-process tests IPC mutation ordering. UI tests spec-vs-impl. Spec-drift tests docs-vs-code.
- **Specifies "Does NOT look at."** This is the orthogonality discipline. Without it, every lens will gravitate toward the most visible file in the surface and you'll get 6 reports that all flagged the same line.

Lens prompts must be self-contained: each subagent gets the audit frame, the lens scope, the file list to focus on, the "does not look at" list, and the CENTER-AUDIT output format reference. They do not get the lead auditor's evolving conclusions.

## Dispatch mechanics

Use the host's subagent dispatch API for parallel lens runs. One task per lens.

**Host-API awareness (generalized in v2.5.0).** Different hosts expose different prompt-passing surfaces. Some accept structured goal/context fields with templated placeholders; others require flat strings and reject nested structured payloads with errors like `'dict' object has no attribute 'strip'`. Before dispatching N lenses in parallel:

1. Check the host's dispatch API surface (structured vs flat string goal/context fields).
2. When in doubt, write each prompt as one flat string and pass variables by interpolation in your dispatch layer rather than inside the prompt body.
3. Test one lens end-to-end on the actual host before fanning out. A 20-minute cascade that hits a payload-shape error on lens 4 wastes the prior three.

**Concrete instance — hermes `delegate_task`.** This was the original trigger for the host-API awareness note. Hermes's `delegate_task` requires flat strings in the `goal` and `context` fields. Nested placeholder syntax (e.g., `<$text>foo</$text>` inside `text`) fails at dispatch time with `"'dict' object has no attribute 'strip'"`. Write the entire lens prompt as one flat string per task; do not try to template variables inside the prompt body. This pattern is preserved here as a concrete instance — other hosts have analogous quirks; do not assume one host's payload shape is portable.

**Timeout handling.** Other subagents may return in 5-7 minutes; one may run 20+ minutes or until the runner's 600s cap. Synthesize with what arrived. The lead auditor is responsible for noting which lenses returned, which didn't, and the adjacent coverage from the returned lenses for any missing lens.

## Subagent outputs are untrusted

A subagent is a fresh-context worker. It can:

- **Invent line numbers.** Spot-check 2-3 numerical claims per subagent. A subagent that said "35+ inline color uses" may actually mean 369. The lead's combined report cites the verified count, not the subagent's.
- **Truncate mid-section.** A complete CENTER report is 400-1200 lines. A truncated one is 150-250 lines and stops mid-section (typically after CASE FILE + CLAIM + FUSION). If a subagent returns truncated output:
  1. Verify the central claim at the cited line numbers yourself.
  2. If the claim holds, append the missing sections (EVIDENCE LEDGER, DISPROVEN CONCERNS, REPAIR CONTRACT, VERIFICATION PLAN, etc.) yourself, citing only the line numbers you independently verified.
  3. Mark the file with a note like "report truncated by subagent; lead auditor appended evidence ledger after verifying central claim at line N."
  4. If the central claim does NOT hold, return the subagent's report as INCONCLUSIVE and document why.
- **Time out without writing anything.** When `deleg_status` reports `timeout` and no file appears in the expected path, file a post-hoc supplement covering the load-bearing claims that adjacent returned lenses did not cover. Be explicit about what was not audited.

## Synthesis by the lead auditor

Read every full report. Then:

1. **Build a defect crosswalk.** For each confirmed defect, which lenses found it? Which evidence IDs? Are there independent channels (code-static + test-runtime + commit-history) or only one?
2. **Cluster convergent findings.** When two lenses find the same defect from different angles, merge them. Cite both lenses' evidence IDs in the combined finding. Confidence is higher because the channels are independent.
3. **Mark unique findings as single-source.** A defect found by only one lens is not less real, but the combined report should be transparent about that.
4. **Resolve disagreements.** When lenses disagree (e.g. P2 said NO_DEFECT_CONFIRMED on the contract lens while P4 found a defect on the error-propagation lens), don't vote. Surface both views, explain that they look at different axes of the same surface, and identify whether the disagreement is genuine or perspective-dependent.
5. **Prioritize for repair.** Combine severity, blast radius, isolation, and audit leverage into a single ordered list. Priority 1 should be single-file, low-risk, high-leverage. Priority 4 should be mechanical but multi-file.

## Worked example: 6-lens VerbalChainsaw GUI/Desktop cascade (2026-06-24)

Context: a fork of opencode called VerbalChainsaw, v1.0.0, GUI/Desktop surface (SolidJS renderer + Electron shell + HTTP server + AutoGoal plugin).

| # | Lens | Verdict | Defects | Notes |
|---|------|---------|---------|-------|
| 1 | Data-flow (state propagation plugin → renderer → UI) | DEFECT_CONFIRMED | 1 MEDIUM | Polling-vs-SSE defect. |
| 2 | Contract (bridge/control-state IPC boundary) | NO_DEFECT_CONFIRMED | 0 (13 disproven) | All four contracts hold. |
| 3 | Lifecycle (boot, handoff, restart, corrupt recovery) | DEFECT_CONFIRMED | 3 (1 MEDIUM, 2 LOW) | C1 cross-session terminal state is empty. C0 corrupt recovery via chat only. C2 lazy handoff read. |
| 4 | Cross-process (renderer ↔ Electron main ↔ HTTP ↔ plugin) | DEFECT_CONFIRMED | 1 MEDIUM | IPC silent drop on write rejection. Subagent truncated; lead appended evidence ledger after independent verification. |
| 5 | UI contract (spec ↔ renderer ↔ i18n ↔ tokens) | DEFECT_CONFIRMED | 8 (4 HIGH, 3 MEDIUM, 1 LOW) | Spec drift; 9 missing i18n keys; 369 inline style values bypassing v2- tokens; 71 unused i18n keys. |
| 6 | Spec drift (specs/*.md vs implementation + HANDOFF verification) | (timed out at 600s) | — | Filed post-hoc supplement covering HANDOFF defect verification + adjacent P5 coverage. |

Result: 13 confirmed defects across 4 clusters + 1 clean audit. Two cross-perspective convergences:
- Lens 1 and Lens 5 both found the polling-vs-SSE defect independently. Merged into Cluster A.
- Lens 3 and Lens 5 both found the empty-state projection issue. Merged into Cluster C.

Lead auditor selected P3 C0 (corrupt in-panel reset button) as the first fix because: smallest blast radius (~30 lines, single file, existing primitive `resetGoalWorkspaceState`), existing test surface (`goal-panel.test.ts`), and it established the failing-before test → fix → verify → commit pattern. The other 12 defects were deferred for the user to triage. The combined report (`COMBINED-AUDIT-REPORT-2026-06-24.md`) listed them in priority order so the user could pick the next fix.

## Anti-patterns the cascade prevents

1. **The monoculture audit.** One lens sees one shape of defect. The polling-vs-SSE defect was invisible to the contract lens (which tested the typed shape) and to the spec-drift lens (which tested the docs). Only the data-flow lens surfaced it.
2. **The "we already covered this" rationalization.** Two lenses looking at the same surface from different angles is high-value. Two lenses looking at the same surface from the same angle is one lens in two reports.
3. **The unbounded cascade.** Six lenses is plenty for a layered surface. Twelve lenses on a single feature wastes subagent budget and dilutes signal. Stop at six unless the surface demonstrably needs more.
4. **The leader-steers-the-subagents pattern.** The lead auditor's job is to write the lens prompts well, dispatch in parallel, verify, and synthesize. It is NOT to inject evolving conclusions into subagents mid-flight. That destroys their independence and turns six reports into one report written six times.
