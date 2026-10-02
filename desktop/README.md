# Loader and Manager distribution

Loader is a native WPF application for Windows x64. Manager is a terminal menu
included in the Lodestar CLI package. Both use the same one-shot core and
contract-5 writes. No server or background service is installed.

Loader's Attention view names unfinished work and context gaps. Capture / link
reviews a saved finding and its requirement association separately, and pending
saves retain the original request for recovery. Manager exposes the same core
operations through menus and typed command discovery. See
[operator recipes](../docs/operator-recipes.md) for these workflows.

For users, start with the [installation guide](../docs/installation.md#windows-loader-and-manager-per-user-installation).
The Windows ZIP requires Node.js 24.15.0+, the .NET 10 Desktop Runtime (x64),
and PowerShell 7. It contains no database, configured user paths or debug symbols.

Owned per-user installations use `Install.cmd` for updates and `Install.ps1 -Mode Recover`
for interrupted operations. The portable update workflow below applies to extracted
bundles configured through `Setup.cmd`.

## Build a release

On Windows x64 with the .NET 10 SDK, supported Node and PowerShell 7:

```powershell
pwsh -NoProfile -File desktop/scripts/Build-Release.ps1 -OutputDirectory C:\build\lodestar-release
```

The output directory must not exist. The script creates a disposable store for
validation, builds in a separate temporary directory, and produces the Windows
ZIP, CLI tarball and SHA256SUMS.txt. It does not use or change your live store.
Failure leaves diagnostic build artifacts; do not publish an incomplete build.

The ZIP contains a runtime manifest and a distribution inventory. They detect
changed bytes; they are not a code-signing identity. Release archives and their
checksums are published together by the release workflow.

## Focused checks

```powershell
dotnet run --project desktop/Lodestar.Loader.Tests -c Release
pwsh -NoProfile -File desktop/scripts/Test-Distribution.ps1 -BundlePath C:\build\extracted\Lodestar-3.0.0-win-x64
pwsh -NoProfile -File desktop/scripts/Test-BundleUpdate.ps1
pwsh -NoProfile -File desktop/scripts/Test-BuildSourceExport.ps1 -SourceRoot C:\build\exported-source
pwsh -NoProfile -File desktop/scripts/Test-DistributionFaults.ps1 -BundleArchive C:\build\lodestar-release\Lodestar-3.0.0-win-x64.zip
```

The first command tests native service contracts. It uses `LODESTAR_TEST_NODE`
when set, otherwise it finds supported Node on `PATH`. The second uses disposable
copies of the exact extracted release to test setup, configuration preservation,
launch arguments, invalid inputs, update and recovery. The third injects faults
around staged replacement. The export-build check requires a complete source
export without Git metadata; it checks a successful caller exit and rejected
invalid source using a disposable store. None is a substitute for visual acceptance.

For a single native service group, set `LODESTAR_TEST_FILTER` to part of its
registered name, run the first command, then clear the variable. A filter that
matches no group exits with code 2 and lists the available names. The
`SR live process uncertainty` group exercises real child exits, journal reopen,
later rejection and exact receipt recovery. The shared protocol group uses the
same maintained cases as Manager and the MCP adapter.

For a changed UI workflow, the maintained Windows PowerShell 5.1 runner is
`desktop/tests/Invoke-LoaderUIRegression.ps1`; inspect its parameter help and
pass an explicit disposable bundle and output directory. `-CaseScope All` is the
default and runs the full existing suite. `-CaseScope Recovery` runs only the
interrupted-save, restart and exact-replay journey after the same bundle manifest
and fixture setup checks. For that focused check, use
`powershell.exe -NoProfile -File desktop/tests/Invoke-LoaderUIRegression.ps1 -BundleRoot C:\build\extracted\Lodestar-3.0.0-win-x64 -OutputDirectory C:\build\ui-evidence -CaseScope Recovery`.
The JSON report records `case_scope` and `full_suite`; a Recovery PASS proves the
selected journey. It opens test windows, so use it deliberately in an interactive
desktop session. Benchmark and large
UI runners are optional development tools, not claims that every release has
passed a stress campaign or specialist accessibility qualification.

`Test-DistributionFaults.ps1` checks the shared CLI envelopes, strict configuration
shape, bounded child output and timeout cleanup, and setup failures using disposable
copies. `-BundleArchive` enables the actual setup-consumer cases. It does not run
the desktop interface or change a live store. The native suite includes pending
request preservation, journal read errors, saved-but-stale refresh, and redacted
transport diagnostics. Run the affected suites after changing those boundaries.

The update suite also covers malformed transaction journals, legacy journal state,
orphan temporary files, recovery moves while a runtime is in use, and unexpected
user files in the retained generation. `-CaseFilter 'resilience_*'` selects those
cases. Refusal preserves the journal and names the recovery action; it never
deletes unknown files to make an update succeed.

Pending-save recovery validates the original request, selected runtime/store and
recorded response before declaring success. A corrupt response stays visible.
Verified exact replay preserves the original bad-response bytes and uses the
existing idempotent core request. Missing or altered request/context bytes remain
blocked with their location and authoritative read instructions. A later error
does not settle an earlier uncertain write. Native regression checks cover these
outcomes without launching a UI campaign.

## Updates and recovery

From a newly extracted release, run `Update.cmd "C:\path\to\existing app"`.
The destination must be a configured, validated portable bundle. The updater
validates the source before staging, refuses an open Loader/Manager, preserves
configuration and retains the prior generation. It never updates global npm
or changes the database schema.

`Test-BundleValidation.ps1` exercises typed help, warning tolerance, configuration
and manifest rejection, output bounds and byte preservation. Add `-SlowCases` to
include the 15-second probe deadline and cleanup of its owned descendant. Run it
from source with PowerShell 7; it uses disposable fixtures and returns nonzero
when a required assertion fails. Build/update and Setup reuse the maintained
PowerShell validation owner while preserving their different path-resolution rules.

After an interrupted update, run from that extracted release:

```powershell
pwsh -NoProfile -File .\Update.ps1 -Mode Recover -Destination "C:\path\to\existing app"
```

Recovery follows the saved transaction journal. It restores the recorded old
bundle when appropriate or validates a completed replacement. It does not
automatically downgrade a successfully installed version. Keep all transaction
folders until recovery reports its outcome.

`Build-Portable.ps1` is a developer rebuild command. It preserves a configured
destination and compiles source; end users update with the prebuilt archive.
