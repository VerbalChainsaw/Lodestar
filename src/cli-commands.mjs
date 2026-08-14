export const COMMANDS = Object.freeze({
  start: {
    usage: "lodestar start [--cwd <path>] [--session <id>] [--agent <name>] "
      + "[--harness <name>] [--startup-budget <bytes>]",
    summary: "Resolve one project and return its bounded startup projection.",
    values: ["--cwd", "--session", "--agent", "--harness", "--startup-budget"],
    booleans: [],
    positionals: 0,
  },
  init: {
    usage: "lodestar init [--db <path>]",
    summary: "Initialize the SQLite registry.",
    values: [],
    booleans: [],
    positionals: 0,
  },
  put: {
    usage: "lodestar put [--file <path>] [--db <path>]",
    summary: "Insert or replace one record, initializing on first write.",
    values: ["--file"],
    booleans: [],
    positionals: 0,
  },
  get: {
    usage: "lodestar get <id-or-alias> [--db <path>]",
    summary: "Retrieve one exact record or alias.",
    values: [],
    booleans: [],
    positionals: 1,
  },
  find: {
    usage:
      "lodestar find <query> [--scope <scope>] [--kind <kind>] [--limit <n>]",
    summary: "Search bounded structured context.",
    values: ["--scope", "--kind", "--type", "--limit"],
    booleans: [],
    positionals: 1,
  },
  links: {
    usage: "lodestar links <id-or-alias> [--limit <n>] [--db <path>]",
    summary: "Return explicit incoming and outgoing links.",
    values: ["--limit"],
    booleans: [],
    positionals: 1,
  },
  delete: {
    usage: "lodestar delete <id-or-alias> [--db <path>]",
    summary: "Delete one record and its dependent rows.",
    values: [],
    booleans: [],
    positionals: 1,
  },
  doctor: {
    usage: "lodestar doctor [--db <path>]",
    summary: "Diagnose schema and referential integrity.",
    values: [],
    booleans: [],
    positionals: 0,
  },
  import: {
    usage: "lodestar import <source-or-manifest.json> [--dry-run] [--db <path>]",
    summary: "Import supported historical state into the one Lodestar registry.",
    values: [],
    booleans: ["--dry-run"],
    positionals: 1,
  },
  export: {
    usage: "lodestar export [--db <path>]",
    summary: "Export the registry as canonical JSON.",
    values: [],
    booleans: [],
    positionals: 0,
  },
  work: {
    usage: "lodestar work [status|start|done|history|expire] [text] [options]",
    summary: "Read or update advisory project work reports.",
    values: ["--cwd", "--session", "--agent", "--harness", "--limit",
      "--older-than-hours"],
    booleans: [],
    positionals: { min: 0, max: 2 },
  },
  handoff: {
    usage: "lodestar handoff <arm|status|checkpoint|now|disarm> [options]",
    summary: "Manage one session-bound Lodestar continuity lane and recovery.",
    values: ["--cwd", "--session", "--agent", "--harness", "--file", "--turn",
      "--role"],
    booleans: [],
    positionals: 1,
  },
  decision: {
    usage: "lodestar decision <set|drop|show|inject> [key] [value] [options]",
    summary: "Record and project durable current and superseded project decisions.",
    values: ["--cwd", "--session", "--agent", "--harness", "--reason"],
    booleans: [],
    positionals: { min: 1, max: 3 },
  },
  pending: {
    usage: "lodestar pending [list|add|promote|drop] [text-or-id] "
      + "[--source <name>] [--limit <n>] [options]",
    summary: "Queue captured candidates outside startup, then promote or drop them.",
    values: ["--cwd", "--session", "--agent", "--harness", "--source", "--limit"],
    booleans: [],
    positionals: { min: 0, max: 2 },
  },
  skills: {
    usage: "lodestar skills <install|sync|verify|remove> "
      + "[--target <codex|claude|hermes|opencode|all>] [--codex-root <codex|agents>] "
      + "[--hermes-home <path>] [--opencode-root <path>] [--migrate] "
      + "[--codex-bootstrap <path>] [--claude-bootstrap <path>] "
      + "[--hermes-bootstrap <path>] [--opencode-bootstrap <path>] "
      + "[--home <path>] [--dry-run]",
    summary: "Install, sync, verify, or remove Lodestar-managed local agent skills.",
    values: ["--target", "--codex-root", "--hermes-home", "--opencode-root", "--home",
      "--codex-bootstrap", "--claude-bootstrap", "--hermes-bootstrap",
      "--opencode-bootstrap"],
    booleans: ["--dry-run", "--migrate"],
    positionals: 1,
  },
});
