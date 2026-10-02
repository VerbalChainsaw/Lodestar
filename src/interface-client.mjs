import { spawn } from "node:child_process";
import { assertJsonNumericDomain, decodeUtf8 } from "./json.mjs";

const SCRUB = ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID",
  "OPENCODE_SESSION_ID", "CODEX_AGENT_NAME", "LODESTAR_AGENT", "LODESTAR_HARNESS",
  "LODESTAR_DB", "NODE_OPTIONS", "NODE_PATH"];
export function childEnvironment(parent = process.env) {
  const env = { ...parent };
  const removed = new Set(SCRUB);
  for (const key of Object.keys(env)) if (removed.has(key.toUpperCase())) delete env[key];
  return env;
}

function candidate(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) && value.v === 5 &&
    typeof value.ok === "boolean" && value.operation === expected &&
    typeof value.more === "boolean" && Array.isArray(value.next) &&
    (value.revision === null || (Number.isSafeInteger(value.revision) && value.revision >= 0)) &&
    (value.database_instance_id === null || typeof value.database_instance_id === "string") &&
    (value.database_epoch === null || typeof value.database_epoch === "string") &&
    (value.ok ? value.data && typeof value.data === "object" && !Array.isArray(value.data) :
      value.error && typeof value.error.code === "string" && typeof value.error.message === "string");
}
const DIAGNOSTIC_ARGV = new Map([
  ["doctor", ["doctor"]], ["agents.verify", ["agents", "verify"]],
  ["setup", ["setup"]], ["skills.verify", ["skills", "verify"]],
  ["skills.status", ["skills"]],
]);
const DIAGNOSTIC_VALUE_FLAGS = new Set(["--db", "--output", "--source", "--cwd", "--mode",
  "--target", "--home", "--codex-root", "--codex-home", "--claude-home",
  "--xdg-config-home", "--hermes-home", "--opencode-root", "--wsl-shim", "--posix-shim"]);
const DIAGNOSTIC_BOOLEAN_FLAGS = new Set(["--human", "--apply", "--replace-local",
  "--migration-preflight", "--recovery-preflight"]);
function diagnosticExitAllowed(operation, args) {
  const prefix = DIAGNOSTIC_ARGV.get(operation);
  if (!prefix) return false;
  if (args === undefined) return true;
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (DIAGNOSTIC_VALUE_FLAGS.has(token)) {
      if (!args[++index] || args[index].startsWith("--")) return false;
    } else if (DIAGNOSTIC_BOOLEAN_FLAGS.has(token)) continue;
    else if (token.startsWith("--")) return false;
    else positionals.push(token);
  }
  return positionals.length === prefix.length &&
    prefix.every((token, index) => positionals[index] === token);
}
function looksLikeEnvelope(text, parsed) {
  const fields = new Set(["v", "ok", "operation", "error", "data"]);
  if (parsed !== undefined) return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && [...fields].some((key) => Object.hasOwn(parsed, key));
  if (!text.trimStart().startsWith("{")) return false;
  for (const match of text.matchAll(/("(?:\\.|[^"\\])*")\s*:/gu)) {
    try { if (fields.has(JSON.parse(match[1]))) return true; } catch { /* Partial property token. */ }
  }
  return false;
}
function* cliObjectFragments(stream) {
  let lines = [], depth = 0, quoted = false, escaped = false;
  for (const line of stream.split(/\r?\n/u)) {
    if (!lines.length && !line.trimStart().startsWith("{")) continue;
    lines.push(line);
    for (const character of line) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (depth <= 0) {
      yield lines.join("\n").trim();
      lines = []; depth = 0; quoted = false; escaped = false;
    }
  }
  if (lines.length) yield lines.join("\n").trim();
}
function diagnosticSummary(stdout, stderr) {
  const labels = [];
  for (const [stream, value] of [["stdout", stdout], ["stderr", stderr]]) {
    for (const line of value.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || looksLikeEnvelope(trimmed)) continue;
      const warning = /^(?:ExperimentalWarning|DeprecationWarning|Warning):/u.exec(trimmed);
      labels.push(warning ? `${stream}: ${warning[0].slice(0, -1)}` : `${stream}: text omitted`);
      if (labels.length === 8) break;
    }
  }
  return [...new Set(labels)].join("; ");
}
export function parseCliResult({ stdout, stderr, exitCode, elapsedMs, operation, dispatched = true,
  effect = "read", args, overflow = false, timedOut = false, cancelled = false, signal = null }) {
  let diagnostics = "";
  const transport = (code, message) => ({ kind: "TransportError", code,
    message: `${message} ${dispatched && effect !== "read"
      ? "The write outcome is unknown. Inspect the saved request in Recovery and replay only that exact request after checking the configured Node, CLI, database and arguments."
      : "Check the configured Node, CLI, database and arguments before retrying."}`,
    exitCode, diagnostics, elapsedMs, mayHaveCommitted: dispatched && effect !== "read" });
  if (overflow || timedOut || cancelled) {
    // Interruption can end in the middle of a UTF-8 sequence. These bytes are
    // diagnostic-only; their decoding cannot override the incomplete outcome.
    diagnostics = diagnosticSummary(typeof stdout === "string" ? stdout : Buffer.from(stdout).toString("utf8"),
      typeof stderr === "string" ? stderr : Buffer.from(stderr).toString("utf8"));
    if (overflow) return transport("output_limit", "CLI response exceeded the configured output budget.");
    if (timedOut) return transport("timeout", "CLI response deadline expired.");
    return transport("cancelled", "CLI response was cancelled before a complete response was received.");
  }
  try {
    stdout = typeof stdout === "string" ? stdout : decodeUtf8(stdout, { resource: "cli_stdout" });
    stderr = typeof stderr === "string" ? stderr : decodeUtf8(stderr, { resource: "cli_stderr" });
  } catch (error) {
    const resource = ["cli_stdout", "cli_stderr"].includes(error.identifiers?.resource)
      ? error.identifiers.resource : "cli_response";
    diagnostics = `${resource}: invalid UTF-8`;
    return { ...transport("invalid_utf8", `${resource} returned invalid UTF-8 bytes; preserve the original response and saved request.`),
      identifiers: { resource } };
  }
  diagnostics = diagnosticSummary(stdout, stderr);
  const results = [];
  let malformed = false;
  for (const stream of [stdout, stderr]) {
    for (const value of cliObjectFragments(stream)) {
      try {
        const parsed = JSON.parse(value);
        if (!looksLikeEnvelope(value, parsed)) continue;
        try { assertJsonNumericDomain(value); }
        catch { malformed = true; continue; }
        results.push(parsed);
      } catch { if (looksLikeEnvelope(value)) malformed = true; }
    }
  }
  if (malformed) return transport("invalid_envelope", "CLI returned malformed envelope-looking output.");
  if (results.length === 0) return transport("missing_envelope", "CLI returned no contract-5 envelope.");
  if (results.some((entry) => !candidate(entry, operation))) {
    return transport("invalid_envelope", "CLI envelope version, shape, or operation mismatched the request.");
  }
  if (results.length !== 1) return transport("multiple_envelopes", "CLI returned repeated or conflicting envelopes.");
  if (results[0].ok && !(exitCode === 0 ||
    (exitCode === 4 && diagnosticExitAllowed(operation, args)))) {
    return transport("inconsistent_exit", "CLI reported success with an unsupported exit code.");
  }
  if (!results[0].ok && exitCode === 0)
    return transport("inconsistent_exit", "CLI reported an error with a successful process exit code.");
  if (!results[0].ok && (signal || !Number.isInteger(exitCode) || exitCode < 1 || exitCode > 5 ||
    (exitCode === 1 && dispatched && effect !== "read"))) {
    return { ...transport("inconsistent_exit", "CLI rejection was accompanied by signal termination, an unsupported exit, or an unclassified process failure; it cannot settle this write outcome."),
      envelope: results[0] };
  }
  const error = results[0].error;
  const identifiers = error?.identifiers;
  const committed = identifiers && typeof identifiers === "object" && !Array.isArray(identifiers)
    ? identifiers.committed : undefined;
  if (!results[0].ok && dispatched && effect !== "read" &&
    (error.code === "response_delivery_failed" || error.code === "database_commit_outcome_unknown" ||
      committed === "unknown" || committed === true)) {
    return { ...transport(error.code, `${error.message}${typeof error.action === "string" ? ` Action: ${error.action}` : ""}`),
      envelope: results[0] };
  }
  return { kind: results[0].ok ? "EnvelopeSuccess" : "EnvelopeError",
    envelope: results[0], exitCode, diagnostics, elapsedMs };
}

export async function executeCli(selection, { operation, args, effect = "read",
  timeoutMs = 30000, maxOutputBytes = 64 * 1024 * 1024, signal } = {}) {
  return executeProcess({ command: selection.node,
    argv: [selection.cli, "--db", selection.database, ...(args ?? [])],
    env: childEnvironment() }, { operation, args, effect, timeoutMs, maxOutputBytes, signal });
}

// Callers own launch/binding selection; this owner handles one bounded process
// and the shared two-channel response contract without shell interpretation.
export async function executeProcess({ command, argv, env, cwd, input = null }, {
  operation, args, effect = "read", timeoutMs = 30000,
  maxOutputBytes = 64 * 1024 * 1024, signal } = {}) {
  if (typeof operation !== "string" || !operation || !Array.isArray(args) ||
    args.some((value) => typeof value !== "string" || value.includes("\0")) ||
    typeof command !== "string" || !command || command.includes("\0") || !Array.isArray(argv) ||
    argv.some((value) => typeof value !== "string" || value.includes("\0")) ||
    (input !== null && typeof input !== "string") ||
    !["read", "record_write", "domain_write", "external_write"].includes(effect)) {
    throw new TypeError("CLI invocation requires an operation, exact string arguments, and a known effect.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("CLI deadline and output budget must be positive bounded integers.");
  }
  const started = performance.now();
  if (signal?.aborted) return { kind: "TransportError", code: "cancelled",
    message: "The CLI operation was cancelled before dispatch. No write was dispatched; resume the intended action only after clearing cancellation.",
    exitCode: null, diagnostics: "", elapsedMs: performance.now() - started, mayHaveCommitted: false };
  return new Promise((resolve) => {
    let child, outputBytes = 0, overflow = false, timedOut = false, cancelled = false, dispatched = false, inputFailed = false;
    const stdoutChunks = [], stderrChunks = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const incomplete = () => {
      if (settled) return;
      // The direct process may have exited while a descendant holds our pipes.
      // Close only this invocation's readers; buffered envelopes are incomplete.
      child?.kill();
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      finish(parseCliResult({ stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks),
        exitCode: child?.exitCode ?? null, elapsedMs: performance.now() - started,
        operation, args, effect, dispatched, overflow, timedOut, cancelled }));
    };
    const abort = () => { cancelled = true; incomplete(); };
    const timer = setTimeout(() => { timedOut = true; incomplete(); }, timeoutMs);
    try {
      child = spawn(command, argv, { shell: false, windowsHide: true,
        env, cwd, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
      dispatched = Number.isInteger(child.pid);
    } catch {
      finish({ kind: "TransportError", code: "spawn_failed",
        message: "The configured Node executable could not start. Check the selected Node, CLI, database and arguments before retrying.",
        exitCode: null, diagnostics: "", elapsedMs: performance.now() - started,
        mayHaveCommitted: false });
      return;
    }
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const collect = (name, chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        overflow = true; incomplete(); return;
      }
      if (name === "stdout") stdoutChunks.push(chunk);
      else stderrChunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", () => finish({ kind: "TransportError", code: "spawn_failed",
      message: dispatched && effect !== "read"
        ? "The configured CLI process failed after dispatch. The write outcome is unknown. Inspect the saved request in Recovery and replay only that exact request after checking the selected Node, CLI, database and arguments."
        : "The configured Node executable could not start. Check the selected Node, CLI, database and arguments before retrying.",
      exitCode: null,
      diagnostics: diagnosticSummary("", Buffer.concat(stderrChunks).toString("utf8")),
      elapsedMs: performance.now() - started, mayHaveCommitted: dispatched && effect !== "read" }));
    child.on("close", (exitCode, signal) => { if (settled) return; const result = parseCliResult({
      stdout: Buffer.concat(stdoutChunks),
      stderr: Buffer.concat(stderrChunks), exitCode, signal,
      elapsedMs: performance.now() - started, operation, args, effect, dispatched, overflow, timedOut, cancelled });
      if (inputFailed && result.kind === "TransportError") {
        result.message = `CLI stdin delivery failed; a complete response could not confirm the operation. ${result.message}`;
      }
      finish(result);
    });
    if (input !== null) {
      // EPIPE can accompany a complete core rejection. Drain the bounded response
      // before classifying it; an absent/invalid response retains uncertainty.
      child.stdin.on("error", () => { inputFailed = true; });
      try { child.stdin.end(input); }
      catch {
        inputFailed = true;
        // Ending a valid string normally reports EPIPE asynchronously. A
        // synchronous stream failure still belongs to this dispatched process.
        child.kill(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        finish({ kind: "TransportError", code: "stdin_failed", exitCode: child.exitCode,
          message: `CLI stdin delivery failed after dispatch. ${effect !== "read"
            ? "The write outcome is unknown; preserve and replay only the exact request after reconciliation."
            : "Inspect the selected executable and input transport before retrying the read."}`,
          diagnostics: "", elapsedMs: performance.now() - started, mayHaveCommitted: dispatched && effect !== "read" });
      }
    }
  });
}

function parseFindTokens(tokens) {
  if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== "string")) return null;
  const parsed = { query: null, all: false, history: false, scope: null, kind: null,
    limit: null, offset: null, atRevision: null };
  const values = { "--scope": "scope", "--kind": "kind", "--limit": "limit",
    "--offset": "offset", "--at-revision": "atRevision" };
  let positionalOnly = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!positionalOnly && token === "--") { positionalOnly = true; continue; }
    if (!positionalOnly && (token === "--all" || token === "--history")) {
      const field = token === "--all" ? "all" : "history";
      if (parsed[field]) return null;
      parsed[field] = true; continue;
    }
    if (!positionalOnly && Object.hasOwn(values, token)) {
      const field = values[token], value = tokens[++index];
      if (parsed[field] !== null || !value || value.startsWith("--")) return null;
      parsed[field] = value; continue;
    }
    if (!positionalOnly && token.startsWith("--")) return null;
    if (parsed.query !== null || !token) return null;
    parsed.query = token;
  }
  if (parsed.all === (parsed.query !== null)) return null;
  for (const field of ["limit", "offset", "atRevision"]) if (parsed[field] !== null &&
    (!/^\d+$/u.test(parsed[field]) || !Number.isSafeInteger(Number(parsed[field])))) return null;
  return parsed;
}
export function validContinuation(entry, { args, operation, revision }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.command !== operation ||
    operation !== "find") return false;
  const before = parseFindTokens(args), after = parseFindTokens(entry.args);
  if (!before || !after) return false;
  if (["query", "all", "history", "scope", "kind", "limit"].some((field) =>
    before[field] !== after[field])) return false;
  if (after.atRevision !== String(revision) ||
    (before.atRevision !== null && before.atRevision !== after.atRevision)) return false;
  return after.offset !== null && Number(after.offset) > Number(before.offset ?? 0);
}

export function buildReadArgs(descriptor, values = {}) {
  if (descriptor?.effect !== "read" || !Array.isArray(descriptor.argv) ||
    descriptor.argv.some((token) => typeof token !== "string" || !token || token.startsWith("--")) ||
    !Array.isArray(descriptor.parameters) || !descriptor.context ||
    Object.keys(descriptor.context).some((key) => !["project", "actor"].includes(key)) ||
    descriptor.context.actor ||
    !Array.isArray(descriptor.constraints)) throw new Error("Operation is descriptive-only.");
  const transportFlags = new Set(["--db", "--output", "--args-file", "--args-stdin",
    "--human", "--help", "--version", "--file", "--interface-config",
    "--session", "--agent", "--harness"]);
  if (descriptor.parameters.some((param) => !param || typeof param.name !== "string" ||
    !param.schema || !["positional", "option", "flag"].includes(param.binding) ||
    (param.binding !== "positional" &&
      (typeof param.flag !== "string" || !/^--[a-z][a-z0-9-]*$/u.test(param.flag) ||
        transportFlags.has(param.flag))))) {
    throw new Error("Operation is descriptive-only: unsupported or transport binding.");
  }
  if (descriptor.context.project && !values.cwd) throw new Error("A selected project root is required.");
  const options = [], positionals = [];
  const names = new Set(descriptor.parameters.map((param) => param.name));
  if (Object.keys(values).some((key) => !names.has(key))) throw new Error("Unknown read parameter.");
  for (const param of descriptor.parameters) {
    const value = values[param.name];
    if (value === undefined || value === false || value === "") {
      if (param.required) throw new Error(`Missing ${param.name}.`);
      continue;
    }
    const schema = param.schema;
    if (!schema || !["positional", "option", "flag"].includes(param.binding)) throw new Error("Unsupported binding.");
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${param.name}.`);
    if (schema.type === "boolean") {
      if (value !== true || param.binding !== "flag") throw new Error(`Invalid ${param.name}.`);
    } else if (schema.type === "integer") {
      if (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0) ||
        value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) throw new Error(`Invalid ${param.name}.`);
    } else if (schema.type === "string" || schema.enum) {
      if (typeof value !== "string" || value.length < (schema.minLength ?? 0)) throw new Error(`Invalid ${param.name}.`);
    } else throw new Error("Unsupported scalar schema.");
    if (param.binding === "option" && typeof value === "string" &&
      (value.startsWith("--") || value === "-h" || value === "-v")) {
      throw new Error(`Read option value ${param.name} cannot be a global option.`);
    }
    if (param.binding === "positional") {
      if (!Number.isInteger(param.index) || param.index < 0 || positionals[param.index] !== undefined) {
        throw new Error("Unsupported positional binding.");
      }
      positionals[param.index] = value;
    } else {
      if (typeof param.flag !== "string" || !param.flag.startsWith("--")) throw new Error("Unsupported option binding.");
      options.push(param.flag);
      if (param.binding === "option") options.push(String(value));
    }
  }
  for (let index = 0; index < positionals.length; index += 1) {
    if (positionals[index] === undefined) throw new Error("Positional gap is unsupported.");
  }
  for (const constraint of descriptor.constraints) {
    if (!["exactly_one", "at_most_one"].includes(constraint.kind) ||
      !Array.isArray(constraint.parameters) || constraint.parameters.some((name) => !names.has(name))) {
      throw new Error("Unsupported cross-field constraint.");
    }
    const count = constraint.parameters.filter((name) => values[name] !== undefined &&
      values[name] !== false && values[name] !== "").length;
    if (constraint.kind === "exactly_one" ? count !== 1 : count > 1) throw new Error("Read constraint failed.");
  }
  return [...descriptor.argv, ...options,
    ...(positionals.some((value) => String(value).startsWith("-")) ? ["--"] : []),
    ...positionals.map(String)];
}

export async function loadFindPages(selection, args, { execute = executeCli, maxRecords = 10000, maxPages = 128 } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new TypeError("Find record and page budgets must be positive safe integers.");
  }
  let current = [...args], revision = null, instance = null, epoch = null;
  let pages = 0;
  const records = [], recordErrors = [], advisories = [];
  const seen = new Set();
  while (records.length < maxRecords && pages < maxPages) {
    const result = await execute(selection, { operation: "find", args: ["find", ...current] });
    pages += 1;
    if (result.kind !== "EnvelopeSuccess") return { ...result, records, complete: false,
      recordErrors, advisories };
    const envelope = result.envelope;
    if (revision === null) {
      revision = envelope.revision;
      instance = envelope.database_instance_id;
      epoch = envelope.database_epoch;
    } else if (envelope.revision !== revision || envelope.database_instance_id !== instance ||
      envelope.database_epoch !== epoch) return { kind: "TransportError", code: "mixed_snapshot",
      message: "Database changed between pages.", records, complete: false, recordErrors, advisories };
    if (!Number.isSafeInteger(envelope.revision) || !envelope.database_instance_id ||
      !envelope.database_epoch || !Array.isArray(envelope.data?.records) ||
      !Array.isArray(envelope.data.record_errors)) return { kind: "TransportError", code: "invalid_envelope",
      message: "Find response lacks database identity, records, or error coverage.",
      records, complete: false, recordErrors, advisories };
    recordErrors.push(...envelope.data.record_errors);
    advisories.push(...(envelope.next ?? []).filter((entry) => typeof entry === "string"));
    let truncated = false;
    for (const [index, record] of envelope.data.records.entries()) {
      if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.id !== "string" || !record.id) {
        return { kind: "TransportError", code: "invalid_envelope",
          message: `Find record at page ${pages}, index ${index} lacks a nonempty string ID. Inspect the configured CLI and read the affected page again; earlier coverage remains partial.`,
          records, complete: false, recordErrors, advisories };
      }
      if (seen.has(record.id)) return { kind: "TransportError", code: "repeated_record",
        message: "Find repeated a record across pages.", records, complete: false, recordErrors, advisories };
      seen.add(record.id);
      if (records.length < maxRecords) records.push(record);
      else truncated = true;
    }
    if (truncated) break;
    const more = Boolean(envelope.more || envelope.data.more || envelope.data.complete === false);
    if (!more) return { kind: "ReadSnapshot", records, revision, database_instance_id: instance,
      database_epoch: epoch, readAt: new Date().toISOString(), complete: recordErrors.length === 0,
      recordErrors, advisories };
    const next = (envelope.next ?? []).find((entry) => validContinuation(entry,
      { args: current, operation: "find", revision }));
    if (!next) return { kind: "ReadSnapshot", records, revision, database_instance_id: instance,
      database_epoch: epoch, readAt: new Date().toISOString(), complete: false,
      recordErrors, advisories: [...advisories, "No valid continuation was returned."] };
    current = next.args;
  }
  return { kind: "ReadSnapshot", records, revision, database_instance_id: instance,
    database_epoch: epoch, readAt: new Date().toISOString(), complete: false,
    continuation: { command: "find", args: [...current] },
    recordErrors, advisories: [...advisories,
      pages >= maxPages ? `Stopped at client page limit of ${maxPages} pages.` : `Stopped at client limit of ${maxRecords} records.`,
      `Read remaining data with the configured CLI argument array ${JSON.stringify(["find", ...current])}.`] };
}
