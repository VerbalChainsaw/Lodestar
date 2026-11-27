# Machine doctrine: <MACHINE NAME>

Read the nearest repo `AGENTS.md` first. This file is machine-level only.

> Template. Replace the machine name, delete the sections that do not apply,
> and add the specific lies your environment tells agents. Keep it short.
> Everything here loads into every session on this box.

## Shell reality

State what the shell *actually* is, not what it looks like. This is the single
highest-yield section: more agent runs break on wrong shell assumptions than on
bad architecture.

- Many agent shells here are PowerShell-backed or shell-wrapped. Verify actual
  shell semantics before assuming Unix behavior.
- If you need real Git Bash behavior, invoke `bash -c ...` explicitly instead of
  assuming the current shell already is one.
- Prefer `rg`, `git ls-files`, and repo-relative globs before broad recursive scans.
- Do not assume Python, Node, or package tools are on `PATH`; verify the real
  executable before you install or depend on it.

## Global rules

- Treat repo-local `AGENTS.md` and `CLAUDE.md` as more specific than this file.
  **This precedence is load-bearing.** It is what lets a single repo forbid
  workflows this file would otherwise permit.
- Keep global context machine-level. Do not store repo-specific ports,
  architecture, backlog, or branch state here.
- Do not run destructive commands or discard uncommitted work without explicit
  approval.
- If a repo has deeper docs, link to them or read them on demand instead of
  duplicating them here.
- When a tool or package might already exist, check first before installing
  anything new.

## What does not belong here

Resist the urge to grow this file. It is loaded every session, so every line
costs context on every task. Project rules go in that project's `AGENTS.md`.
Working style goes in a skill. Only facts that are true of *this machine, always*
belong in this file.
