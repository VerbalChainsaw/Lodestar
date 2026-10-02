# Installation and startup

Lodestar 3.0.0 provides the CLI package `lodestar-agent-context@3.0.0` and the
Windows archive `Lodestar-3.0.0-win-x64.zip`. Use the
[3.0.0 release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v3.0.0)
for versioned archives and the SHA-256 checksum inventory. Verify downloaded
archives against that inventory before installing.

For **Loader or Manager on Windows**, install Node.js 24.15.0 or newer, the .NET 10
Desktop Runtime (x64), and PowerShell 7. Verify and extract the whole Windows ZIP,
run `Install.cmd`, then open Loader or Manager from the Start Menu. See
[per-user installation](#windows-loader-and-manager-per-user-installation) for
planning, selected paths, upgrades and recovery. `Setup.cmd` supports portable use.

For the **CLI and native agent skills**, use Node.js 24.15.0 or newer and the
package procedure below. Application installation, skill installation and host
activation are distinct steps. Automatic continuity through a separately prepared
host hook requires that host's explicit activation and a natural runtime event;
the CLI, native skill and MCP plugin do not install or activate that hook.

## CLI and native skills

For a new installation:

```text
npm install --global lodestar-agent-context@3.0.0
lodestar setup --target all
lodestar setup --target all --apply
lodestar init
lodestar skills verify --target all
lodestar doctor
lodestar start --cwd .
```

Use `lodestar init` only when creating a new store. An existing schema-5 store
needs no 3.0 migration. An older schema-4 store requires the explicit
[migration/recovery procedure](../README.md#storage-and-recovery); setup never
changes a database. You can also install the versioned tarball from the
[GitHub release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v3.0.0).

To use an isolated CLI package, verify `lodestar-agent-context-3.0.0.tgz`
against the release's SHA-256 inventory, then install it in a new directory.
Replace the placeholders with your selected paths and invoke that exact package:

```text
npm install --prefix "<local-package-directory>" --ignore-scripts "<verified-release-tarball>"
node "<local-package-directory>/node_modules/lodestar-agent-context/lodestar.mjs" --db "<existing-database>" start --cwd "<project-root>"
```

This read uses an existing schema-5 store. New-store creation remains an explicit
`init` operation, and native skill installation remains an explicit `setup`
operation. Local package installation alone does not activate a native host.

`setup` without `--apply` is a read-only plan. Choose codex, claude, opencode,
hermes, or all. Missing skills are installed; unchanged owned copies upgrade
using the previous install receipt. Existing content without a matching receipt
requires review and explicit `--replace-local`. Replaced content is retained.
The installer never rewrites host instructions, credentials, plugins, or settings.

Each physical skill has a lock, installation receipt, and interruption journal
under `.lodestar-install` beside its skills directory. This keeps backup SKILL.md
files outside native discovery and stages replacements on the same filesystem.
Repeat the same setup command after interruption. A complete published payload is
settled; otherwise the displaced old tree is restored before retry. Changed
interrupted state is reported for inspection rather than overwritten. An active
installer returns `install_busy`; retry after it exits. Stale locks are reclaimed
only when their owning local process is no longer present.

Recovery validates the operation's distinct staging and backup names, complete
file inventories, and preserved backup bytes before mutation. A malformed journal,
changed backup, or changed destination is retained and reported as a conflict.
An incomplete or changed staged copy is kept at its unique path outside native
discovery and reported as `recoveries[].retained_stage`; the verified original can
still be restored and installation retried. Only a complete matching staged payload
is discarded during recovery.
Ownership in new locks is encoded in the filename so a partial JSON write cannot
strand recovery. Intact older locks are supported; an unreadable legacy lock needs
inspection because its process ownership cannot be established safely.

Setup preflights selected content before replacement. Replacement is atomic per
directory rename and recoverable per skill, not transactional across all hosts.
Run upgrades between host sessions and start fresh sessions afterward because
hosts may retain already-loaded instructions.

Journal and receipt files, staged skill files, and launcher recovery copies are
flushed before publication. Abrupt process exit is regression-tested. Physical
power-loss recovery is not certified: directory metadata and rename durability
depend on the filesystem, including Windows-to-WSL transport. The installer locks
serialize cooperating setup processes; content checks are not an OS-level
compare-and-swap against arbitrary external writers.

## Windows Loader and Manager: per-user installation

Download `Lodestar-3.0.0-win-x64.zip` from the
[3.0.0 release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v3.0.0)
and verify its SHA-256 checksum against the release inventory. Extract the whole
archive to a separate directory. This is a framework-dependent Windows package. Install
the **.NET 10 Desktop Runtime (x64)**, **PowerShell 7**, and **Node.js 24.15.0 or newer**
separately before first use. The package does not install these prerequisites.
It bundles no code-signing identity or automatic updater. Verify the archive and
scripts before trusting or explicitly unblocking a Windows download.

Run `Install.cmd` for an ordinary per-user installation. It checks the selected
runtime and database, installs to `%LOCALAPPDATA%\Programs\Lodestar`, and creates
Start Menu entries for Loader and Manager plus one owned HKCU uninstall entry.
`-DesktopShortcut` adds a Loader desktop shortcut. It requires no administrator
access and creates no service, autostart entry, PATH edit or background updater.
Existing `interfaces.json` is preserved byte-for-byte. The database stays outside
the app; the default is `%LOCALAPPDATA%\Lodestar\lodestar.db`. This explicit Install
operation creates that store if absent. Neither app creates a store merely on launch.

Inspect the resolved plan or select different paths:

```powershell
pwsh -NoProfile -File .\Install.ps1 -Mode Plan
pwsh -NoProfile -File .\Install.ps1 -Destination "C:\Apps\Lodestar" -DatabasePath "C:\Data\lodestar.db" -NodePath "C:\Tools\node.exe"
```

Plan reads and validates without initializing or migrating data. The database must
be external to the app, payload and update folders. Reparse-point paths, conflicting
ownership and changed payload bytes are refused with the failed stage and next action.

### Upgrade, recover and uninstall

Close Loader, Manager and all database writers. Extract the next release separately
and run its `Install.cmd` with the same destination. To adopt one old verified portable
bundle, explicitly pass `-PreviousInstallation "C:\Apps\OldLodestar"`; its original
directory remains and its configuration/store selection are preserved. Unknown or
ambiguous state is retained for review. This does not replace global npm packages or
install/activate agent skills or native hooks.

An existing schema-5 store needs no conversion. The supported schema-4 conversion
requires `-MigrateDatabase`, an independently verified backup and a retained exact
request before mutation. Unsupported, corrupt and future databases are refused.
Application rollback never reverses a database conversion. Close writers first and
retain the independent backup; file inventories alone do not prove a usable backup.

```powershell
pwsh -NoProfile -File .\Install.ps1 -MigrateDatabase
pwsh -NoProfile -File .\Install.ps1 -Mode Recover -Destination "C:\Apps\Lodestar"
```

Recover reconciles the recorded selection, application transaction and exact saved
migration request. Keep the receipt, stage, previous bundle, backup and request until
reconciliation succeeds. Controlled recovery artifacts sit beside the selected app
and database; diagnostics identify their paths. Preserve changed or unknown files.
No blind new logical request is issued to settle an uncertain earlier mutation.

Uninstall through Windows Installed Apps or the installed `Install.ps1 -Mode Uninstall`.
It removes unchanged owned application files and registration. The database, retained
configuration and recovery evidence survive. Changed inventory, foreign files or
changed registration produce a conflict and corrective action. A later reinstall
uses the retained selection unless you explicitly choose a new one.

`Install.cmd` pauses after failure only when called without arguments. Other launchers
and calls with arguments return their exit code immediately. To keep output visible,
invoke them in an existing terminal. No launcher modifies PowerShell execution policy
or unblocks downloads. Inspect and trust the verified scripts before explicit unblocking;
the distribution `README.txt` explains checksums and Windows download marks.

### Portable use

1. Run `Setup.cmd` in the extracted directory. It checks the prerequisites and
   uses the standard existing Lodestar database when present; otherwise it asks
   for an absolute database path. Node is found from your installed runtime or
   selected with `-NodePath`. To create a new
   store, pass `-DatabasePath "C:\Data\lodestar.db" -InitializeDatabase` explicitly;
   choose an absent database outside the app folder with an existing parent directory.
   Neither app creates a store when it opens, and Setup refuses to overwrite an
   existing `interfaces.json`.
2. Run `Loader.cmd` for the Windows console or `Manager.cmd` for the terminal
   menu. Both read the configured `interfaces.json` and use the same database.
   Keep that configuration with the portable directory.
3. For a later portable release, close Loader and Manager, extract the new ZIP
   into a separate directory, then run
   `Update.cmd "C:\path\to\existing app"` from the new release
   directory. The updater stages and validates the
   replacement, preserves the configured store and local configuration, and
   retains the prior validated bundle. If an update is interrupted, run
   `pwsh -NoProfile -File .\Update.ps1 -Mode Recover -Destination "C:\path\to\existing app"`
   from the new release folder. Recovery follows the saved transaction journal;
   it does not downgrade a successfully completed update. Keep the transaction
   folders until recovery reports its outcome. Each launcher supports `--help`.

`Lodestar.cmd` invokes the configured core/store with literal arguments. The CLI
launcher rejects attempts to override its binding; invoke the selected core explicitly
when deliberately choosing another database. Owned installations use `Install` for
updates and recovery; portable `Update` refuses those targets so their ownership receipt
and Windows registration remain coherent. Downgrades and unsupported store schemas
are refused before staging. Each launcher supports `--help`.

The apps invoke the packaged CLI as one-shot operations. The database
remains a separate Windows-owned file; do not copy only its main SQLite file as a
backup while a WAL file may be present. An older schema-4 store still needs the
[explicit migration/recovery procedure](../README.md#storage-and-recovery).
The [3.0.0 release notes](releases/v3.0.0.md) describe the interface changes.

## Homes and discovery

By default verification uses the current process environment, including CODEX_HOME,
CLAUDE_CONFIG_DIR, HERMES_HOME, XDG_CONFIG_HOME, and OPENCODE_CONFIG_DIR. An explicit
`--home` selects another user's home and isolates inherited host overrides. Use
`--hermes-home`, `--codex-home`, `--claude-home`, `--xdg-config-home`,
`--opencode-root`, and `--codex-root` for explicit routing.

Always inspect the returned roots. A newly launched terminal may inherit different
environment values from an already-running desktop app. On Windows Hermes defaults
to LOCALAPPDATA/hermes unless its invocation sets HERMES_HOME. A portable Hermes
home and the platform default may both need installation if both are used.

OpenCode also discovers shared Claude and agents skill directories. Setup updates
existing discovered copies of owned skills together; it does not delete another
host's skill merely because it is also visible to OpenCode. Physical aliases are
processed once. Identical mirrors are reported; divergent copies fail verification.
Hermes additionally checks nested skill names. Its native loader rejects ambiguous
names even when their content matches, so setup reports those collisions for
deliberate retirement or scoping before any replacement.

File verification covers the reported user roots. Before declaring host startup
ready, inspect that host's native discovery, skill enablement, active plugins,
global instructions, and any configured additional or project-specific roots.
Legacy instructions can still demand retired commands even when skills are current.
Replace only the stale owning passages, preserving unrelated user instructions.
Do not enable an old Lodestar plugin alongside the current native skill.

Lodestar's Codex metadata explicitly sets `policy.allow_implicit_invocation: true`
in `agents/openai.yaml`. This makes the skill eligible for automatic selection on
relevant project work. It does not launch a background service or guarantee that
every prompt invokes Lodestar. A host-level disabled skill remains disabled.
Native instructions such as `AGENTS.md` still apply alongside Lodestar's context.

Version 2.1.3 corrects a policy defect: 2.1.2 shipped with `allow_implicit_invocation: false`, despite the skill's
automatic-use description. That prevented implicit Codex invocation. Restarting
or reinstalling that uncorrected package does not change its policy. When checking
an upgrade, inspect the invocation policy in the installed metadata, verify the
native loader reports Lodestar as enabled, then exercise a fresh relevant task
without mentioning the skill. File and manifest verification alone cannot prove
automatic selection.

## Optional Codex plugin

The skill and CLI work without the optional MCP plugin. `lodestar setup` installs
native skills and launchers; it does not enable a plugin or modify Codex settings.
Add the three structured tools by installing the complete package through Codex:

```text
codex plugin marketplace add VerbalChainsaw/Lodestar --ref v3.0.0
codex plugin add lodestar@lodestar
```

For a local package, add its root directory as a marketplace instead. The included
`.agents/plugins/marketplace.json` points to the package root. This is also the root
for custom marketplace entries. Node.js 24.15.0 or newer must be available to the
host. Initialize or select the intended Lodestar store through the CLI first.

For a Codex host running inside WSL, install the Windows CLI and its WSL launcher
first, as described below. Both Linux Node for the MCP adapter and the `lodestar`
WSL launcher must be on that host's PATH. The adapter delegates each operation to
the launcher so SQLite stays on Windows; it does not create a separate Linux store.

Version 2.1.4 moves `.codex-plugin/plugin.json` and `.mcp.json` to the package root.
The old `codex-plugin/` directory alone omitted the shared core when Codex cached
it, so plugin installation could report success while its server failed to start.
Update custom marketplace paths to the complete package root and reinstall the
plugin. A global npm upgrade cannot refresh a separately cached Codex plugin.

Keep one active Lodestar plugin installation. Inspect existing plugin IDs before
switching marketplaces and disable or remove an older plugin through Codex. Keep
native skill enablement under your own host settings; installation does not
override a disabled skill or remove user-owned instructions. Start a fresh task
and verify `lodestar_describe`, `lodestar_read`, and `lodestar_mutate` are available.
The release checks exercise the isolated cached runtime; actual model selection
still depends on the task and host configuration.

## Windows and WSL

The package manager installs the Windows CLI. Setup discovers the standard launcher
from the selected home: `<home>/.local/bin/lodestar` for Windows Git Bash, or the
same location in a Windows-visible WSL home. No hand-written launcher is needed.
Native Unix package-manager installation continues to own its executable. Explicit
launcher options select a custom destination:

```text
lodestar setup --target codex --posix-shim <Git-Bash-launcher-path> --apply
lodestar setup --target all --home <Windows-visible-WSL-home> --hermes-home <Windows-visible-Hermes-home> --wsl-shim <Windows-visible-launcher-path> --apply
```

Unchanged launchers with matching installation receipts upgrade automatically.
Review unowned or edited launchers and use `--replace-local` to replace their exact
observed content with a retained backup. The first upgrade from a release without
launcher receipts may require this review. Launcher paths must be outside managed
skill trees and recovery metadata. The launcher records the installing Node executable
and package path; rerun setup when moving the installation or replacing Node.

WSL invokes Windows Node for each operation. The shim translates declared path
arguments regardless of global option order and supplies the actual WSL working
directory. The database stays on a Windows filesystem and is never opened by
Linux Node. The generator rejects Linux-filesystem database paths.

Exercise both `lodestar skills verify` and `lodestar --human skills verify`, then
run `lodestar start --cwd <the-same-project>` from different launch directories.
The reported home and project identity must remain correct. A successful JSON
envelope means the operation ran; inspect `verified`, `healthy`, source completeness,
and the returned scope before claiming successful installation or startup.

## Startup self-check and operating guidance

`start` includes `operating_guide` from the maintained package bootstrap and
`installation` from the same resolver and plan used by setup. The MCP description
also exposes that guide. A missing or outdated owned asset yields a repair command
as an argument array; an agent already authorized to configure Lodestar can run it.
Local edits and ambiguous copies require review. Startup does not perform writes
or convert an installation warning into a failure of otherwise complete context.

The check reports its selected homes, skills, and launcher paths. It does not
certify additional project/plugin roots or the host's model, authentication, or
skill-selection settings. Host options supported by setup also scope the startup
check. Inspect the returned scope when a host has multiple homes.
Packaged Git Bash and WSL launchers forward their actual path on ordinary startup
and setup. Explicit `--home` selects another layout; pass `--wsl-shim` or
`--posix-shim` as well when that layout uses a custom launcher. Those selections
remain in the returned repair command.

## Complete input and output

Use UTF-8 files or stdin for mutation documents. A leading UTF-8 BOM and CRLF JSON
formatting are accepted; Unicode and line endings inside data strings retain their
meaning. Malformed UTF-8, duplicate decoded keys, unsafe integers, and decimal tokens
that would change meaning during numeric conversion fail before mutation. Store
arbitrary-precision numeric values as strings when exact JSON numbers cannot carry
them through the runtime.

For argument values too large or awkward for shell quoting, put the complete
argument array in a UTF-8 JSON file:

```json
["start", "--cwd", "C:/Projects/example", "--target", "codex"]
```

```text
lodestar --args-file arguments.json
```

`--args-stdin` reads the same array from stdin. These transport switches must be
the entire outer invocation; put all command, database, host, and output options
inside the array. Expansion happens once. If stdin carries the argument array,
provide a mutation body using `--file`. The native MCP read adapter uses this same
stdin transport, avoiding Windows command-line size limits.

The array is consumed by the Windows core when using WSL or Git Bash launchers.
Paths inside it must therefore be Windows-visible paths, including WSL UNC paths.
Include the intended `--cwd` and host options explicitly: the launcher translates
the outer argument-file path but does not inspect or rewrite its JSON contents.

If a host clips tool output, request a complete response file:

```text
lodestar start --cwd . --output complete-context.json
```

The destination must not already exist. It is reserved before dispatch and receives
the full UTF-8 success envelope. Stdout returns a compact descriptor with its path,
byte length, and SHA-256. Read the file completely and verify the descriptor; do not
infer missing context from a clipped display. A failed operation writes its complete
error envelope to the same file and returns the same descriptor inside the error
envelope on stderr, so verify the descriptor before using the file rather than
discarding it. Only an interrupted process can leave an empty or partial file.
If a mutation's response is lost after commit, retry the exact saved request to
recover its receipt without duplicating the effect.

## Agent contract discovery and recovery

Use `lodestar <command> --help` in JSON mode, or native `lodestar_describe`, for
the complete mutation envelope and operation input schema. `decision show` reads
the stream; `decision status` changes its status. Do not guess write fields.

CLI dispatch and MCP use the same read-operation declaration and mutation schemas.
Native domain mutations use the checkout in the supplied write basis. Core execution
errors arrive as MCP tool results with `isError: true` and the complete structured
recovery envelope, so the caller can inspect and correct the request.

An explicit project mapping keeps historical member records editable through their
fresh canonical basis. Work events and handoff packets retain the original record
scope. A changed binding invalidates a prior basis; reread before correcting it.
