# Installation and startup

For a new installation, use Node.js 24.15.0 or newer:

```text
npm install --global lodestar-agent-context@2.1.3
lodestar setup --target all
lodestar setup --target all --apply
lodestar init
lodestar skills verify --target all
lodestar doctor
lodestar start --cwd .
```

Use `lodestar init` only when creating a new store. An existing store must pass
the [migration/recovery procedure](../README.md#storage-and-recovery); setup never
changes a database. You can also install the versioned tarball from the
[GitHub release](https://github.com/VerbalChainsaw/Lodestar/releases/tag/v2.1.3).

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
infer missing context from a clipped display. A failed operation can leave an empty
or partial output file; without the success descriptor it is not verified output.
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
