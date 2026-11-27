# R04/H02 diagnostic logger handoff

> Historical lane snapshot, 2026-09-28, labeled 2026-10-02. The integration
> actions and pending claims below retain the original checkpoint. Current
> product guidance is in [the documentation index](../docs/README.md); current
> delivery disposition is in [the release record](../../../outputs/RELEASE-PLAN.md).
> API descriptions remain references; the appended work checkpoint is history.

Owner: R04 diagnostic slice. Source owner is `desktop/Lodestar.Loader/Services/DiagnosticLog.cs`; checks owner is `desktop/Lodestar.Loader.Tests/DiagnosticChecks.cs`. Root owns all App and UI wiring. Current state: implemented and focused checks passed; App wiring remains with root.

## Decision and acceptance

The accepted Codeplan selects bounded allowlisted local events over raw exception dumps or telemetry. Center C3 targets the event serializer and retention boundary. A passing fixture must show that secrets in exception messages, data, inner messages, stack source paths, JSON and CLI arguments do not appear in any emitted file, while operation, build and exception identity remain. The logger must bound writes and owned-file retention, preserve unrelated files, handle concurrent calls, and return failure without throwing over the original exception.

## API for root integration

`new DiagnosticLog(root: optionalFixtureRoot, appBuild: validatedVersionOrSha256, coreBuild: validatedVersionOrSha256, maxFiles: 32, maxTotalBytes: 262144)`; omitted root uses LocalApplicationData/Lodestar Loader/diagnostics.

`RecordFailure(DiagnosticOperation operation, Exception exception, bool fatal, Guid? correlationId = null)` returns `DiagnosticWriteResult` with `Status`, `Summary`, and `Path`. `Status` is `Written`, `SkippedCancellation`, or `Failed`. `fatal` is explicit: the logger never marks an exception handled or changes shutdown policy. Pass fixed enum operation IDs; do not pass a record ID, CLI argument, JSON, path, or arbitrary message. Cancellation returns `SkippedCancellation` and writes no file. `Latest` exposes only the latest safe summary and path, including a prior file after reopening the root.

The fixed operations are `Startup`, `AppUnhandled`, `DispatcherUnhandled`, `TaskUnhandled`, `CapabilityDiscovery`, `LibraryLoad`, `ProjectLoad`, `RecordRead`, `HistoryRead`, `GenericRead`, `Save`, and `Recovery`. Both build inputs accept only dotted numeric versions or 64-character hexadecimal hashes; invalid values are omitted. A selected runtime `Fingerprint` can be passed as `coreBuild` after runtime selection exists. The logger is synchronous and thread-safe within the app process.

Intended App usage: call the logger in unhandled exception and named operation failure boundaries, then retain the existing handling/termination decision. Do not log `error.ToString()`, `error.Message`, `error.Data`, CLI output, or payloads in adjacent error paths.

## Work checkpoint and failure history

- Current step: root integration. No logger slice work remains.
- Baseline: no DiagnosticLog or DiagnosticChecks in current source; test project includes Services/**/*.cs automatically. Existing desktop tree is concurrent dirty WIP.
- Routing: accepted Codeplan diagnostics choice and Center C3 falsifier; no new mechanism selection or separate audit required.
- Initial lookup of `task-outputs/lodestar-desktop/REDESIGN-PLAN.md` failed because the actual plan is in sibling `outputs/lodestar-desktop`; rerun found and read it. No source effect.
- Attempt to create a test harness under system temp was rejected by command policy before writing anything. Recovery: an exact workspace-local temporary harness ran `DiagnosticChecks.RunAsync()` successfully.
- First computed-path `Remove-Item -Recurse -Force` cleanup was rejected by command policy. Recovery: verified the resolved absolute workspace path, then removed that exact harness with `Remove-Item -LiteralPath ... -Recurse`; repeated successfully after final checks. No harness remains.
- Final checks: `DiagnosticChecks.RunAsync()` PASS in isolated fixture root; `dotnet build` for both `Lodestar.Loader.Tests.csproj` and `Lodestar.Loader.csproj` succeeded with 0 warnings and 0 errors. The shared `Program.cs` has not been modified to call the new checks; root owns that integration.
- C3 evidence: deliberate fake secrets in message, data, inner message, overridden `ToString`, database path, JSON and CLI-argument text were absent across every emitted JSON file. Checks also covered validated operation/build/exception identity, bounded nested exception, exact owned-file count/byte retention and unrelated sentinel preservation, concurrent valid events, cancellation skip, reopened latest summary, and an unwritable root preserving the original exception.
