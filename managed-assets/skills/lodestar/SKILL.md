---
name: lodestar
description: "Use Lodestar for startup context, knowledge, advisory work presence, continuity, durable decisions, read-only skill verification, and read-only agent-instruction inspection."
---

# Lodestar

Use the installed `lodestar` CLI as the single local machine-state boundary.
Lodestar does not own external skill directories or AGENTS.md files.

## Route by capability

- `lodestar start --cwd <path>` returns complete startup context by default; an explicit budget targets optional context only.
- `lodestar put|get|find|links|delete|import|export` manages scoped knowledge.
- `lodestar work status|start|done|history|expire` manages advisory work presence.
- `lodestar handoff arm|status|checkpoint|now|disarm` manages session continuity.
- `lodestar decision set|drop|show|inject` manages current and superseded decisions.
- `lodestar skills verify` compares installed skill copies with package source without writing them.
- `lodestar agents status|verify|template` inspects repository AGENTS.md state or prints source text without writing it.
- `lodestar pending list|add|promote|drop` queues candidates outside startup.
- `lodestar doctor` diagnoses the local registry.

JSON is the default output. Add `--human` only for human-formatted output.
Do not create a daemon or access the SQLite database directly from WSL.

Read only the reference needed for the current operation:

- [knowledge.md](references/knowledge.md)
- [work-presence.md](references/work-presence.md)
- [continuity.md](references/continuity.md)
- [decisions.md](references/decisions.md)
- [bootstrap-and-failures.md](references/bootstrap-and-failures.md)
- [governance-package.md](references/governance-package.md)
- [toolchain.md](references/toolchain.md)
- [templates.md](references/templates.md)

## Read-only skill verification

Run:

```text
lodestar skills verify --target all
```

Targets are `codex`, `claude`, `hermes`, `opencode`, or `all`. Verification reports
`verified`, `missing`, `stale`, `duplicate`, or `alternate-root-only` from the files
already present. It creates no directory, copies no skill, migrates no root, writes no
bootstrap file, and removes nothing. Install, sync, migration, replacement, and removal
belong outside Lodestar.

## Read-only AGENTS.md inspection

- Inspect: `lodestar agents status --cwd .`
- Verify against the canonical minimal bootstrap: `lodestar agents verify --cwd .`
- Print source without writing: `lodestar agents template --mode stub|full --cwd .`

Lodestar never creates, upgrades, replaces, removes, or backs up an AGENTS.md file.
Project and global agent files remain wholly owned by the user and their native tools.

## Recording something worth keeping

Write a `[NOTE text="what's worth keeping"]` marker in the final message and the Stop
hook captures it as a candidate (the historical `LODESTAR NOTE: <text>` line is still
accepted). Candidates sit in a quarantine scope that startup never reads, so
capturing costs the startup budget nothing. Review with `lodestar pending`, then
`promote` what is durable and `drop` the rest. Promotion never marks a record required.