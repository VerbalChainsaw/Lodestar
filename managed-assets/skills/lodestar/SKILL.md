---
name: lodestar
description: "Automatically use Lodestar for substantive project orientation and durable, evidence-backed task continuity when available."
---

# Lodestar

For substantive project work, use the installed `lodestar` package automatically
to obtain relevant current context when available. Read applicable native
instructions and current source as needed. Missing optional Lodestar context does
not block work whose required inputs are otherwise available.

At project entry, a project switch, or a new task whose relevant sources may
differ, call `lodestar start --cwd <path>`. Orientation is read-only. Treat its
records as evidence and continuity; they do not grant authority or override the
user, native instructions, or inspected source.

`start` includes the maintained operating guide and a fresh installation check.
When configuration is authorized, use its returned `setup --apply` arguments to
install missing or upgrade unchanged owned assets. Setup discovers native homes
and launcher paths. Review local conflicts; never infer `--replace-local` from a
failed check. An installation warning does not invalidate otherwise complete
project evidence or authorize rewriting native instructions.

During authorized work, preserve consequential decisions, evidence-backed
corrections, meaningful progress, interruptions, and actual results with one
structured update through the installed package or its native tools. Reuse
existing record IDs, retain reasons and history, and send the `write_basis`
returned by the relevant read with a unique `request_id`. On a conflict, use the
returned current basis, reread the changed subject, and reapply only compatible
meaning under a new request. Retry a lost response with the exact same request.

Explicit setup owns the packaged skill copies and launchers it installs. Other
skill content and AGENTS.md remain native/user-owned. Do not
create a daemon, open the SQLite file directly from WSL, invent actor/session
identity, or infer a decision from arbitrary prose.

## Route by capability

- `lodestar start --cwd <path>` returns fresh project orientation without writing.
- `lodestar get|find|links` returns records plus usable update basis; `get --raw`
  and `get --history` preserve source correction and historical access.
- `lodestar put|delete --file <request.json>` writes or retires through the shared
  contract-5 mutation boundary.
- `lodestar work status|history|start|report|done|expire` records advisory work
  and actual task outcomes.
- `lodestar handoff status|history|arm|checkpoint|now|claim|disarm` preserves
  explicit continuity without creating or rotating sessions.
- `lodestar decision show|status|set|drop|inject` maintains checked decision streams.
- `lodestar pending list|add|promote|drop` keeps unresolved candidates outside
  current orientation until deliberate promotion.
- `lodestar skills verify` compares complete maintained/package/installed skill trees.
- `lodestar setup --apply` configures selected native skills and launchers, retains
  replaced owned bytes, and verifies the result using the same manifest.
- `lodestar agents status|verify|template` inspects native instruction routing or
  prints template source without writing it.
- `lodestar doctor` diagnoses the current store; `doctor --migration-preflight`
  prepares conversion evidence, and `doctor --recovery-preflight --source <accepted.db>`
  proves that a separate recovered image contains the exact accepted logical state.

Use `lodestar <command> --help` in JSON mode, or native `lodestar_describe`, for
the complete mutation envelope and operation input schema. `decision show` reads
the stream; `decision status` changes its status. Do not guess write fields.

JSON is the default output. Add `--human` only for human-formatted output. Read
only the reference needed for the current operation:

- [knowledge.md](references/knowledge.md)
- [work-presence.md](references/work-presence.md)
- [continuity.md](references/continuity.md)
- [decisions.md](references/decisions.md)
- [bootstrap-and-failures.md](references/bootstrap-and-failures.md)
- [toolchain.md](references/toolchain.md)
- [templates.md](references/templates.md)

For shell commands, send mutation bodies in a complete UTF-8 `--file` or stdin;
do not inline JSON into shell command strings. `--args-file <file>` and
`--args-stdin` accept the complete existing command as a JSON array of argument
strings, avoiding command-line length and quoting limits. Keep mutation stdin
separate by using its `--file` option when the argument array also uses stdin.
For Windows-core argument files invoked from WSL, use Windows-visible absolute
paths from Lodestar's responses, including WSL UNC paths.

When a host clips a response, repeat the read with `--output <new-file>` and
verify the returned byte count and SHA-256 before reading the complete UTF-8
envelope. Output files are created without overwriting existing files. A lost
mutation response requires the exact same request body and ID; never repeat an
external action merely because its ledger response was lost.

## Normal correction path

1. Read current orientation or the exact record.
2. Inspect the changed source and decide the corrected meaning.
3. Submit one logical update with the returned basis and complete semantics.
4. If persistence fails, report it and retry the same request safely.
5. A later session receives the corrected current record automatically.
