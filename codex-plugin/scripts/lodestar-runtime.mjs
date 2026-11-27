import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityOperations, COMMANDS, HOST_OPTIONS, PATH_OPTIONS } from "../../src/cli-commands.mjs";
import { executeProcess } from "../../src/interface-client.mjs";
import { assertTextBytes, canonicalStringify, JSON_INPUT_MAXIMUM_BYTES, parseJsonText } from "../../src/json.mjs";

const PACKAGE_ENTRY = fileURLToPath(new URL("../../lodestar.mjs", import.meta.url));
const WINDOWS_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\)/u;
const WSL_UNC = /^(?:\\\\wsl(?:\.localhost|\$)\\|\/\/wsl(?:\.localhost|\$)\/)/iu;
const stripTerminalNewline = (value) => value.replace(/\r?\n$/u, "");

function isWsl(env) {
  return process.platform === "linux" && Boolean(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());
}

export function resolveLaunch(env = process.env) {
  if (env.LODESTAR_NODE && env.LODESTAR_ENTRY) {
    return { command: env.LODESTAR_NODE, args: [env.LODESTAR_ENTRY] };
  }
  if (isWsl(env)) return { command: env.LODESTAR_COMMAND || "lodestar", args: [], wsl: true };
  if (existsSync(PACKAGE_ENTRY)) return { command: process.execPath, args: [PACKAGE_ENTRY] };
  return { command: env.LODESTAR_COMMAND || "lodestar", args: [] };
}

function wslWindowsPath(value, env) {
  if (WINDOWS_PATH.test(value)) return value;
  const source = path.posix.isAbsolute(value) ? value : path.resolve(value);
  const result = spawnSync("wslpath", ["-w", source], {
    encoding: "utf8", env, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `wslpath could not convert ${value}.`);
  return stripTerminalNewline(result.stdout);
}

function resolvedWslLauncher(command, env) {
  if (command.includes("/")) return path.resolve(command);
  for (const entry of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.resolve(entry || process.cwd(), command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error(`The selected WSL Lodestar launcher is unavailable: ${command}.`);
}

function rejectLinuxDatabase(option, value) {
  if ((option === "--db" || option === "--source") && WSL_UNC.test(value)) {
    throw new Error("SQLite must remain on a Windows filesystem; use a Windows drive or /mnt/<drive> path.");
  }
}

function normalizeWslReadArguments(args, launch, env) {
  const normalized = [...args];
  const flags = new Map();
  let optionEnd = normalized.length;
  for (let index = 0; index < normalized.length; index += 1) {
    const option = normalized[index];
    if (option === "--") { optionEnd = index; break; }
    if (!PATH_OPTIONS.includes(option)) continue;
    if (index + 1 >= normalized.length || normalized[index + 1].startsWith("--")) {
      throw new Error(`${option} requires a path.`);
    }
    const converted = wslWindowsPath(normalized[index + 1], env);
    rejectLinuxDatabase(option, converted);
    normalized[index + 1] = converted;
    flags.set(option, converted);
    index += 1;
  }

  const command = normalized[0];
  const defaults = [];
  const addPath = (option, value) => {
    const converted = wslWindowsPath(value, env);
    rejectLinuxDatabase(option, converted);
    defaults.push(option, converted);
  };
  if (COMMANDS[command]?.values.includes("--cwd") && !flags.has("--cwd")) {
    addPath("--cwd", process.cwd());
  }
  const hostCommand = command === "start" || command === "skills" || command === "setup";
  if ((command === "start" || command === "setup")
      && !flags.has("--home") && !flags.has("--wsl-shim") && !flags.has("--posix-shim")) {
    addPath("--wsl-shim", resolvedWslLauncher(launch.command, env));
  }
  if (hostCommand) {
    const explicitHome = flags.get("--home");
    const home = explicitHome ?? env.HOME;
    if (!home) throw new Error("HOME is required for WSL Lodestar host operations.");
    if (!explicitHome) addPath("--home", home);
    if (!flags.has("--hermes-home")) {
      defaults.push("--hermes-home", explicitHome
        ? path.win32.join(explicitHome, ".hermes")
        : wslWindowsPath(env.HERMES_HOME?.trim() || path.posix.join(home, ".hermes"), env));
    }
    if (!explicitHome) {
      const environmentHomes = {
        "--codex-home": env.CODEX_HOME,
        "--claude-home": env.CLAUDE_CONFIG_DIR,
        "--xdg-config-home": env.XDG_CONFIG_HOME,
        "--opencode-root": env.OPENCODE_CONFIG_DIR
          ? path.posix.join(env.OPENCODE_CONFIG_DIR, "skills") : undefined,
      };
      for (const option of Object.keys(HOST_OPTIONS)) {
        if (!flags.has(option) && environmentHomes[option]?.trim()) addPath(option, environmentHomes[option]);
      }
    }
  }
  normalized.splice(optionEnd, 0, ...defaults);
  return { arguments: normalized, database: flags.get("--db") };
}

export function packageVersion() {
  try {
    const manifest = fileURLToPath(new URL("../../package.json", import.meta.url));
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
}

const operations = capabilityOperations({});
function invocationDescriptor(args) {
  const valueFlags = new Set(["--db", ...Object.values(COMMANDS).flatMap(command => command.values)]);
  let index = 0;
  while (index < args.length && args[index].startsWith("--")) {
    const flag = args[index++];
    if (valueFlags.has(flag)) index += 1;
  }
  return operations.find(descriptor => descriptor.argv.every((token, offset) => args[index + offset] === token));
}

function requestReceiptId(request) {
  const basis = request?.write_basis ?? request;
  if (!basis || typeof request.request_id !== "string" || typeof basis.database_instance_id !== "string"
    || typeof basis.database_epoch !== "string") return null;
  return `mutation-receipt:${createHash("sha256").update(canonicalStringify([
    basis.database_instance_id, basis.database_epoch, request.request_id,
  ])).digest("hex")}`;
}

function toolFailure(operation, effect, result, requestId, request) {
  const writeOutcome = effect === "read" ? "not_applicable" : result.mayHaveCommitted
    ? "unknown" : result.kind === "EnvelopeError" ? "rejected" : "not_dispatched";
  const coreError = result.envelope?.error;
  const action = writeOutcome === "unknown"
    ? `${coreError?.action ? `${coreError.action} ` : ""}Retain the complete original lodestar_mutate request, including request_id and write_basis. Inspect current records and the receipt using lodestar_read; use lodestar_describe for supported arguments. Replay only the identical operation and exact original request; never prepare a new request until this outcome is reconciled.`
    : coreError?.action ?? "Check the selected Lodestar executable, database, paths and arguments using lodestar_describe and public reads; correct the reported failure before retrying.";
  const value = { ...result.envelope, ok: false, operation, write_outcome: writeOutcome,
    ...(typeof requestId === "string" ? { request_id: requestId } : {}),
    error: { code: result.code ?? coreError?.code,
      message: result.message ?? coreError?.message, action,
      ...(result.code && coreError?.code && result.code !== coreError.code ? { reported_code: coreError.code } : {}),
      ...(coreError?.identifiers ? { identifiers: coreError.identifiers } : {}) } };
  const receipt = requestReceiptId(request);
  if (writeOutcome === "unknown" && receipt) value.recovery_reads = [
    { tool: "lodestar_read", arguments: { operation: "get", arguments: [receipt] } },
  ];
  const error = new Error(`${value.error.message} Write outcome: ${writeOutcome}. Action: ${action}`);
  error.toolResult = value;
  if (result.envelope) error.envelope = result.envelope;
  return error;
}

function mutationTargetMatches(operation, data, input) {
  if (!input || typeof input !== "object" || !data || typeof data !== "object" || Array.isArray(data)) return false;
  const recordMatches = (result, id) => typeof id === "string" && result?.record?.id === id;
  if (operation === "put") return typeof (input.mode === "update" ? input.id : input.record?.id) === "string"
    && data.id === (input.mode === "update" ? input.id : input.record?.id);
  if (operation === "delete") return data.id === input.id && typeof input.id === "string"
    && data.retired === true && data.reason === input.reason
    && (data.changed === undefined || typeof data.changed === "boolean");
  if (operation.startsWith("decision.")) {
    const key = operation === "decision.inject" ? "lodestar:agent-decision-presentation" : input.key;
    return typeof key === "string" && typeof data.changed === "boolean"
      && (data.changed ? data.record?.data?.key : data.current?.key) === key;
  }
  if (operation === "work.expire") {
    if (!Array.isArray(input.targets) || !Array.isArray(data.results) || data.results.length !== input.targets.length) return false;
    const ids = new Set(input.targets);
    for (const result of data.results) {
      if (typeof result?.changed !== "boolean" || !ids.delete(result.record?.id)) return false;
    }
    return ids.size === 0;
  }
  if (operation.startsWith("work.") || operation.startsWith("handoff.")) {
    return typeof data.changed === "boolean" && recordMatches(data, input.id);
  }
  if (operation.startsWith("pending.")) {
    if (!recordMatches(data, input.id) || (operation === "pending.add" ? data.added !== true : data.settled !== true)) return false;
    if (operation !== "pending.promote") return true;
    const destination = input.destination;
    return destination && mutationTargetMatches(destination.operation, data.promoted, destination.input);
  }
  return false;
}

function confirmedMutation(envelope, request, operation) {
  const basis = request?.write_basis ?? request;
  if (!basis || typeof request.request_id !== "string" || typeof basis.database_instance_id !== "string"
    || typeof basis.database_epoch !== "string") return false;
  const receiptId = requestReceiptId(request);
  return envelope.more === false && envelope.database_instance_id === basis.database_instance_id && envelope.database_epoch === basis.database_epoch
    && envelope.request?.id === request.request_id && typeof envelope.request.replayed === "boolean"
    && Number.isSafeInteger(envelope.request.committed_revision) && envelope.request.committed_revision > 0
    && envelope.revision === envelope.request.committed_revision && envelope.receipt_id === receiptId
    && mutationTargetMatches(operation, envelope.data, request.input);
}

function consistentMutationError(envelope, request) {
  const basis = request?.write_basis ?? request;
  if (!basis) return true;
  const identifiers = envelope.error?.identifiers;
  for (const [value, expected] of [[envelope.request?.id, request.request_id],
    [identifiers?.request_id, request.request_id], [envelope.receipt_id, requestReceiptId(request)],
    [identifiers?.receipt_id, requestReceiptId(request)]]) {
    if (value != null && expected != null && value !== expected) return false;
  }
  const instanceConflict = envelope.error?.code === "database_instance_conflict"
    && identifiers?.expected === basis.database_instance_id && identifiers?.actual === envelope.database_instance_id;
  const epochConflict = envelope.error?.code === "database_epoch_conflict"
    && identifiers?.expected === basis.database_epoch && identifiers?.actual === envelope.database_epoch;
  for (const field of ["database_instance_id", "database_epoch"]) {
    for (const value of [envelope[field], identifiers?.[field]]) {
      if (value == null || basis[field] == null || value === basis[field]) continue;
      // A named admission conflict reports the inspected current store, which
      // can legitimately differ from the stale request's instance and epoch.
      if (!(value === envelope[field] && (instanceConflict || (field === "database_epoch" && epochConflict)))) return false;
    }
  }
  return true;
}

export async function runInstalledLodestar(args, { input = "", env = process.env, operation, effect,
  requestId, timeoutMs = 30000, maxOutputBytes = 64 * 1024 * 1024, signal } = {}) {
  let launch, stdin, childEnvironment, commandArgs, readArguments, mutationRequest;
  try {
    if (!Array.isArray(args) || args.some(value => typeof value !== "string" || value.includes("\0"))) {
      throw new TypeError("Lodestar requires exact string arguments without NUL bytes.");
    }
    const descriptor = invocationDescriptor(args);
    operation ??= descriptor?.id;
    effect ??= descriptor?.effect;
    if (!operation || !["read", "record_write", "domain_write", "external_write"].includes(effect)) {
      throw new TypeError("Select a supported one-shot operation with lodestar_describe before invoking it.");
    }
    launch = resolveLaunch(env);
    // Read arguments can exceed CreateProcess's command line. Pass the existing
    // command array through complete stdin; mutations already use stdin for their
    // guarded body and have only short fixed command selectors in argv.
    const wslRead = input === "" && launch.wsl
      ? normalizeWslReadArguments(args, launch, env) : null;
    readArguments = wslRead?.arguments ?? args;
    commandArgs = input === "" ? ["--args-stdin"] : args;
    stdin = input === "" ? canonicalStringify(readArguments) : input;
    assertTextBytes(stdin, JSON_INPUT_MAXIMUM_BYTES, input === "" ? "command_arguments" : "mutation_request");
    if (input !== "") {
      mutationRequest = parseJsonText(input, { maximum: JSON_INPUT_MAXIMUM_BYTES, resource: "mutation_request" });
      requestId = mutationRequest?.request_id;
    }
    childEnvironment = wslRead?.database === undefined ? env
      : { ...env, LODESTAR_DB: wslRead.database };
  } catch (error) {
    throw toolFailure(operation, effect ?? "read", { code: error.code ?? "adapter_input",
      message: `${error.message} No write was dispatched.`, mayHaveCommitted: false,
      ...(error.action ? { envelope: { error: { code: error.code ?? "adapter_input",
        message: `${error.message} No write was dispatched.`, action: error.action, identifiers: error.identifiers } } } : {}) }, requestId);
  }
  let result;
  try {
    result = await executeProcess({ command: launch.command, argv: [...launch.args, ...commandArgs],
      cwd: process.cwd(), env: childEnvironment, input: stdin },
    { operation, args: readArguments, effect, timeoutMs, maxOutputBytes, signal });
  } catch (error) {
    throw toolFailure(operation, effect, { code: "adapter_input", message: `${error.message} No write was dispatched.`,
      mayHaveCommitted: false }, requestId);
  }
  if (["record_write", "domain_write"].includes(effect) && result.envelope?.ok === false
    && !consistentMutationError(result.envelope, mutationRequest)) {
    throw toolFailure(operation, effect, { ...result, code: "invalid_confirmation", mayHaveCommitted: true,
      message: "Lodestar error identifiers contradict this dispatched request or store; the rejection cannot settle its outcome." }, requestId, mutationRequest);
  }
  if (result.kind !== "EnvelopeSuccess") throw toolFailure(operation, effect, result, requestId, mutationRequest);
  if (["record_write", "domain_write"].includes(effect) && !confirmedMutation(result.envelope, mutationRequest, operation)) {
    throw toolFailure(operation, effect, { code: "invalid_confirmation", mayHaveCommitted: true,
      message: "Lodestar returned success without a complete matching request, receipt, store and committed revision." }, requestId, mutationRequest);
  }
  return result.envelope;
}

export function mutationCommand(operation, request = {}) {
  const [family, subcommand] = operation.split(".");
  const checkout = request.write_basis?.checkout ?? request.checkout;
  return subcommand ? [family, subcommand,
    ...(typeof checkout === "string" ? ["--cwd", checkout] : [])] : [family];
}
