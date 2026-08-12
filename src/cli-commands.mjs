import {
  CONTINUITY_COMMAND,
  SERVE_COMMAND,
} from "./continuity-cli.mjs";

export const COMMANDS = Object.freeze({
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
      "lodestar find <query> [--scope <scope>] [--type <type>] [--limit <n>]",
    summary: "Search bounded structured context.",
    values: ["--scope", "--type", "--limit"],
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
    usage: "lodestar import <v0.7-store-path> [--dry-run] [--db <path>]",
    summary: "Import one v0.7 store into an empty registry.",
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
  continuity: CONTINUITY_COMMAND,
  serve: SERVE_COMMAND,
});
