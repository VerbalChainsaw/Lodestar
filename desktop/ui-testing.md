# Native Loader UI regression

## Maintained command

Run from Windows PowerShell 5.1 in an interactive desktop session:

```powershell
powershell.exe -NoProfile -File desktop/tests/Invoke-LoaderUIRegression.ps1 -BundleRoot "<staged bundle root>" -OutputDirectory "<reports directory>" [-WorkRoot "<fixture directory>"]
```

`BundleRoot` must contain the exact `Lodestar.Loader.exe`, `Lodestar.Loader.dll`, and `core/lodestar.mjs` under test. The command creates a unique disposable fixture run, configures that packaged core by absolute path, runs real WPF UIAutomation interactions sequentially, and writes a JSON result plus owned-window captures. A failed assertion or timeout exits nonzero with a partial report. It never selects the default AppData database or a manually opened Loader window. The coordinator runs it again against the final staged build; a run against the previous bundle only validates this harness against that previous UI.

The optional `WorkRoot` is a **container** for unique `run-<GUID>` folders, not an existing fixture. The default is `%TEMP%/LodestarLoaderUiFixtures`. It must be separate from the selected bundle. An existing root must carry the marker created by this command; individual fixture folders must not exist before creation. `OutputDirectory` must also be separate from the selected bundle and receives its own unique run folder. The command retains fixture data and the JSON report for audit. `desktop/tests/.gitignore` excludes locally generated artifacts from source changes.

The run uses the selected bundle config only to locate its Node executable. Fixture generation invokes `BundleRoot/core/lodestar.mjs` and writes a new `interfaces.json` with the packaged core and fixture database as absolute paths. Interactive app launches also pass a fixture-local `--journal-root` with `--interactive-smoke`. For slow read and delayed save, `controlled-cli.mjs` is copied into that fixture; its `control.json` delegates to the exact packaged core. The delayed marker makes the later exact replay run without another delay. No fixture is sourced from the bundle's delivered database config.

Before fixture creation, the command verifies every file listed in the selected bundle manifest by byte count and SHA-256. The report includes the selected DLL, packaged CLI and manifest SHA-256 hashes; fixture config/database/CLI provenance; each completed assertion; captures from `PrintWindow` on the owned window handle; errors and cleanup actions. Process checks retain the created `Process` object, exact executable path and start time. Before close it snapshots descendants, then checks exit code, redirected stderr and tracked child termination. Failure cleanup stops only the verified created process and verified descendants. A missing new console API makes the run `PARTIAL` and exits 1; a four-record fixture can confirm the Continue control's presence and ordinary no-more state but cannot exercise a continuation page.

## Scenario contract

| Scenario | Required observation |
| --- | --- |
| Fresh fixture/read | Initial selected record, readable detail where exposed, exact raw ID and retained-history heading through UIA. |
| Reviewed edit/resize/save | Review before Save, 1440×900 → 900×600 → 1440×900 with draft and Save still present, owned PrintWindow captures, revision advance and refreshed UI row. |
| Concurrent update | Packaged CLI writes a fixture-only newer revision with current `write_basis`; stale UI Save is rejected and keeps the UI draft while the newer value remains stored. |
| Close and Back | Unchanged editor exits cleanly; unreviewed close Yes shows Review without mutation, then No discards; compact Back returns to the project list. |
| Slow read | Controlled `find` exposes a child PID; runtime switch is blocked during the read; closing exits cleanly and terminates that exact child. |
| Interrupted save | Controlled `put` waits after the exact request is journaled; close Yes exits, restart exposes Pending saves, replay uses the same request bytes, advances the record, writes a response, and leaves no unresolved pending save. The resolved journal response is retained by the app. |
| New console | Health action plus project/record navigation, grouping and sorting via UIA SelectionItem, when the final API is present. The Continue control is checked and clicked if available; a large-page fixture is still needed to force that branch. |

## Current validation and error register

- `2026-09-28 23:17 UTC`, old-bundle copy, run `run-83bf25dfa04d4c5a9f49a593f26c6403`: fixture generator's nested Node `spawnSync` was denied by the worker sandbox. Command exited 1 with a partial report and DLL/core hashes; no Loader process started. Initial PowerShell error handling recorded only the first stderr line.
- `2026-09-28 23:18 UTC`, retry `run-1b464b32379140768a710e18294658f9`: native stderr capture recorded `spawnSync ... node.exe EPERM` at packaged CLI `init`. Command again exited 1; no Loader process started. Status: environment blocker for connected UI proof, not an app failure or test PASS. The first-line-only error report was corrected in the harness.
- `2026-09-28 23:25 UTC`, current command, run `run-06c1c70183ad491e9a7ad4df65661f27`: bundle-manifest validation and hash reporting passed; fixture `init` again hit `spawnSync ... EPERM`. Exit 1, zero completed cases, zero cleanup actions because no Loader process started. Partial report records DLL SHA-256 `76C37F0A188D45E15313BFEA8534D032B650A04E3D7DC22A45768D127F24B635` and packaged CLI SHA-256 `C0543D5C3B8AB78699A236D4E79DC98A1687D588FEE3C44FF977A1D6FD13583F` for the old bundle copy.
- The tested copy's DLL and CLI hashes both match the old delivered `outputs/lodestar-desktop` files; its packaged core reports version `2.2.0`. This verifies the old-bundle source of the attempted run, not the redesigned UI.
- Static checks: Windows PowerShell parser and `node --check` pass for the maintained scripts. The coordinator must run the same command in a host environment that permits Node child processes against the final staged bundle, then inspect its report and captures. Current old-bundle run is not new UI acceptance.

## Current task checkpoint

- Owner: R07/H03 UI regression lane. Allowed changes: `desktop/tests/**` and this file. Concurrent UI and packaging lanes own their files.
- Target: fresh fixture read/detail/raw/history; reviewed save with revision/list refresh; stale save conflict with retained draft; wide/compact/wide editor; unchanged and unreviewed close choices; compact Back; runtime switch during slow read and owned-child cleanup; interrupted save exact replay and journal cleanup. Exercise new navigation, sorting, grouping, health, and Continue controls when the final UI API exposes them.
- Acceptance evidence: explicit bundle and fixture provenance, actual UIA control actions and native dialog choice, exact stored-state checks through packaged CLI, process identity/path/exit/stderr/child checks, PrintWindow captures, nonzero failures with partial report and owned cleanup.
- Route: accepted Codeplan uses native UIAutomation and packaged public CLI. Center C4 identifies lifecycle and edit guards as test owner. No app source mutation, package install, global config, live database, or live Loader PID.
- Current step: implementation and static validation are complete; the disposable old-bundle attempt produced the expected sandbox `EPERM` blocker before UI launch. Review current source handoff, then pass the command to the coordinator for a final staged-bundle host run.
- Blockers: this worker sandbox denies the fixture generator's nested Node launch; final redesigned bundle and settled UI API need connected host validation. Continue requires a separate large-page fixture to observe a click.
- Next action: coordinator runs the documented command on the final staged bundle and inspects all scenarios, the full owned captures and the partial report if it fails; adapt stable IDs after the final UI API handoff if needed.

## Current evidence and bounded use

The redesigned candidate completed all nine maintained scenario groups in run-adc5822fc6b143ed8f1d5ac8df9914ce. That includes Ctrl+F typing, ten actual Tab stops within the owned window, and native splitter arrows. Save readiness waits for the completed refresh status before selecting a rebound grid row. The slow-read case accepts the explicit blocked Connection-navigation guard or the direct runtime-selection guard, then proves config identity, ordinary close, empty stderr and exact child termination. Dialog fallback verifies the native button's process ID with a dedicated variable.

Run once for a meaningful changed UI contract; repeat only after a diagnosed failure or relevant source change. The Director stopped further repeated UI runs. Preserve that instruction; missing Narrator, actual high-contrast and mixed-monitor evidence is not permission to restart a loop.

Other maintained commands: `Test-StartupDiagnostics.ps1` (PowerShell7) checks a disposable missing-runtime error, bounded build/exception identity and privacy; `Test-LargeLibraryUI.ps1` (Windows PowerShell5.1) accepts only a generated large synthetic fixture and checks explicit continuation. The startup diagnostic integration passed. The large UI command was prepared but not run; service continuation on100184 current records passed independently. These commands do not imply completed UI coverage.
