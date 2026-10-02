# D021 Loader previous-generation lifecycle

Owner: `desktop/scripts/Build-Portable.ps1`, `BundleTools.psm1`,
`Test-BundleUpdate.ps1`, `desktop/packaging-api.md`, and this record. D021
implementation and disposable verification are complete. The root owner handles
the actual final build, open-Loader refusal, and delivery. No live database,
global install, or delivery replacement was performed. Next action: root
integrates this source and runs its final build and delivery checks.

## Baseline and Center Audit

Target: dirty worktree at HEAD `31aa0d54f840afaf39dc67d303938f3e24129a62`.
The four pre-edit SHA-256 values are in the error/evidence section below.
Existing fixture scope was nine passing cases in the prior R06/H04 run; a fresh
D021 baseline is pending. C5 observation: one successful staged update leaves a
validated `Previous` but removes its journal; `New-BundleTransaction` then
refuses `Previous` forever. Current-source anchors are `BundleTools.psm1`
`New-BundleTransaction` lines 153-166 and `Invoke-BundleSwap` lines 212-239.
The independent disposable reproduction is recorded in
`desktop/center-redesign-review.md` C5. Claim: the success-to-next-build state
transition has no owned retirement path. Falsifier: two successive disposable
updates with a validated rollback at each swap and preserved config/unrelated
bytes. Result: DEFECT_CONFIRMED, deterministic, medium impact, high confidence.
The verified causal boundary is the journal/Previous lifecycle; unrelated App,
UI, diagnostics, and live state are outside D021.

## Codeplan

[codeplan · previous generation · IN · depth: concise · confidence: high · candidates: V1 retained completed journal/automatic verified retirement, V2 explicit finalize/rotate action · lean: V1 · conservative: V2]

Hard gates: both can keep one backup, refuse unknown paths, avoid new
dependencies, and retain a validated target while retiring a prior backup.
Neither may infer ownership from a sibling name alone or delete a backup without
an inventory and a recoverable state. Frozen comparison: safety/recoverability
first; then repeated-build operator flow; then implementation and maintenance
cost. Unknown evidence earns no credit. V2 is the conservative manual-action
baseline, but requires an extra action for every build and still needs the same
safe partial-retirement protocol. V1 uses that protocol when the next build
starts; its extra control branch is small and testable, and directly fulfills
the natural repeated-build flow. A journal-less legacy `Previous` remains
ambiguous and is refused.

[codeplan · previous generation · PLAN-OUT · depth: concise · pick: V1 · baseline: V2 · confidence: high · comparison: alternative-wins · evidence: current successful swap deletes journal; existing recovery/discard require it · reason: one completed journal preserves ownership proof and permits automatic bounded retirement at the next build with no manual step · planned-fingerprint: existing-module/persisted-journal/transactional/zero-dependency]

Plan: keep a completed journal with validated target/Previous identities and an
inventory of all Previous files and directories; before a new transaction,
verify both bundles, mark retirement, delete only the recorded unchanged files
and empty directories, and allow interrupted retirement to resume. Refuse
unexpected or changed entries. Keep the active target validated through
retirement; the new swap creates a fresh Previous before publishing the new
target. Preserve the existing manifest, config, and process guards. Tests cover
two updates; faults before/after each swap; recover from both interrupted swap
states and partial retirement; foreign/changed path refusal; and exact config
and unrelated-byte survival. Reversibility: keep the old completed journal and
Previous until retirement begins; during retirement, the validated current
target remains the rollback for the next build.

## Evidence and error register

- Pre-edit SHA-256: `Build-Portable.ps1` `03F658D1D3B13F886673D8C07A8F64B6E7109E93EE18E8CA84D3FE8AD135E6F0`; `BundleTools.psm1` `9E9DF8C72D21E0D5B4DDB0AEF98573347D2119ED79B7BE4F85187FFEF3C1309F`; `Test-BundleUpdate.ps1` `BA247C5903C1D2BA83A279C3343FA395010D14BAF3672F553ABF17B9F19A64D9`; `packaging-api.md` `3BAC1055934F8C4F9838E1D202708348F06EFF5E67A2D050BF0570B446FF5FA2`.
- 2026-09-28 orientation: `lodestar start` returned no saved orientation and optional `skills_verify_failed`; no setup was run. A read for `desktop/package-repair.md` failed because this D021 record did not yet exist; this creation resolves that read failure.
- Failing-before fixture run: 9 existing cases passed; four new repeat-update cases failed at `Existing transaction artifact requires review: ...delivery.lodestar-previous`. No live path was touched.
- First implementation check: 18/18 focused fixture cases passed. A later added first-install case then exposed a PowerShell empty-array assignment error (`The property 'Count' cannot be found on this object`) in retirement with no Previous. The current target remained valid in that disposable case; the empty-array branch was corrected before the final rerun.
- Final focused test: `pwsh -NoProfile -File desktop/scripts/Test-BundleUpdate.ps1 -KeepArtifacts` exited 0 with 19/19 passing after the last source edit. This covers first install followed by update, two successive updates, injected before/after faults on both swaps, both interrupted-swap recovery states on each generation, partial-retirement resumption, refusal of unrecorded and journal-less Previous, corrupt stage, simulated in-use refusal, and Validate exit codes. Config SHA-256 and unrelated bytes were asserted in both active and second Previous bundles. Final disposable output remains at `.bundle-update-test-88cd07382139416186208b4f070b4524` for review; no cleanup or delivered-path operation was attempted.
- Public command readback on an earlier passing disposable repeat fixture: `Build-Portable.ps1 -Mode Validate` exited 0 (`valid: true`, six fixture runtime files), and `-Mode Recover` exited 0 (`new_target_valid`). The fixture uses a fake CLI and an inert file for its configured database; these commands did not test a live database or full packaged runtime.
- Post-edit SHA-256 after the final test: `Build-Portable.ps1` `38C24637577850350AEF79D549CCEFCBCD79D145E07899DCF161EF5775E1154E`; `BundleTools.psm1` `3562F1C9D5FBB09F382557D34296FEE32CB44C75C12C409E23EEC3D79DDE6555`; `Test-BundleUpdate.ps1` `62D824F1143340F0632F8A8591EB5E5E301362EA0DA5CB7FCCED41331EF9027C`; `packaging-api.md` `DC2B4651E9942C1E910C0319F1096E0E1D2DBE1023DFAEBD91C30432A28C4599`. Pre-edit hashes above remain the source baseline.

[codeplan · previous generation · EXEC-OUT · pick: V1 · conformance: retained completed journal plus verified resumable retirement · evidence: 19/19 focused fixture cases and public Validate/Recover readback · limitation: no full final build, live in-use process, or delivery replacement]
