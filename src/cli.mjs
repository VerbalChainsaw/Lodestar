import { COMMANDS, hostOptions, installationOptions } from "./cli-commands.mjs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { manageAgents } from "./agents.mjs";
import {
  errorResult,
  internalErrorResult,
  lodestarError,
} from "./errors.mjs";
import { canonicalStringify, parseJsonText, readStreamComplete, readTextFileComplete } from "./json.mjs";
import { dispatch, operationResult } from "./agent-state.mjs";
import { resolveDatabasePath, resolveInputPath } from "./paths.mjs";
import { manageSkills } from "./skills.mjs";
import { setup } from "./setup.mjs";
import { LODESTAR_VERSION } from "./version.mjs";
import { CONTRACT_VERSION } from "./schema.mjs";
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
      transport: "Use --args-file <JSON-array-file> or --args-stdin for complete command arguments; --output <new-file> saves the complete response with a hash receipt.",
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
    transport: "Use --args-file <JSON-array-file> or --args-stdin for complete command arguments; --output <new-file> saves the complete response with a hash receipt.",
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
      "", data.transport,
    ].join("\n");
  }
  return [
    `Lodestar ${data.version}`,
    "",
    `Usage: ${data.usage}`,
    "",
    "Commands:",
    ...data.commands.map(({ name, summary }) => `  ${name.padEnd(7)} ${summary}`),
    "", data.transport,
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
    else if (token === "--db" || token === "--output") {
      const field = token === "--db" ? "database" : "output";
      if (global[field] !== undefined) {
        throw lodestarError(
          "invalid_input",
          `${token} was provided more than once.`,
          { identifiers: { option: token } },
        );
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw lodestarError(
          "missing_argument",
          `${token} requires a path.`,
          { identifiers: { option: token } },
        );
      }
      global[field] = value;
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
async function writeSuccess(io, operation, result, human) {
  const envelope = {
    v: CONTRACT_VERSION,
    ok: true,
    operation,
    revision: result.revision,
    database_instance_id: result.database_instance_id,
    database_epoch: result.database_epoch,
    request: result.request,
    ...(result.receipt_id ? { receipt_id: result.receipt_id } : {}),
    scope: result.scope,
    data: result.data,
    more: result.more,
    next: result.next,
  };
  const text = human
    ? JSON.stringify(envelope, null, 2)
    : canonicalStringify(envelope);
  if (io.outputFile) {
    const content = Buffer.from(`${text}\n`, "utf8");
    await io.outputFile.handle.writeFile(content);
    await io.outputFile.handle.sync();
    await io.outputFile.handle.close();
    io.stdout.write(`${canonicalStringify({ ...envelope, data: { output_file: {
      path: io.outputFile.path, bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"), encoding: "utf-8",
    } }, next: ["Read the complete output file and verify its byte count and SHA-256 before using its contents."] })}\n`);
  } else io.stdout.write(`${text}\n`);
}
function validateArguments(args) {
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
  let outputHandle;
  try {
    if (!Array.isArray(args)) {
      throw lodestarError(
        "invalid_input",
        "CLI arguments must be an array.",
        { identifiers: { field: "args" } },
      );
    }
    validateArguments(args);
    if (args[0] === "--args-file" || args[0] === "--args-stdin") {
      const fromFile = args[0] === "--args-file";
      if (args.length !== (fromFile ? 2 : 1)) throw lodestarError("invalid_input",
        "Use --args-file <file> or --args-stdin alone; place the complete command arguments in its JSON array.");
      const text = fromFile ? await readTextFileComplete(resolveInputPath(args[1]), { resource: "command_arguments" })
        : await readStreamComplete(io.stdin, { resource: "command_arguments" });
      args = parseJsonText(text, { resource: "command_arguments" });
      if (!Array.isArray(args)) throw lodestarError("invalid_input", "Command arguments must be a JSON array of strings.");
      validateArguments(args);
    }
    const { global, rest } = extractGlobals(args);
    if (global.output !== undefined) {
      const destination = resolveInputPath(global.output);
      // Reserve before dispatch: an unavailable/existing output must never hide
      // an already committed mutation. A completed response carries its hash.
      outputHandle = await open(destination, "wx");
      io = { ...io, outputFile: { path: destination, handle: outputHandle } };
    }
    const command = rest[0] ?? null;
    attemptedOperation = command ?? "help";
    // `help` and `version` are the first things anyone types, and rejecting them as
    // unknown commands while accepting --help and --version teaches that the CLI is
    // hostile before it has answered anything. They are spellings of the same request.
    const asked = { help: global.help || command === "help",
      version: global.version || command === "version" };
    if (asked.version) {
      const data = { name: "lodestar", version: LODESTAR_VERSION };
      await writeSuccess(io, "version", operationResult(data), global.human);
      return 0;
    }
    if (asked.help || command === null) {
      const data = helpData(command === "help" ? rest[1] ?? null : command);
      if (global.human && !io.outputFile) io.stdout.write(`${humanHelp(data)}\n`);
      else await writeSuccess(io, "help", operationResult(data), global.human);
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
    if (["work", "handoff", "decision", "skills", "agents"].includes(command)) {
      attemptedOperation = `${command}.${parsed.positionals[0] ?? "status"}`;
    }
    if (command === "agents") {
      const result = operationResult(await manageAgents(parsed.positionals[0] ?? "status", {
        cwd: parsed.options["--cwd"],
        mode: parsed.options["--mode"] ?? "stub",
      }));
      await writeSuccess(io, attemptedOperation, result, global.human);
      return result.data.verified === false && parsed.positionals[0] === "verify" ? 4 : 0;
    }
    if (command === "setup") {
      const result = operationResult(await setup({
        ...installationOptions(parsed.options),
        apply: parsed.options["--apply"], replaceLocal: parsed.options["--replace-local"],
      }));
      await writeSuccess(io, attemptedOperation, result, global.human);
      return result.data.ready === false || (parsed.options["--apply"] && result.data.verified === false) ? 4 : 0;
    }
    if (command === "skills") {
      const result = operationResult(await manageSkills(parsed.positionals[0] ?? "verify", {
        ...hostOptions(parsed.options),
      }));
      await writeSuccess(io, attemptedOperation, result, global.human);
      return result.data.verified === false ? 4 : 0;
    }
    const database = resolveDatabasePath({ explicit: global.database });
    const result = await dispatch(command, parsed, database, io);
    const operation = ["work", "handoff", "decision", "pending"].includes(command)
      ? `${command}.${parsed.positionals[0] ?? "status"}`
      : command;
    await writeSuccess(io, operation, result, global.human);
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
      const identifiers = normalized.envelope.error.identifiers ?? {};
      const revision = Number.isSafeInteger(identifiers.revision) ? identifiers.revision
        : Number.isSafeInteger(identifiers.database_revision) ? identifiers.database_revision : null;
      text = canonicalStringify({
        v: CONTRACT_VERSION,
        ok: false,
        operation: attemptedOperation,
        revision,
        database_instance_id: identifiers.database_instance_id ?? null,
        database_epoch: identifiers.database_epoch ?? null,
        request: identifiers.request_id ? { id: identifiers.request_id } : null,
        scope: { project: identifiers.project ?? null, cwd: identifiers.cwd ?? null,
          session: identifiers.session ?? null, actor: identifiers.actor ?? null },
        error: normalized.envelope.error,
        more: false,
        next: normalized.envelope.error?.action
          ? [normalized.envelope.error.action]
          : [],
      });
    } catch {
      text = JSON.stringify({
        v: CONTRACT_VERSION,
        ok: false,
        operation: "cli",
        revision: null,
        database_instance_id: null,
        database_epoch: null,
        request: null,
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
  } finally {
    await outputHandle?.close();
  }
}
