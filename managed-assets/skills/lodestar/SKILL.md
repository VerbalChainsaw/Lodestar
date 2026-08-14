---
name: lodestar
description: "Use Lodestar for startup context, knowledge, advisory work presence, continuity, durable decisions, managed client skills, and agent-instruction templates."
---

# Lodestar

Use the installed `lodestar` CLI as the single local machine-state boundary.

## Route by capability

- `lodestar start --cwd <path>` returns bounded startup context.
- `lodestar put|get|find|links|delete|import|export` manages scoped knowledge.
- `lodestar work status|start|done|history|expire` manages advisory work presence.
- `lodestar handoff arm|status|checkpoint|now|disarm` manages session continuity.
- `lodestar decision set|drop|show|inject` manages current and superseded decisions.
- `lodestar skills install|sync|verify|remove` manages this package.
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

## Managed agent skills

- Preview: `lodestar skills sync --target all --dry-run`
- Install: `lodestar skills install --target all`
- Sync: `lodestar skills sync --target all`
- Verify: `lodestar skills verify --target all`
- Remove: `lodestar skills remove --target all`

Targets are `codex`, `claude`, `hermes`, `opencode`, or `all`. Codex installs
under exactly one recognized root, Claude under `~/.claude/skills`, Hermes
under `<HERMES_HOME>/skills`, and OpenCode under
`~/.config/opencode/skills`. Lodestar keeps replacement backups outside skill
discovery: `~/.lodestar/skill-backups` normally, or
`~/.local/state/.lodestar/skill-backups` when called through the WSL shim.

Use the templates bundled under `assets/templates/` only when asked to create or
refresh agent instructions. Read [references/templates.md](references/templates.md)
before applying one. The templates travel with this skill, so install, sync,
backup, and verification use the same Lodestar command rather than another
installer.
