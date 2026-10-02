import { COMMANDS, capabilityOperations, hostOptions, installationOptions, MUTATION_INPUTS, READ_OPERATIONS } from "./cli-commands.mjs";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { Writable } from "node:stream";
import { manageAgents } from "./agents.mjs";
import {
  errorResult,
  internalErrorResult,
  lodestarError,
  wrapError,
} from "./errors.mjs";
import { canonicalStringify, parseJsonText, readStreamComplete, readTextFileComplete } from "./json.mjs";
import { dispatch, operationResult } from "./agent-state.mjs";
import { resolveDatabasePath, resolveInputPath } from "./paths.mjs";
import { manageSkills } from "./skills.mjs";
import { setup } from "./setup.mjs";
import { LODESTAR_VERSION } from "./version.mjs";
import { CONTRACT_VERSION, SCHEMA_VERSION } from "./schema.mjs";
import { MUTATION_REQUEST_SCHEMA, PUT_INPUT_SCHEMA, DELETE_INPUT_SCHEMA } from "./records.mjs";
import { directInterfaceSelection, loadInterfaceConfig } from "./interface-config.mjs";
import { runManager } from "./manager.mjs";
import { listRecovery, prepareCliJournal, recoveryReplay, retireCliJournal, storeCliResponse } from "./recovery-journal.mjs";
export { LODESTAR_VERSION } from "./version.mjs";
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const EXIT_CODES = Object.freeze({
  0: "Confirmed success; inspect ok and operation-specific completeness fields.",
  1: "Internal or unexpected failure; retain diagnostics and reconcile any dispatched write.",
  2: "Invalid input, unsupported option or missing identity; correct the stated fields.",
  3: "Not found or conflicting state; read the current basis before a new guarded request.",
  4: "Integrity/schema failure, or a successful diagnostic reporting unhealthy/not verified/not ready; inspect ok and diagnostic data.",
  5: "Storage, database or response-delivery failure; a dispatched write may require receipt reconciliation.",
});
function helpData(command = null) {
  const operations = capabilityOperations({ put: PUT_INPUT_SCHEMA, delete: DELETE_INPUT_SCHEMA,
    mutationRequest: MUTATION_REQUEST_SCHEMA });
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
      contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION,
      command,
      usage: definition.usage,
      summary: definition.summary,
      values: definition.values, booleans: definition.booleans, positionals: definition.positionals,
      global_values: ["--db <path>", "--output <new-file>"],
      global_booleans: ["--human", "--help", "--version"],
      argument_transport: operations[0].cli_inputs.global.argument_transport,
      read_operations: Object.keys(READ_OPERATIONS).filter((operation) => operation.split(".")[0] === command),
      mutation_inputs: Object.fromEntries(Object.entries({ put: PUT_INPUT_SCHEMA, delete: DELETE_INPUT_SCHEMA, ...MUTATION_INPUTS })
        .filter(([operation]) => operation.split(".")[0] === command)),
      mutation_request: ["put", "delete", "work", "handoff", "decision", "pending"].includes(command)
        ? MUTATION_REQUEST_SCHEMA : null,
      capability_version: 1,
      exit_codes: EXIT_CODES,
      operations: operations.filter(({ argv }) => argv[0] === command),
      output: "JSON is the default; --human requests formatted output.",
      transport: "Use --args-file <JSON-array-file> or --args-stdin as the entire outer invocation, with --db and every other option inside its JSON array. --output <new-file> writes the complete response envelope to a path that does not already exist; an occupied path is refused with output_conflict. On success stdout carries the {path, bytes, sha256} receipt for the written file; on failure the envelope is still written and the error envelope on stderr carries the same receipt.",
    };
  }
  return {
    name: "lodestar",
    version: LODESTAR_VERSION,
    contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION,
    usage: "lodestar <command> [options]",
    commands: Object.entries(COMMANDS).map(([name, definition]) => ({
      name,
      summary: definition.summary,
    })),
    capability_version: 1,
    exit_codes: EXIT_CODES,
    operations,
    output: "JSON is the default; --human requests formatted output.",
    transport: "Use --args-file <JSON-array-file> or --args-stdin as the entire outer invocation, with --db and every other option inside its JSON array. --output <new-file> writes the complete response envelope to a path that does not already exist; an occupied path is refused with output_conflict. On success stdout carries the {path, bytes, sha256} receipt for the written file; on failure the envelope is still written and the error envelope on stderr carries the same receipt.",
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
      "", "Exit codes:", ...Object.entries(data.exit_codes).map(([code, meaning]) => `  ${code}: ${meaning}`),
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
    "", "Exit codes:", ...Object.entries(data.exit_codes).map(([code, meaning]) => `  ${code}: ${meaning}`),
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
      { identifiers: { command, option: token }, action: `Use: ${definition.usage}. Run lodestar ${command} --help for supported options.` },
    );
  }
  if (command === "decision" && positionals.length === 0) positionals.push("show");
  if (command === "handoff" && positionals.length === 0) positionals.push("status");
  if (command === "find" && positionals.length === 0 && !options["--all"]) {
    throw lodestarError("missing_argument", "Find requires a query or an explicit --all selection.", {
      identifiers: { command }, action: `Use: ${definition.usage}. Supply a query, or select --all to read the catalog.`,
    });
  }
  const operation = `${command}.${positionals[0]}`;
  if (Object.hasOwn(MUTATION_INPUTS, operation) && ["--limit", "--offset", "--at-revision"].some(flag => options[flag] !== undefined)) {
    throw lodestarError("invalid_input", "Paging and revision flags are read options; mutation preconditions belong in the request write basis.");
  }
  if (Object.hasOwn(READ_OPERATIONS, operation) && !["work.check", "work.prepare-capture"].includes(operation) && options["--file"] !== undefined) {
    throw lodestarError("invalid_input", "This read does not consume a mutation file. Remove --file or choose the documented guarded mutation.");
  }
  if (command === "init" && options["--file"] &&
    !options["--migrate"] && !options["--promote-recovery"]) {
    throw lodestarError("invalid_input", "init --file requires an explicit conversion mode; no store was initialized.", {
      identifiers: { command, option: "--file" },
      action: "Use init --migrate --file <request> or init --promote-recovery --file <request> after the corresponding preflight. For a new empty store use init without --file.",
    });
  }
  if (command === "work" && positionals[0] === "check") {
    for (const flag of ["--limit", "--file"]) if (Object.hasOwn(options, flag)) {
      throw lodestarError("unknown_option", "The work check read does not accept this option.", {
        identifiers: { command: "work.check", option: flag },
        action: "Use work check <intent-record-id> [--cwd <path>] [--at-revision <n>]; see docs/intent-evidence.md.",
      });
    }
  }
  if (["work.prepare-capture", "work.attention"].includes(operation)) {
    const forbidden = ["--limit", "--session", "--agent", "--harness", ...(operation === "work.attention" ? ["--file"] : [])];
    for (const flag of forbidden) if (Object.hasOwn(options, flag)) throw lodestarError("unknown_option", "This project preparation or attention read does not accept the option.", {
      identifiers: { command: operation, option: flag }, action: "Use work prepare-capture --cwd <root> --file <draft.json>, or work attention [<intent-id>] --cwd <root>." });
    if (!options["--cwd"] || (operation === "work.prepare-capture" && !options["--file"])) throw lodestarError("missing_argument", "An explicit project root and capture draft file are required for this read.", {
      identifiers: { command: operation }, action: "Supply --cwd <root> and, for prepare-capture, --file <draft.json>." });
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
async function writeChannel(channel, value) {
  if (!(channel instanceof Writable)) { channel.write(value); return; }
  await new Promise((resolve, reject) => {
    let settled = false;
    const onError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    channel.once("error", onError);
    try {
      channel.write(value, (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          // A Writable emits 'error' after this callback; retain the once-listener
          // to absorb that event even though the caller has already been rejected.
          reject(error);
          setImmediate(() => channel.removeListener("error", onError));
        } else {
          channel.removeListener("error", onError);
          resolve();
        }
      });
    } catch (error) {
      channel.removeListener("error", onError);
      reject(error);
    }
  });
}
function successEnvelope(operation, result) {
  return {
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
}
async function writeSuccess(io, operation, result, human, delivery = null) {
  const envelope = successEnvelope(operation, result);
  if (io.recoveryJournal) {
    if (delivery) { delivery.phase = "recovery_response_save"; delivery.journal = io.recoveryJournal.folder; }
    await storeCliResponse(io.recoveryJournal, envelope);
    io.recoveryJournal.receiptSaved = true;
  }
  const text = human
    ? JSON.stringify(envelope, null, 2)
    : canonicalStringify(envelope);
  if (io.outputFile) {
    const outputFile = await persistResponse(io.outputFile, text, delivery);
    if (delivery) { delivery.outputFile = outputFile; delivery.phase = "stdout_receipt"; }
    await writeChannel(io.stdout, `${canonicalStringify({ ...envelope, data: { output_file: outputFile },
      next: ["Read the complete output file and verify its byte count and SHA-256 before using its contents."] })}\n`);
  } else {
    if (delivery) delivery.phase = "stdout_response";
    await writeChannel(io.stdout, `${text}\n`);
  }
  if(io.recoveryJournal){
    if(delivery)delivery.phase="recovery_journal_retire";
    try { await retireCliJournal(io.recoveryJournal,envelope); }
    catch(error){
      // A delivered success remains the single contract envelope. Cleanup is a
      // separate diagnostic; turning it into another envelope obscures commit.
      const diagnostic=errorResult(responseDeliveryError(error,result,delivery,
        io.outputFile?.path,io.recoveryJournal.context.database)).envelope.error;
      const warning=`Warning: recovery_journal_cleanup_failed ${canonicalStringify({
        ...diagnostic,code:"recovery_journal_cleanup_failed"})}\n`;
      if(delivery)delivery.phase="recovery_journal_warning";
      try { await writeChannel(io.stderr,warning); }
      catch { await writeChannel(io.stdout,warning); }
    }
  }
}

async function persistResponse(output, text, delivery = null) {
  const content = Buffer.from(`${text}\n`, "utf8");
  // The reservation precedes dispatch. Once delivery starts, a catch must not
  // replace partial or completed mutation evidence with a different envelope.
  output.started = true;
  if (delivery) delivery.phase = "output_write";
  await output.handle.writeFile(content);
  if (delivery) delivery.phase = "output_sync";
  await output.handle.sync();
  if (delivery) delivery.phase = "output_close";
  await output.handle.close();
  return { path: output.path, bytes: content.length,
    sha256: createHash("sha256").update(content).digest("hex"), encoding: "utf-8" };
}

function responseDeliveryError(error, result, delivery, outputPath, database) {
  const committed = typeof result.request?.id === "string" &&
    Number.isSafeInteger(result.request.committed_revision ?? result.revision);
  const identifiers = {
    phase: delivery.phase,
    ...(committed ? { committed:true, request_id: result.request.id,
      committed_revision: result.request.committed_revision ?? result.revision,
      request_replayed: result.request.replayed === true,
      ...(result.receipt_id ? { receipt_id: result.receipt_id,
        receipt_read_args: ["--db", database, "get", result.receipt_id] } : {}) } : {}),
    ...(result.database_instance_id ? { database_instance_id: result.database_instance_id } : {}),
    ...(result.database_epoch ? { database_epoch: result.database_epoch } : {}),
    ...(outputPath ? { output_path: outputPath } : {}),
    ...(delivery.outputFile ? { output_file: delivery.outputFile } : {}),
    ...(delivery.journal ? { journal:delivery.journal } : {}),
    ...(["recovery_journal_retire","recovery_journal_warning"].includes(delivery.phase) ? { response_delivered:true } : {}),
  };
  const cleanupFailed=["recovery_journal_retire","recovery_journal_warning"].includes(delivery.phase);
  const action = cleanupFailed
    ? "The success response was delivered. Use receipt_read_args to inspect the committed receipt; preserve remaining journal files and correct the reported recovery-storage problem. Do not submit a new mutation to repeat this committed write."
    : delivery.outputFile
    ? "Inspect the completed response file at output_file.path; verify output_file.bytes and output_file.sha256 before using it. Use receipt_read_args to inspect the committed receipt before any replay."
    : committed
      ? "Use receipt_read_args to inspect the committed receipt, then inspect the current record. Preserve the named journal and its exact request.json bytes and ID for any recovery. The response file, if reserved, is incomplete."
      : "Inspect the operation result through a fresh read. The response file, if reserved, is incomplete.";
  return lodestarError("response_delivery_failed", cleanupFailed
    ? "The mutation committed and its response was delivered, but recovery journal cleanup failed."
    : committed
    ? "The mutation committed, but response delivery failed."
    : "The operation completed, but response delivery failed.",
  { identifiers, action, cause: error });
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
    if (rest[0] === "manager" && global.output !== undefined) {
      throw lodestarError("invalid_input", "Manager cannot use --output; it owns an interactive terminal.");
    }
    if (global.output !== undefined) {
      const destination = resolveInputPath(global.output);
      // Reserve before dispatch: an unavailable/existing output must never hide
      // an already committed mutation. A completed response carries its hash.
      try {
        outputHandle = await open(destination, "wx");
      } catch (error) {
        if (error?.code === "EEXIST") throw lodestarError("output_conflict",
          "The --output path already exists.", {
            identifiers: { output: destination },
            action: "Choose a new --output file path; existing files are never overwritten.",
          });
        // The reservation runs before any dispatch, so nothing can have been accepted.
        // Reporting the generic unknown-write-outcome action here would send the caller
        // into a reconciliation that cannot find anything.
        throw wrapError(error, "invalid_path",
          "The --output path could not be reserved; no write was dispatched.", {
            identifiers: { output: destination },
            action: "Correct the output path or its parent directory and retry. Nothing needs reconciliation.",
          });
      }
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
      const data = { name: "lodestar", version: LODESTAR_VERSION, contract_version: CONTRACT_VERSION, schema_version: SCHEMA_VERSION };
      await writeSuccess(io, "version", operationResult(data), global.human);
      return 0;
    }
    if (asked.help || command === null) {
      const data = helpData(command === "help" ? rest[1] ?? null : command);
      if (global.human && !io.outputFile) await writeChannel(io.stdout, `${humanHelp(data)}\n`);
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
    if (command === "manager") {
      if (!io.stdin?.isTTY || !io.stdout?.isTTY) {
        throw lodestarError("interactive_terminal_required", "Manager needs an interactive terminal.", {
          action: "Run lodestar manager from a terminal with input and output attached." });
      }
      const selection = parsed.options["--interface-config"]
        ? await loadInterfaceConfig(parsed.options["--interface-config"], { database: global.database })
        : await directInterfaceSelection(global.database);
      return await runManager({ selection, io, initialProject: parsed.options["--project"],
        initialCwd: parsed.options["--cwd"] });
    }
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
    if (command === "recovery") {
      attemptedOperation = `recovery.${parsed.positionals[0]}`;
      const selection = parsed.options["--interface-config"]
        ? await loadInterfaceConfig(parsed.options["--interface-config"], { database, requireLoader: false })
        : await directInterfaceSelection(database);
      if (parsed.positionals[0] === "list" && parsed.positionals.length === 1) {
        await writeSuccess(io, attemptedOperation, operationResult(await listRecovery(selection)), global.human);
        return 0;
      }
      if (parsed.positionals[0] !== "replay" || parsed.positionals.length !== 2) {
        throw lodestarError("invalid_input", "Use recovery list or recovery replay <listed-key>.");
      }
      const replay = await recoveryReplay(selection, parsed.positionals[1], async (_selection, saved) => {
        attemptedOperation = saved.operation;
        io = { ...io, recoveryJournal: { folder: saved.journalFolder } };
        const replayParsed = parseCommand(saved.args[0], saved.args.slice(1));
        const result = await dispatch(saved.args[0], replayParsed, database, io);
        return { result, envelope: successEnvelope(saved.operation, result) };
      });
      io = { ...io, recoveryJournal: null };
      await writeSuccess(io, attemptedOperation, replay.result, global.human);
      return 0;
    }
    const operation = ["work", "handoff", "decision", "pending"].includes(command)
      ? `${command}.${parsed.positionals[0] ?? (command === "pending" ? "list" : "status")}`
      : command;
    attemptedOperation = operation;
    if (["put", "delete"].includes(operation) || Object.hasOwn(MUTATION_INPUTS, operation)) {
      io = { ...io, recoveryJournal: await prepareCliJournal(await directInterfaceSelection(database), operation, parsed, rest, io) };
    }
    const result = await dispatch(command, parsed, database, io);
    const delivery = { phase: "response_encode", outputFile: null };
    try { await writeSuccess(io, operation, result, global.human, delivery); }
    catch (error) { throw responseDeliveryError(error, result, delivery, io.outputFile?.path, database); }
    return command === "doctor" && result.data.healthy === false ? 4 : 0;
  } catch (error) {
    let normalized;
    try {
      normalized = errorResult(error,{read:Object.hasOwn(READ_OPERATIONS,attemptedOperation),operation:attemptedOperation});
    } catch {
      normalized = internalErrorResult();
    }
    let text;
    try {
      const identifiers = normalized.envelope.error.identifiers ?? {};
      const revision = Number.isSafeInteger(identifiers.committed_revision) ? identifiers.committed_revision
        : Number.isSafeInteger(identifiers.revision) ? identifiers.revision
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
          action: internalErrorResult().envelope.error.action,
        },
        more: false,
        next: [],
      });
    }
    let savedRejection = null;
    if (io.recoveryJournal && !io.recoveryJournal.receiptSaved) {
      try {
        savedRejection = JSON.parse(text);
        await storeCliResponse(io.recoveryJournal, savedRejection);
        io.recoveryJournal.receiptSaved = true;
      }
      catch (journalError) {
        const envelope = JSON.parse(text);
        envelope.error.identifiers.recovery_journal = io.recoveryJournal.folder;
        envelope.error.identifiers.recovery_save_failed = true;
        envelope.error.action += ` Recovery response storage also failed (${journalError.code ?? "storage_error"}). Preserve ${io.recoveryJournal.folder} and its exact request; inspect the original receipt before replay.`;
        envelope.next = [envelope.error.action]; text = canonicalStringify(envelope);
      }
    }
    if (io.outputFile && !io.outputFile.started) {
      try {
        const outputFile = await persistResponse(io.outputFile, text);
        text = canonicalStringify({ ...JSON.parse(text), data: { output_file: outputFile } });
      } catch (outputError) {
        // Preserve the operation error and expose the separate delivery failure.
        // No replay or second database operation is attempted here.
        const envelope = JSON.parse(text);
        envelope.error.identifiers = { ...envelope.error.identifiers,
          output_path: io.outputFile.path, output_delivery_failed: true,
          output_error_code: typeof outputError?.code === "string" ? outputError.code : "storage_error" };
        envelope.error.action += " Response-file delivery also failed. Preserve the named output and exact request; correct storage/permissions, then reconcile the original operation before retrying.";
        envelope.next = [envelope.error.action];
        text = canonicalStringify(envelope);
      }
    }
    let errorDelivered = false;
    try { await writeChannel(io.stderr, `${text}\n`); errorDelivered = true; }
    catch { /* An unavailable error channel cannot replace the operation failure. */ }
    if (errorDelivered && savedRejection && io.recoveryJournal?.receiptSaved) {
      try { await retireCliJournal(io.recoveryJournal, savedRejection); }
      catch (cleanupError) {
        const warning = canonicalStringify({ code: "recovery_journal_cleanup_failed",
          message: "The rejection was delivered, but its recovery journal could not be retired.",
          identifiers: { journal: io.recoveryJournal.folder, response_delivered: true, committed: false,
            cleanup_error_code: cleanupError.code ?? "storage_error" },
          action: `Preserve '${io.recoveryJournal.folder}' and the recorded response. Correct the reported recovery-storage problem before retrying the exact request; the original rejection remains authoritative.` });
        try { await writeChannel(io.stderr, `Warning: recovery_journal_cleanup_failed ${warning}\n`); }
        catch { /* The original rejection remains the sole operation result. */ }
      }
    }
    return normalized.exitCode;
  } finally {
    try { await outputHandle?.close(); }
    catch { /* Cleanup cannot replace the operation or response-delivery result. */ }
  }
}
