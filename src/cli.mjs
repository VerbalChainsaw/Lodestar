import { Buffer } from "node:buffer";
import { COMMANDS } from "./cli-commands.mjs";
import {
  errorResult,
  internalErrorResult,
  lodestarError,
} from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";
import { dispatch, operationResult } from "./agent-state.mjs";
import { resolveDatabasePath } from "./paths.mjs";
import { manageSkills } from "./skills.mjs";
import { LIMITS } from "./validate.mjs";
import { LODESTAR_VERSION } from "./version.mjs";
export { LODESTAR_VERSION } from "./version.mjs";
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
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
  const expected = definition.positionals;
  const validCount = typeof expected === "number"
    ? positionals.length === expected
    : positionals.length >= expected.min && positionals.length <= expected.max;
  if (!validCount) {
    throw lodestarError(
      "missing_argument",
      "The command received the wrong number of positional arguments.",
      {
        identifiers: {
          command,
          expected,
          actual: positionals.length,
        },
        action: `Use: ${definition.usage}`,
      },
    );
  }
  return { options, positionals };
}
function writeSuccess(io, operation, result, human) {
  const envelope = {
    v: 1,
    ok: true,
    operation,
    revision: result.revision,
    scope: result.scope,
    data: result.data,
    more: result.more,
    next: result.next,
  };
  const text = human
    ? JSON.stringify(envelope, null, 2)
    : canonicalStringify(envelope);
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
  let attemptedOperation = "cli";
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
    attemptedOperation = command ?? "help";
    if (global.version) {
      const data = { name: "lodestar", version: LODESTAR_VERSION };
      writeSuccess(io, "version", operationResult(data), global.human);
      return 0;
    }
    if (global.help || command === null) {
      const data = helpData(command);
      if (global.human) io.stdout.write(`${humanHelp(data)}\n`);
      else writeSuccess(io, "help", operationResult(data), false);
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
    if (["work", "handoff", "decision", "skills"].includes(command)) {
      attemptedOperation = `${command}.${parsed.positionals[0] ?? "status"}`;
    }
    if (command === "skills") {
      const result = operationResult(await manageSkills(parsed.positionals[0], {
        target: parsed.options["--target"],
        home: parsed.options["--home"],
        dryRun: parsed.options["--dry-run"] === true,
        codexRoot: parsed.options["--codex-root"],
        hermesHome: parsed.options["--hermes-home"],
        opencodeRoot: parsed.options["--opencode-root"],
        migrate: parsed.options["--migrate"] === true,
        bootstrapFiles: parsed.options,
      }));
      writeSuccess(io, attemptedOperation, result, global.human);
      return result.data.verified === false ? 4 : 0;
    }
    const database = resolveDatabasePath({ explicit: global.database });
    const result = await dispatch(command, parsed, database, io);
    const operation = ["work", "handoff", "decision", "pending"].includes(command)
      ? `${command}.${parsed.positionals[0] ?? "status"}`
      : command;
    writeSuccess(io, operation, result, global.human);
    return command === "doctor" && result.data.healthy === false ? 4 : 0;
  } catch (error) {
    let normalized;
    try {
      normalized = errorResult(error);
    } catch {
      normalized = internalErrorResult();
    }
    let text;
    try {
      text = canonicalStringify({
        v: 1,
        ok: false,
        operation: attemptedOperation,
        revision: null,
        scope: { project: null, cwd: null, session: null, actor: null },
        error: normalized.envelope.error,
        more: false,
        next: normalized.envelope.error?.action
          ? [normalized.envelope.error.action]
          : [],
      });
    } catch {
      text = JSON.stringify({
        v: 1,
        ok: false,
        operation: "cli",
        revision: null,
        scope: { project: null, cwd: null, session: null, actor: null },
        error: {
          code: "internal_error",
          message: "Lodestar could not encode the operation error.",
          identifiers: {},
          action: "Retry the command. If it fails again, run lodestar doctor.",
        },
        more: false,
        next: [],
      });
    }
    io.stderr.write(`${text}\n`);
    return normalized.exitCode;
  }
}
