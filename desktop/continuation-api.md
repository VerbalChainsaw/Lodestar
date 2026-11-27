# R03/H06 library continuation API handoff

> Historical lane snapshot, 2026-09-28, labeled 2026-10-02. The integration
> actions and pending claims below retain the original checkpoint. Current
> product guidance is in [the documentation index](../docs/README.md); current
> delivery disposition is in [the release record](../../../outputs/RELEASE-PLAN.md).
> API descriptions remain references; the lane verification and next actions are history.

Owner: `LodestarService` and additive `LibrarySnapshot` fields. UI wiring belongs to the coordinator.

- `LoadLibraryAsync(CancellationToken cancellation = default, Action<LibrarySnapshot>? onCatalogReady = null, int batchRecordBudget = 100_000)` starts a fresh pinned scan. Existing calls remain valid.
- `ContinueLibraryAsync(CancellationToken cancellation = default, Action<LibrarySnapshot>? onCatalogReady = null, int batchRecordBudget = 100_000)` advances the pending scan by at most the requested number of rows across catalog and current records. The positive budget may vary between calls. It returns an error snapshot when no safe continuation exists.
- `LibrarySnapshot.HasMore` means library loading has outstanding pages or an unstarted current-record phase. `CanContinue` means the service holds a validated in-memory cursor. A displayed prior complete snapshot can retain `Complete = true` during a partial refresh; its `Error` identifies that older data is displayed, and `CanContinue` exposes the pending refresh.
- A continuation with a changed store identity, epoch, or revision discards the cursor and requires a new `LoadLibraryAsync` call. A runtime selection change also discards it. There is no persisted cache.

Acceptance: small batches without missing or duplicate rows; exact-limit final page complete; catalog stage resumable; drift fails closed; cancellation does not commit a half batch; prior complete data retained; larger synthetic paging set. Owner: R03 worker. Current step: implementation verified and ready for coordinator integration. Blocker: the existing fixture generator cannot spawn nested Node under this sandbox. Next: coordinator wires `ContinuationChecks.RunAsync()` in shared `Program.cs` and binds UI Continue to this API.

[codeplan · library-continuation · IN · depth: concise · candidates: V1 larger cap, V2 typed in-memory resume · lean: V2 · conservative: V2]
[codeplan · library-continuation · PLAN-OUT · depth: concise · pick: V2 typed in-memory resume · baseline: V2 · confidence: high · comparison: baseline-wins · evidence: `PagesAsync` currently stops at 100000 before checking `more`; larger cap cannot satisfy bounded continuation · reason: a pinned cursor preserves the one-shot CLI boundary and is testable without persistent state · planned-fingerprint: service-instance-state, validated-continuation, zero-dependency]

Center C2: current working tree is dirty; `PagesAsync` budget/more ordering is the center. Invariant: a final page at the exact limit is complete, and every resumed page belongs to one instance, epoch, and revision. Falsifier: a final-page fixture marked partial, a repeated/missing row, or a drifted page merged into the result. The repair is confined to service/model paging state and focused fixtures.

Verification: isolated `ContinuationChecks.RunAsync()` PASS, including changing budgets, exact boundary, revision/instance/epoch drift, cursor gap, cancellation, prior-complete retention, runtime switch and 1,003 current rows; WPF build 0 warnings/errors. Existing desktop suite: 10/11 passed; fixture generator case failed before service execution because sandboxed Node `spawnSync` returned `EPERM` and its own `stdout` was undefined.

Error history: initial plan lookup relative to checkout failed; resolved at `../../outputs/lodestar-desktop/REDESIGN-PLAN.md`. First edited build failed on local `nextOffset` variable collision; corrected and subsequent builds passed. One `rg` pattern had invalid quoting; corrected. Existing suite fixture generator failed as above; direct nested-Node probe reproduced `EPERM`, so no source repair was attempted outside this ownership. Removal of the ignored isolated test harness under `desktop/Lodestar.Loader.Tests/obj/continuation-harness` was rejected by tool policy after an exact-path containment check; it remains in ignored build output.

[codeplan · library-continuation · EXEC-OUT · implemented: V2 · confidence: high · verification: partial · mechanism-check: passed · plan-history: unchanged · corrected: cursor offset equality and local compile error · evidence: isolated checks PASS, WPF build PASS, existing suite 10/11 with sandbox fixture failure]
