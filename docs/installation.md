# Installation and startup

Install the supplied package with Node.js 24.15.0 or newer:

```text
npm install --global ./lodestar-agent-context-2.0.1.tgz
lodestar setup --target all
lodestar setup --target all --apply
lodestar skills verify --target all
lodestar doctor
lodestar start --cwd .
```

Use `lodestar init` only when creating a new store. An existing store must pass
the documented migration/recovery procedure; setup never changes a database.

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

Setup preflights selected content before replacement. Replacement is atomic per
directory rename and recoverable per skill, not transactional across all hosts.
Run upgrades between host sessions and start fresh sessions afterward because
hosts may retain already-loaded instructions.

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

## Windows and WSL

The package manager installs the Windows CLI. Explicit launcher options are:

```text
lodestar setup --target codex --posix-shim <Git-Bash-launcher-path> --apply
lodestar setup --target all --home <Windows-visible-WSL-home> --hermes-home <Windows-visible-Hermes-home> --wsl-shim <Windows-visible-launcher-path> --apply
```

Review existing launchers and use `--replace-local` to replace their exact observed
content with a retained backup. The launcher records the installing Node executable
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
