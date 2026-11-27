# D020: bounded cross-process diagnostic retention

## Current task checkpoint (2026-09-28)

- Owner: D020 implementation lane. Parent owns final review and Loader build.
- Requested outcome: serialize owned diagnostic retention and write for one canonical root across independent Loader processes. Preserve bounded waiting, original-exception priority, cancellation skip, privacy, count/byte caps, and unrelated files.
- Boundaries: edit only `Lodestar.Loader/Services/DiagnosticLog.cs`, `Lodestar.Loader.Tests/DiagnosticChecks.cs`, this note, and an optional standalone process test under `tests/diagnostics/`. No dependencies, permission changes, installed changes, live-store tests, package, or app launch. Preserve the coordinator's enum additions and all concurrent WIP.
- Acceptance evidence: failed-before and passing-after disposable multi-process runs; focused existing diagnostic checks; owned event JSON parses, contains no sensitive marker, and stays within both caps; unrelated files survive; source hashes and exact command outputs.
- Current step: implementation and focused verification complete; parent final review and Loader build remain.
- Blockers: none in this lane. Lodestar orientation succeeded read-only with no saved project orientation. This source-scoped lane leaves any shared continuity mutation to the parent.

## Center revalidation and mechanism choice

Center C3 observed five 12-process rounds retaining 6, 9, 9, 3, and 2 events with `maxFiles=1`, `maxTotalBytes=2048`; two rounds retained 2,997 bytes. The current `DiagnosticLog.cs` SHA-256 is `9FA4DE5AF1BF5D0660A41702B212A6EB47816D9300D99C9C771A2E1E019677C2`, matching that audit. `RecordFailure` guards scan, eviction, and move with only its static `Gate`. Falsifier: a disposable current-source, simultaneous-process run never exceeds both caps, with parseable private events and preserved sentinels.

[codeplan · diagnostic retention · IN · depth: concise · confidence: high · candidates: named-mutex, exclusive-lock-file · lean: exclusive-lock-file · conservative: named-mutex]

| Mechanism | Full contract and failure behavior | Cost and boundary |
| --- | --- | --- |
| Named mutex keyed by hashed canonical root | OS mutex serializes processes in its namespace; timed `WaitOne`, release in `finally`, and abandoned-owner handling. No disk artifact. | Least code, but `Local` scope covers one login session. `Global` broadens access/interference concerns. A cross-session process using the same root can bypass a local mutex. |
| Exclusive lock file in the checked canonical root | Open one fixed direct-child file with `FileShare.None`, hold the stream around owned-file scan, eviction, temporary write, and move. Retry contention only until a monotonic deadline; close on every path and process exit. | One persistent, non-event zero-byte file and bounded retry code. The path itself is the canonical root identity, including across sessions; no new package or host permission change. |

Both candidates meet the paper gates for ordinary same-session Loader use, keep failures subordinate to the original exception, and can be tested with disposable roots. Frozen comparison axes: cross-process coverage (including sessions/aliases), failure containment and privacy, implementation/maintenance surface, and testability. Unknowns receive no credit; full stated root coverage wins over code brevity. The file lock wins because a fixed child path follows the actual checked directory even when aliases or login sessions differ. The named mutex is the simpler baseline but its namespace leaves a material coverage gap. The lock file must never be deleted as routine cleanup while another process may use it; owned-event enumeration excludes it.

[codeplan · diagnostic retention · PLAN-OUT · depth: concise · pick: exclusive-lock-file · baseline: named-mutex · confidence: high · comparison: alternative-wins · evidence: canonical directory child coordinates across sessions while Local mutex does not · reason: full root-scoped serialization outweighs one persistent lock artifact and small bounded retry loop · planned-fingerprint: inline, filesystem-lock, zero-dependency, graceful-degrade]

## Evidence and error history

- Fresh failing-before source: `DiagnosticLog.cs` SHA-256 `9FA4DE5AF1BF5D0660A41702B212A6EB47816D9300D99C9C771A2E1E019677C2`; `DiagnosticChecks.cs` SHA-256 `BD5697C02FE6A2724A846D6E917DB29CE93AD3D841C6A5F9DC476075DDECE45A`.
- Build command: `dotnet build desktop/tests/diagnostics/DiagnosticProcessChecks.csproj --artifacts-path work/diagnostic-repair/artifacts -p:RestoreSources=work/diagnostic-repair/empty-feed` exited 0, 0 warnings and 0 errors. No package dependency was added; restore used the local empty feed.
- Failing-before command: `work/diagnostic-repair/artifacts/bin/DiagnosticProcessChecks/debug/DiagnosticProcessChecks.exe work/diagnostic-repair/before` exited 1 as expected. Rounds 0-4 each wrote 12/12 but retained 12 events; bytes were 3,995, 3,995, 3,995, 3,995, and 3,993. Held lock returned `Written` in 24 ms. Six invariant violations were reported. Output is under `work/diagnostic-repair/before/run-0c75c260b034411bbb659010fffa45ee`.
- Expected negative result E1: old source failed the new process regression; this is baseline evidence, not an implementation failure.
- Passing-after build: `dotnet build desktop/tests/diagnostics/DiagnosticProcessChecks.csproj --no-restore --artifacts-path work/diagnostic-repair/artifacts` exited 0 with 0 warnings and 0 errors.
- Passing-after command: `work/diagnostic-repair/artifacts/bin/DiagnosticProcessChecks/debug/DiagnosticProcessChecks.exe work/diagnostic-repair/after` exited 0. All five rounds wrote 12/12, retained exactly one 333-byte event, parsed retained JSON, found no sensitive marker, and preserved unrelated sentinel/lookalike files. A held lock produced `Failed` after 3,036 ms; writing recovered after release. `violations=0`. Output is under `work/diagnostic-repair/after/run-fcd983ab170b42519fd00ef32418c20f`. Direct readback found 0-byte lock files in `round-0` and `held-lock`.
- Existing focused checks: `dotnet build work/diagnostic-repair/FocusedDiagnosticChecks.csproj --artifacts-path work/diagnostic-repair/artifacts-focused -p:RestoreSources=work/diagnostic-repair/empty-feed` exited 0 with 0 warnings and 0 errors; the corresponding executable exited 0 with `PASS bounded private diagnostic contracts`. These checks cover cancellation skip, original-exception identity, sensitive exception payloads, nested bounds, same-process concurrency, and unrelated-file survival.
- After hashes: `DiagnosticLog.cs` SHA-256 `55B08D39E13E845E86150A45E031659C065CD7409D00F0E04460B88C4B660DBB`; `DiagnosticChecks.cs` SHA-256 `42004714D877580006DE4EC2B568876B0ECD72A89B3FBDDBEB18391DE41888C2`; process `Program.cs` SHA-256 `1B47F83031B4E00FB75D0608D7D56BE58FEB49BF0F8687317A7E493A7EB38248`; process project SHA-256 `6838BC890CEC6EB7A1142231E46385EBBEF32F1005B406E4858E5648B03BEBAF`.
- Error register: the failing-before exit 1 was the intended negative regression result. An exact search for nested `AGENTS.md` returned no matches (exit 1), with no effect. A final optional `Get-CimInstance Win32_Process` check returned `Access denied`; it made no changes and was not retried because each fixture child was already waited to exit and disposed by its owner. No unexpected build/test failures occurred.
- Limitation: this lane did not build the WPF app, package, launch a Loader window, test a live store, or verify an installed runtime. A persistent zero-byte `.lodestar-diagnostic.lock` stays in each written root so a second process cannot split the lock by deleting it. A contended write can return `Failed` after the three-second bound; the caller's original failure path remains primary.

[codeplan · diagnostic retention · EXEC-OUT · implemented: exclusive-lock-file · verification: five process rounds and focused contracts pass · divergence: none]
