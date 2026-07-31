import { Buffer } from "node:buffer";
import path from "node:path";

import { AGENT_BOOTSTRAP } from "./bootstrap.mjs";
import {
  initializeDatabase,
  openOrInitializeWriteDatabase,
  openDiagnosticDatabase,
  openReadDatabase,
  openWriteDatabase,
} from "./database.mjs";
import { diagnoseDatabase } from "./doctor.mjs";
import {
  errorResult,
  internalErrorResult,
  lodestarError,
} from "./errors.mjs";
import {
  canonicalStringify,
  parseJsonText,
  readStreamBounded,
  readTextFileBounded,
} from "./json.mjs";
import { importV070 } from "./import-v070.mjs";
import { resolveDatabasePath } from "./paths.mjs";
import {
  exportRegistry,
  findRecords,
  linkedRecords,
} from "./queries.mjs";
import {
  deleteRecord,
  getRecord,
  putRecord,
} from "./records.mjs";
import { LIMITS, validatePutInput } from "./validate.mjs";

export const LODESTAR_VERSION = "1.0.3";
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;

const COMMANDS = Object.freeze({
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
    usage:
      "lodestar import <v0.7-store-path> [--dry-run] [--db <path>]",
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
});

function helpData(command = null) {
  if (command) {
    const definition = COMMANDS[command];
    if (!definition) {
      throw lodestarError(
        "unknown_command",
        "The requested command is not part of the Lodestar CLI.",
        { identifiers: { command } },
      );
    }
    return {
      name: "lodestar",
      version: LODESTAR_VERSION,
      command,
      usage: definition.usage,
      summary: definition.summary,
      output: "JSON is the default; --human requests formatted output.",
    };
  }
  return {
    name: "lodestar",
    version: LODESTAR_VERSION,
    usage: "lodestar <command> [options]",
    commands: Object.entries(COMMANDS).map(([name, definition]) => ({
      name,
      summary: definition.summary,
    })),
    output: "JSON is the default; --human requests formatted output.",
  };
}

function humanHelp(data) {
  if (data.command) {
    return [
      `Lodestar ${data.version}`,
      "",
      `Usage: ${data.usage}`,
      "",
      data.summary,
    ].join("\n");
  }
  return [
    `Lodestar ${data.version}`,
    "",
    `Usage: ${data.usage}`,
    "",
    "Commands:",
    ...data.commands.map(({ name, summary }) => `  ${name.padEnd(7)} ${summary}`),
  ].join("\n");
}

function extractGlobals(args) {
  const rest = [];
  const global = {
    database: undefined,
    human: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") {
      rest.push(...args.slice(index));
      break;
    }
    if (token === "--human") global.human = true;
    else if (token === "--help" || token === "-h") global.help = true;
    else if (token === "--version" || token === "-v") global.version = true;
    else if (token === "--db") {
      if (global.database !== undefined) {
        throw lodestarError(
          "invalid_input",
          "--db was provided more than once.",
          { identifiers: { option: "--db" } },
        );
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw lodestarError(
          "missing_argument",
          "--db requires a path.",
          { identifiers: { option: "--db" } },
        );
      }
      global.database = value;
      index += 1;
    } else {
      rest.push(token);
    }
  }
  return { global, rest };
}

function parseCommand(command, args) {
  const definition = COMMANDS[command];
  const valueOptions = new Set(definition.values);
  const booleanOptions = new Set(definition.booleans);
  const options = {};
  const positionals = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (valueOptions.has(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw lodestarError(
          "missing_argument",
          `${token} requires a value.`,
          { identifiers: { command, option: token } },
        );
      }
      if (Object.hasOwn(options, token)) {
        throw lodestarError(
          "invalid_input",
          "An option was provided more than once.",
          { identifiers: { command, option: token } },
        );
      }
      options[token] = value;
      index += 1;
      continue;
    }
    if (booleanOptions.has(token)) {
      if (Object.hasOwn(options, token)) {
        throw lodestarError(
          "invalid_input",
          "An option was provided more than once.",
          { identifiers: { command, option: token } },
        );
      }
      options[token] = true;
      continue;
    }
    throw lodestarError(
      "unknown_option",
      "The command received an unsupported option.",
      { identifiers: { command, option: token } },
    );
  }
  if (positionals.length !== definition.positionals) {
    throw lodestarError(
      "missing_argument",
      "The command received the wrong number of positional arguments.",
      {
        identifiers: {
          command,
          expected: definition.positionals,
          actual: positionals.length,
        },
        action: `Use: ${definition.usage}`,
      },
    );
  }
  return { options, positionals };
}

async function withDatabase(open, file, operation) {
  const db = await open(file);
  try {
    return await operation(db);
  } finally {
    db.close();
  }
}

async function dispatch(command, parsed, database, io) {
  const { options, positionals } = parsed;
  if (command === "init") {
    return {
      ...(await initializeDatabase(database)),
      bootstrap: AGENT_BOOTSTRAP,
    };
  }
  if (command === "put") {
    const text = options["--file"]
      ? await readTextFileBounded(path.resolve(options["--file"]), {
        maximum: LIMITS.putInputBytes,
        resource: "put_input",
      })
      : await readStreamBounded(io.stdin, {
        maximum: LIMITS.putInputBytes,
        resource: "put_input",
      });
    const value = parseJsonText(text, {
      maximum: LIMITS.putInputBytes,
      resource: "put_input",
    });
    validatePutInput(value);
    return await withDatabase(openOrInitializeWriteDatabase, database, (db) =>
      putRecord(db, value, { database }));
  }
  if (command === "get") {
    return await withDatabase(openReadDatabase, database, (db) =>
      getRecord(db, positionals[0]));
  }
  if (command === "find") {
    return await withDatabase(openReadDatabase, database, (db) =>
      findRecords(db, positionals[0], {
        scope: options["--scope"],
        type: options["--type"],
        limit: options["--limit"],
      }));
  }
  if (command === "links") {
    return await withDatabase(openReadDatabase, database, (db) =>
      linkedRecords(db, positionals[0], {
        limit: options["--limit"],
      }));
  }
  if (command === "delete") {
    return await withDatabase(openWriteDatabase, database, (db) =>
      deleteRecord(db, positionals[0], { database }));
  }
  if (command === "doctor") {
    return await withDatabase(openDiagnosticDatabase, database, (db) =>
      diagnoseDatabase(db, { database }));
  }
  if (command === "import") {
    return await importV070({
      sourcePath: path.resolve(positionals[0]),
      database,
      dryRun: options["--dry-run"] === true,
    });
  }
  if (command === "export") {
    return await withDatabase(openReadDatabase, database, (db) =>
      exportRegistry(db).document);
  }
  throw lodestarError(
    "unknown_command",
    "The requested command is not part of the Lodestar CLI.",
    { identifiers: { command } },
  );
}

function writeSuccess(io, data, human) {
  const text = human
    ? JSON.stringify(data, null, 2)
    : canonicalStringify({ ok: true, data });
  const bytes = Buffer.byteLength(text, "utf8") + 1;
  if (bytes > LIMITS.commandOutputBytes) {
    throw lodestarError(
      "resource_limit",
      "The command output exceeds its byte limit.",
      {
        identifiers: {
          resource: "command_output",
          bytes,
          maximum: LIMITS.commandOutputBytes,
        },
        action: "Narrow the request or reduce the stored registry.",
      },
    );
  }
  io.stdout.write(`${text}\n`);
}

function validateArguments(args) {
  let total = 0;
  for (const [index, argument] of args.entries()) {
    if (typeof argument !== "string") {
      throw lodestarError(
        "invalid_input",
        "CLI arguments must be strings.",
        { identifiers: { index, type: typeof argument } },
      );
    }
    if (UNPAIRED_SURROGATE.test(argument)) {
      throw lodestarError(
        "invalid_input",
        "CLI arguments cannot contain unpaired Unicode surrogates.",
        { identifiers: { index } },
      );
    }
    const bytes = Buffer.byteLength(argument, "utf8");
    if (bytes > LIMITS.cliArgumentBytes) {
      throw lodestarError(
        "resource_limit",
        "A CLI argument exceeds its byte limit.",
        {
          identifiers: {
            index,
            bytes,
            maximum: LIMITS.cliArgumentBytes,
          },
          action: "Use a shorter argument and retry.",
        },
      );
    }
    total += bytes;
  }
  if (total > LIMITS.cliArgumentsBytes) {
    throw lodestarError(
      "resource_limit",
      "The CLI arguments exceed their total byte limit.",
      {
        identifiers: {
          bytes: total,
          maximum: LIMITS.cliArgumentsBytes,
        },
        action: "Use fewer or shorter arguments and retry.",
      },
    );
  }
}

export async function runCli(
  args = process.argv.slice(2),
  io = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
) {
  try {
    if (!Array.isArray(args)) {
      throw lodestarError(
        "invalid_input",
        "CLI arguments must be an array.",
        { identifiers: { field: "args" } },
      );
    }
    if (args.length > 64) {
      throw lodestarError(
        "resource_limit",
        "The CLI argument count exceeds its limit.",
        { identifiers: { count: args.length, maximum: 64 } },
      );
    }
    validateArguments(args);
    const { global, rest } = extractGlobals(args);
    const command = rest[0] ?? null;
    if (global.version) {
      const data = { name: "lodestar", version: LODESTAR_VERSION };
      writeSuccess(io, data, global.human);
      return 0;
    }
    if (global.help || command === null) {
      const data = helpData(command);
      if (global.human) io.stdout.write(`${humanHelp(data)}\n`);
      else writeSuccess(io, data, false);
      return 0;
    }
    if (!Object.hasOwn(COMMANDS, command)) {
      throw lodestarError(
        "unknown_command",
        "The requested command is not part of the Lodestar CLI.",
        { identifiers: { command } },
      );
    }
    const parsed = parseCommand(command, rest.slice(1));
    const database = resolveDatabasePath({ explicit: global.database });
    const data = await dispatch(command, parsed, database, io);
    writeSuccess(io, data, global.human);
    return command === "doctor" && data.healthy === false ? 4 : 0;
  } catch (error) {
    let normalized;
    try {
      normalized = errorResult(error);
    } catch {
      normalized = internalErrorResult();
    }
    let text;
    try {
      text = canonicalStringify(normalized.envelope);
    } catch {
      text = JSON.stringify({
        ok: false,
        error: {
          code: "internal_error",
          message: "Lodestar could not encode the operation error.",
          identifiers: {},
          action: "Retry the command. If it fails again, run lodestar doctor.",
        },
      });
    }
    io.stderr.write(`${text}\n`);
    return normalized.exitCode;
  }
}
