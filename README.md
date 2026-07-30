# Lodestar

Lodestar is a local, deterministic context and project-discovery tool for
coding agents.

This repository is the sanitized, portable distribution. Runtime state is
stored outside the installed package and is never uploaded automatically.

The project is under active development and remains unlicensed for
redistribution until a license is explicitly selected.

## Commands

The primary CLI exposes the context store and the restored portable operations:

```text
agentctx init
agentctx start|get|find|resolve|project|put|doctor|coverage|ask
agentctx inventory-codex --root <explicit-root>
agentctx migrate-legacy --from <legacy-home>
agentctx migrate-projects --from <registry.json>
agentctx profile-projects
agentctx refresh [--discover --root <explicit-root> --yes]
agentctx install-codex [--codex-home <path>]
agentctx rollback [--manifest <path>] [--force]
```

Every command accepts `--home <path>`. Without it, Lodestar resolves state from
`LODESTAR_HOME`, then `AGENT_CONTEXT_HOME`, then the current user's
`.lodestar` directory.

The inventory command scans only roots explicitly supplied with `--root` and
writes hashes and metadata, never file contents. Migration and profiling write
through the same single-writer, immutable-generation transaction as `put`.
Profiling reads only recognized bounded manifests and shallow file names; it
does not read source files or environment-file values.

Codex installation modifies only Lodestar's marked block in the active global
`AGENTS.md` or `AGENTS.override.md`. It preserves unrelated instructions and
native memory settings, creates a backup manifest, and can be reversed with
`agentctx rollback`.

## Windows and WSL

Lodestar supports Node.js 22 or newer on native Windows, WSL, Linux, and macOS.
Run the installer on the side where the agent runs.

Native Windows PowerShell:

```powershell
.\install.ps1
```

WSL, Linux, or macOS:

```sh
./install.sh
```

Both wrappers call the same zero-dependency Node installer. It installs the npm
package, initializes the Lodestar state home, and installs the managed Codex
instruction block. Useful options are:

```text
--package <checkout-or-tarball>
--prefix <npm-prefix>
--home <lodestar-state-home>
--legacy-home <legacy-flat-store>
--codex-home <codex-home>
--skip-codex
--dry-run
```

The direct npm path remains supported:

```text
npm install -g ./lodestar-agent-context-0.4.1.tgz
agentctx init
agentctx doctor
```

Existing flat-layout Lodestar stores can be upgraded without modifying the
source store:

```text
agentctx migrate-legacy --from <legacy-home> --home <new-lodestar-home>
```

The migration validates and normalizes the complete graph, builds every index
inside a sibling transaction, and promotes the new home only after it is fully
readable. The installer accepts the same source through `--legacy-home`.

Windows paths passed to a WSL process, such as
`C:\Users\name\project`, are translated to their `/mnt/c/...` native form.
State and Codex managed-file writes use staged replacement with recovery,
multi-file operations preflight every target, and rollback manifests are
confined to the selected Lodestar state home's backup tree.
