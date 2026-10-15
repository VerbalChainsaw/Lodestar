import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertJsonValue } from "./lodestar-json.mjs";

export const HANDOFF_COMMANDS = Object.freeze([
  "arm", "status", "checkpoint", "now", "disarm",
]);
// Advisory presence carries no user intent and cannot destroy state, so it needs no
// spoken authorization the way a baton does. What it does need is the exact session,
// which only the host knows: the same attestation that binds session, turn and cwd for
// continuity gives work an identity no shell fallback can guess or collide with.
export const WORK_COMMANDS = Object.freeze(["start", "done", "status"]);
// Continuity commands that only read. They still carry an attestation binding session,
// turn and cwd; they simply do not require the user to have said the phrase first.
const READ_ONLY_COMMANDS = new Set(["status"]);
const AUTH_TTL_MS = 10 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 20_000;
export const STARTUP_CONTEXT_PREFIX =
  "Lodestar startup context (v1; incomplete without the closing marker):\n";
export const STARTUP_CONTEXT_SUFFIX =
  "\nLodestar startup context complete. If this marker is missing, stop before mutation.";
export const HANDOFF_ENTRY_KEY_PATTERN = "^[a-z0-9][a-z0-9.-]*$";
export const HANDOFF_PACKET_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: true,
  required: ["goal", "rules", "entries", "work", "nextMove", "evidence"],
  properties: {
    goal: { type: "string", minLength: 1 },
    rules: { type: "array", maxItems: 10,
      items: { type: "string", minLength: 1 } },
    entries: { type: "array", maxItems: 35, items: {
      type: "object",
      additionalProperties: true,
      required: ["key", "state", "text", "scope", "provenance", "generation"],
      properties: {
        key: { type: "string", pattern: HANDOFF_ENTRY_KEY_PATTERN,
          description: "Lowercase letters, digits, dots, and hyphens only." },
        state: { type: "string", enum: ["fact", "trap", "ask", "unsure", "dead"] },
        text: { type: "string", minLength: 1 },
        scope: { type: "array", maxItems: 10, items: { type: "string" } },
        provenance: { type: "object", additionalProperties: true,
          required: ["kind", "sourceRef", "observedAt"], properties: {
            kind: { type: "string", enum: ["user", "tool", "repo", "agent", "decision"] },
            sourceRef: { type: "string", minLength: 1 },
            observedAt: { type: "string", minLength: 1 },
          } },
        generation: { type: "integer", minimum: 0 },
      },
    } },
    work: { type: "object" },
    nextMove: { type: "string", minLength: 1 },
    evidence: { type: "array", maxItems: 50 },
  },
});
const SECRET_FIELD = /(?:^|[-_])(?:authorization|api[-_]?key|credential|password|secret|token)(?:$|[-_])/iu;
const SECRET_TEXT = [
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,})\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
];
const key = (value) => createHash("sha256").update(String(value)).digest("hex");
const normalized = (value) => Array.isArray(value) ? value.map(normalized)
  : value && Object.getPrototypeOf(value) === Object.prototype
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([field, item]) => [field, normalized(item)]))
    : value;
export const canonical = (value) => {
  assertJsonValue(value);
  return `${JSON.stringify(normalized(value))}\n`;
};
const digest = (value) => key(canonical(value));

function safe(value, label, maximum = 16_384) {
  if (typeof value !== "string" || !value.trim()
      || Buffer.byteLength(value, "utf8") > maximum
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

const paths = (root, session) => ({
  auth: path.join(root, "authorizations", `${key(session)}.json`),
  attest: (token) => path.join(root, "attestations", `${token}.json`),
});

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(canonical(value));
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, file);
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const sanitize = (input) => Object.fromEntries(Object.entries(input ?? {})
  .filter(([field]) => field !== "_attestation"));

// The whole prompt must be the command and nothing else: that anchoring is the security
// property, because it stops a passing mention ("don't handoff now") from authorizing a
// baton write. Decoration that cannot change intent is not part of that property, and
// rejecting it made a working plugin look broken — `$handoff now` and `/handoff now` are
// how agents habitually type commands, and refusal sends them to the raw CLI instead.
export function parseHandoffCommand(prompt) {
  return /^[/$!>]?\s*(?:lodestar\s+)?handoff\s+(arm|status|checkpoint|now|disarm)\s*[.!]?$/iu
    .exec(String(prompt).trim())?.[1]?.toLowerCase() ?? null;
}

// A host may present the same tool as lodestar_x, lodestar__lodestar_x, or
// lodestar/lodestar_x. Binding an attestation to the raw string makes the token valid
// only for the exact spelling the hook happened to see, and a mismatch surfaces as
// "Invalid, expired, mismatched, or replayed host attestation" — an error that says
// nothing about naming. Compare the canonical suffix instead.
export function canonicalToolName(name) {
  return /lodestar_(?:handoff|work)_(?:arm|status|checkpoint|now|disarm|start|done)$/u
    .exec(String(name))?.[0] ?? String(name);
}

function toolCommand(name) {
  // Any non-alphanumeric separator, because hosts namespace tools differently:
  // lodestar_x, lodestar__lodestar_x, and lodestar/lodestar_x are the same tool.
  return /(?:^|[^a-z0-9])lodestar_handoff_(arm|status|checkpoint|now|disarm)$/u
    .exec(String(name))?.[1] ?? null;
}

export function workToolCommand(name) {
  return /(?:^|[^a-z0-9])lodestar_work_(start|done|status)$/u.exec(String(name))?.[1] ?? null;
}

function packetSchema() {
  return "{goal:string,rules:string[],entries:Array<{key:string (entry keys must match "
    + `${HANDOFF_ENTRY_KEY_PATTERN}; lowercase letters, digits, dots, and hyphens only),`
    + "state:'fact'|'trap'|"
    + "'ask'|'unsure'|'dead',text:string,scope:string[],provenance:{kind:'user'|'tool'|"
    + "'repo'|'agent'|'decision',sourceRef:string,observedAt:string},generation:integer}>,"
    + "work:object,nextMove:string,evidence:array}. A dead entry requires evidence "
    + "{key:'dead:<entry-key>',kind:'user'|'decision',sourceRef:<matching provenance>}.";
}

export async function authorizePrompt(input, dataDir, now = Date.now()) {
  assertJsonValue(input);
  for (const field of ["session_id", "turn_id", "cwd"]) safe(input[field], field, 32_768);
  const command = parseHandoffCommand(input.prompt);
  if (!command) return null;
  const record = { command, sessionId: input.session_id, turnId: input.turn_id,
    cwd: input.cwd, expiresAt: now + AUTH_TTL_MS };
  await atomicWrite(paths(dataDir, input.session_id).auth, record);
  const packet = ["arm", "checkpoint", "now"].includes(command)
    ? ` Author the packet argument using ${packetSchema()}` : " Use no packet argument.";
  return { command, additionalContext: `Call the bundled Lodestar tool `
    + `lodestar_handoff_${command} exactly once.${packet}` };
}

export async function attestTool(input, dataDir, now = Date.now()) {
  assertJsonValue(input);
  const work = workToolCommand(input.tool_name);
  if (work) return await attestDirect(input, dataDir, now, work);
  const command = toolCommand(input.tool_name);
  if (!command) return { matched: false };
  // Reading the baton mutates nothing, and a resumed session has no spoken phrase to
  // point at. Gating the read denied the first thing an agent does on resume, so it is
  // attested directly; only the commands that write a lane still need the exact phrase.
  if (READ_ONLY_COMMANDS.has(command)) return await attestDirect(input, dataDir, now, command);
  for (const field of ["session_id", "turn_id", "tool_use_id", "cwd"]) {
    safe(input[field], field, 32_768);
  }
  const file = paths(dataDir, input.session_id).auth;
  let auth;
  try { auth = await readJson(file); }
  catch { return { matched: true, allowed: false,
    reason: "This Lodestar continuity command lacks exact host authorization." }; }
  if (auth.expiresAt < now || auth.command !== command || auth.sessionId !== input.session_id
      || auth.turnId !== input.turn_id || auth.cwd !== input.cwd) {
    return { matched: true, allowed: false,
      reason: "The Lodestar command does not match this session, turn, or cwd." };
  }
  const claimed = `${file}.${input.tool_use_id}.used`;
  try { await rename(file, claimed); }
  catch { return { matched: true, allowed: false,
    reason: "The Lodestar command authorization was already consumed." }; }
  const args = sanitize(input.tool_input), token = randomBytes(32).toString("hex");
  await atomicWrite(paths(dataDir, input.session_id).attest(token), { token, command,
    sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd,
    toolUseId: input.tool_use_id, toolName: canonicalToolName(input.tool_name), argsDigest: digest(args),
    expiresAt: now + AUTH_TTL_MS });
  await unlink(claimed);
  return { matched: true, allowed: true, updatedInput: { ...args, _attestation: token } };
}

async function consume(toolName, rawInput, dataDir, now = Date.now()) {
  assertJsonValue(rawInput);
  const token = rawInput?._attestation;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error("Missing host attestation");
  }
  const file = paths(dataDir, "unused").attest(token);
  const claimed = `${file}.${process.pid}.used`;
  try { await rename(file, claimed); }
  catch { throw new Error("Invalid or replayed host attestation"); }
  try {
    const record = await readJson(claimed), args = sanitize(rawInput);
    // Either family may have issued the token; the command must still match the tool it
    // was minted for, so a work attestation can never be replayed as a continuity one.
    const expected = toolCommand(toolName) ?? workToolCommand(toolName);
    if (record.expiresAt < now || record.token !== token
        || record.toolName !== canonicalToolName(toolName)
        || record.command !== expected || record.argsDigest !== digest(args)) {
      throw new Error("Invalid, expired, mismatched, or replayed host attestation");
    }
    return { host: record, args };
  } finally { await unlink(claimed); }
}

function redact(value, report = { count: 0, categories: new Set() }) {
  if (typeof value === "string") {
    let text = value;
    // The prefix is kept only when the pattern actually captured one, so an assignment
    // stays readable as NAME=[REDACTED]. It must be tested by type: for a pattern with
    // no capture group the second argument is the match offset, and treating that number
    // as a prefix wrote the offset into the output as `9[REDACTED]`.
    for (const pattern of SECRET_TEXT) text = text.replace(pattern, (full, first) => {
      report.count += 1;
      report.categories.add("secret-text");
      return typeof first === "string" ? `${first}[REDACTED]` : "[REDACTED]";
    });
    return { value: text, report };
  }
  if (Array.isArray(value)) return {
    value: value.map((item) => redact(item, report).value), report,
  };
  if (value && Object.getPrototypeOf(value) === Object.prototype) return {
    value: Object.fromEntries(Object.entries(value).map(([field, item]) => {
      if (SECRET_FIELD.test(field) && typeof item === "string") {
        report.count += 1;
        report.categories.add("secret-field");
        return [field, "[REDACTED]"];
      }
      return [field, redact(item, report).value];
    })), report,
  };
  return { value, report };
}

function nodeVersion(name) {
  const parts = /^node-v(\d+)\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/iu.exec(name)?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : null;
}

function newestRuntimeFirst(left, right) {
  const a = nodeVersion(left), b = nodeVersion(right);
  if (a && b) {
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return b[index] - a[index];
    }
  } else if (a || b) return a ? -1 : 1;
  return left < right ? 1 : left > right ? -1 : 0;
}

function regularFile(file) {
  try { return statSync(file).isFile(); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
}

function resolveLaunch(env = process.env) {
  if (env.LODESTAR_NODE && env.LODESTAR_ENTRY) {
    return { command: env.LODESTAR_NODE, args: [env.LODESTAR_ENTRY] };
  }
  if (process.platform !== "win32") {
    const launcher = path.join(env.HOME, ".local", "bin", "lodestar");
    return { command: existsSync(launcher) ? launcher : env.LODESTAR_COMMAND || "lodestar",
      args: [] };
  }
  const root = path.join(env.USERPROFILE || env.HOME, ".local", "opt");
  const versions = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-"))
    .map((entry) => entry.name).sort(newestRuntimeFirst) : [];
  for (const version of versions) {
    const command = path.join(root, version, "node.exe");
    const entry = path.join(root, version, "node_modules", "lodestar-agent-context",
      "lodestar.mjs");
    if (regularFile(command) && regularFile(entry)) return { command, args: [entry] };
  }
  throw new Error("Installed Lodestar runtime not found");
}

export function parseEnvelope(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* Search the final JSON line. */ }
  for (let index = trimmed.length; index > 0;) {
    const start = trimmed.lastIndexOf("\n{", index - 1);
    if (start < 0) return null;
    try { return JSON.parse(trimmed.slice(start + 1)); }
    catch { index = start; }
  }
  return null;
}

async function installed(options = {}) {
  const launch = resolveLaunch(options.env ?? process.env);
  const entry = launch.args[0];
  if (!entry) throw new Error("A discoverable installed Lodestar package entry is required");
  const root = path.dirname(entry);
  const transport = await import(pathToFileURL(path.join(root, "codex-plugin/scripts/lodestar-runtime.mjs")));
  return { ...transport, root, launch };
}
async function runLodestar(args, input = "", options = {}) {
  const runtime = await installed(options);
  // Carry the selected installation into the transport without changing the host environment.
  const env = { ...(options.env ?? process.env),
    LODESTAR_NODE: runtime.launch.command, LODESTAR_ENTRY: runtime.launch.args[0] };
  return runtime.runInstalledLodestar(args, { input, env,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    operation: options.operation, effect: options.effect, signal: options.signal });
}
const identityArgs = (host) => ["--cwd", host.cwd, "--session", host.sessionId,
  "--agent", "codex", "--harness", "codex"];
const hookHost = (input, event) => {
  for (const field of ["session_id", "turn_id", "cwd"]) safe(input[field], field, 32_768);
  return { sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd,
    toolUseId: input.tool_use_id ?? event };
};
export const sessionRecordId = (family, project, host) => 
  `codex-plugin:${family}:${key(canonical([project.scope, project.checkout_root, host.sessionId])).slice(0, 40)}`;
async function context(host, options) {
  const result = await runLodestar(["start", ...identityArgs(host)], "", options);
  if (result.more !== false || result.data?.complete !== true || result.data.required_complete !== true) {
    throw new Error("Full startup context is incomplete; mutation is blocked");
  }
  return result;
}
async function exactRecord(id, host, options, revision) {
  try { return await runLodestar(["get", ...(Number.isSafeInteger(revision) ? ["--at-revision", String(revision)] : []), "--", id], "", options); }
  catch (error) {
    if (error.envelope?.error?.code === "record_not_found") return error.envelope;
    throw error;
  }
}
function verifyOwner(record, family, start, host) {
  if (!record) return;
  const actor = start.scope?.actor;
  if (record.kind !== family || record.scope !== start.data.project.scope
      || record.data?.checkout !== start.data.project.checkout_root
      || (family === "work" ? record.data?.actor !== actor || record.data?.session !== host.sessionId
        : record.data?.source_actor !== actor)) {
    throw new Error("Exact target does not belong to this project, checkout and host session");
  }
}
async function unresolvedRequests(host, dataDir, family) {
  const directory = path.join(dataDir, "requests");
  let files = [];
  try { files = await readdir(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const pending = [];
  for (const name of files.filter((file) => file.endsWith(".json"))) {
    const file = path.join(directory, name), saved = await readJson(file);
    if (["unknown", "prepared"].includes(saved.state)
        && saved.host.sessionId === host.sessionId && saved.host.cwd === host.cwd
        && saved.operation.split(".")[0] === family) pending.push({ file, saved });
  }
  return pending;
}
async function mutateOwned(operation, host, dataDir, buildInput, options = {}, suffix = operation) {
  const requestId = `codex-plugin:${key(canonical([host.sessionId, host.turnId, host.toolUseId, suffix]))}`;
  let journal = path.join(dataDir, "requests", `${key(requestId)}.json`);
  let saved;
  try { saved = await readJson(journal); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!saved) {
    const pending = await unresolvedRequests(host, dataDir, operation.split(".")[0]);
    for (const { file, saved: candidate } of pending) {
      if (candidate.operation !== operation || candidate.suffix !== suffix
          || candidate.host.argsDigest !== host.argsDigest) {
        throw new Error(`An earlier mutation has an unresolved outcome. Reconcile its exact original request before a new write: ${file}`);
      }
    }
    if (pending.length > 1) throw new Error("Multiple unresolved logical requests require explicit reconciliation");
    if (pending.length) {
      saved = pending[0].saved;
      journal = pending[0].file;
      host = saved.host;
    }
  }

  if (saved && (saved.operation !== operation || saved.host.cwd !== host.cwd || saved.host.sessionId !== host.sessionId
      || saved.host.turnId !== host.turnId || saved.host.toolUseId !== host.toolUseId
      || saved.host.argsDigest !== host.argsDigest || saved.suffix !== suffix)) {
    throw new Error("Recovery journal identity mismatch");
  }
  if (!saved) {
    const start = await context(host, options);
    const family = operation.split(".")[0];
    const id = family === "pending" ? `codex-plugin:pending:${key(requestId)}`
      : sessionRecordId(family, start.data.project, host);
    const exact = await exactRecord(id, host, options, start.revision);
    const record = exact.ok ? exact.data : null;
    if (family !== "pending") verifyOwner(record, family, start, host);
    const { combineReadBases } = await import(pathToFileURL(path.join((await installed(options)).root, "src/operator-actions.mjs")));
    const writeBasis = combineReadBases([start, exact, ...(options.basisReads ?? [])]);
    const targetBasis = exact.data?.write_basis ?? exact.error?.identifiers?.write_basis;
    if (targetBasis.project_scope != null && targetBasis.project_scope !== writeBasis.project_scope
        || targetBasis.checkout != null && targetBasis.checkout !== writeBasis.checkout) {
      throw new Error("Exact target write basis project or checkout mismatch");
    }
    const input = buildInput(id, record, start);
    saved = { operation, suffix, host, request: { v: 5, request_id: requestId, write_basis: writeBasis, input }, state: "prepared" };
    await atomicWrite(journal, saved);
  }
  if (saved.state === "confirmed") return saved.result;
  if (saved.state === "rejected") throw new Error("This logical request was rejected; use a new host tool call after correcting the failure");
  const runtime = await installed(options);
  try {
    const result = await runLodestar([...runtime.mutationCommand(operation, saved.request),
      "--session", host.sessionId, "--agent", "codex", "--harness", "codex"],
    canonical(saved.request), { ...options, operation, effect: "domain_write" });
    await atomicWrite(journal, { ...saved, state: "confirmed", result });
    return result;
  } catch (error) {
    await atomicWrite(journal, { ...saved, state: error.toolResult?.write_outcome === "rejected" ? "rejected" : "unknown",
      failure: error.toolResult ?? { message: error.message } });
    error.message += ` Recovery journal: ${journal}. Replay only this exact original request.`;
    throw error;
  }
}
function validatePacket(value, schema = HANDOFF_PACKET_SCHEMA, label = "packet") {
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (schema.type && kind !== schema.type && !(schema.type === "integer" && kind === "number")) throw new Error(`Invalid ${label}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${label}: unsupported value`);
  if (schema.minLength && value.length < schema.minLength) throw new Error(`Invalid ${label}: empty text`);
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) throw new Error(`Invalid ${label}: unsupported entry key`);
  if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity))) throw new Error(`Invalid ${label}: expected integer`);
  if (kind === "array") {
    if (schema.maxItems && value.length > schema.maxItems) throw new Error(`Invalid ${label}: too many items`);
    if (schema.items) value.forEach((item, i) => validatePacket(item, schema.items, `${label}[${i}]`));
  }
  if (kind === "object") {
    for (const field of schema.required ?? []) if (!Object.hasOwn(value, field)) throw new Error(`Invalid ${label}: missing ${field}`);
    for (const [field, rule] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, field)) validatePacket(value[field], rule, `${label}.${field}`);
  }
}
export function checkpointFromPacket(packet) {
  validatePacket(packet);
  const clean = redact(structuredClone(packet)).value;
  return { objective: clean.goal, current_state: clean.nextMove,
    completed_results: [], unresolved_work: [], references: [{ kind: "codex-plugin-packet", version: 1, packet: clean }] };
}

// Issued without a prior spoken authorization, because an agent marking what it is
// working on is not a user decision. The binding to session, turn and cwd is what
// matters, and it is identical to the continuity path.
// Fails closed rather than throwing: a hook that crashes takes the session with it, and
// an unwritable plugin data directory should deny a command, not break the host.
async function attestDirect(input, dataDir, now, command) {
  try {
    return await issueAttestation(input, dataDir, now, command);
  } catch {
    return { matched: true, allowed: false,
      reason: "Lodestar could not record a host attestation for this command." };
  }
}

async function issueAttestation(input, dataDir, now, command) {
  for (const field of ["session_id", "turn_id", "tool_use_id", "cwd"]) {
    safe(input[field], field, 32_768);
  }
  const args = sanitize(input.tool_input), token = randomBytes(32).toString("hex");
  await atomicWrite(paths(dataDir, input.session_id).attest(token), { token, command,
    sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd,
    toolUseId: input.tool_use_id, toolName: canonicalToolName(input.tool_name), argsDigest: digest(args),
    expiresAt: now + AUTH_TTL_MS });
  return { matched: true, allowed: true, updatedInput: { ...args, _attestation: token } };
}

export async function executeWork(toolName, rawInput, dataDir, options = {}) {
  const { host, args } = await consume(toolName, rawInput, dataDir, options.now?.() ?? Date.now());
  const command = workToolCommand(toolName);
  if (command === "status") return { command, result: (await runLodestar(["work", "status", ...identityArgs(host)], "", options)).data };
  const envelope = await mutateOwned(`work.${command}`, host, dataDir, (id, record) => {
    const description = redact(String(args.report ?? record?.data?.description ?? "Work completed")).value.trim();
    if (!description) throw new Error("work requires report text");
    if (command === "start") return { id, description };
    const outcome = args.outcome ?? "completed";
    if (outcome === "verified" && !args.evidence?.length) throw new Error("Verified work requires evidence");
    return { id, description, outcome, action_id: `host:${host.turnId}:${host.toolUseId}`, evidence: redact(args.evidence ?? []).value };
  }, options);
  return { command, result: envelope.data };
}
export async function executeHandoff(toolName, rawInput, dataDir, options = {}) {
  const { host, args } = await consume(toolName, rawInput, dataDir, options.now?.() ?? Date.now());
  const command = toolCommand(toolName);
  if (command === "status") return { command, result: (await runLodestar(["handoff", "status", ...identityArgs(host)], "", options)).data };
  if (command === "now") {
    // A lost second-phase response must settle before another checkpoint is written.
    const pending = await unresolvedRequests(host, dataDir, "handoff");
    for (const { file, saved } of pending) {
      const samePhase = saved.operation === "handoff.now" && saved.suffix === "handoff.now"
        || saved.operation === "handoff.checkpoint" && saved.suffix === "handoff.now.checkpoint";
      if (!samePhase || saved.host.argsDigest !== host.argsDigest) {
        throw new Error(`An earlier mutation has an unresolved outcome. Reconcile its exact original request before a new write: ${file}`);
      }
    }
    if (pending.length > 1) throw new Error("Multiple unresolved handoff phases require explicit reconciliation");
    const finalPhasePending = pending.some(({ saved }) => saved.operation === "handoff.now");
    if (!finalPhasePending) await mutateOwned("handoff.checkpoint", host, dataDir, (id) => ({ id, checkpoint: checkpointFromPacket(args.packet) }), options, "handoff.now.checkpoint");
  }
  const envelope = await mutateOwned(`handoff.${command}`, host, dataDir, (id) =>
    ["arm", "checkpoint"].includes(command) ? { id, checkpoint: checkpointFromPacket(args.packet) }
      : { id, reason: command === "now" ? "Host-authorized handoff now" : "Host-authorized handoff disarm" }, options);
  return { command, result: envelope.data };
}
export async function recordTail(input, role, text, options = {}) {
  if (typeof text !== "string" || !text.trim()) return false;
  const host = hookHost(input, `tail:${role}`);
  const start = await context(host, options);
  const id = sessionRecordId("handoff", start.data.project, host);
  const read = await exactRecord(id, host, options, start.revision);
  if (!read.ok) return false;
  verifyOwner(read.data, "handoff", start, host);
  if (read.data.data.state !== "open") return false;
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error("Tail capture requires the plugin journal directory");
  await mutateOwned("handoff.checkpoint", host, dataDir, (target, record) => {
    if (!record || record.data.state !== "open") throw new Error("Session handoff is no longer armed");
    const checkpoint = structuredClone(record.data.checkpoint);
    checkpoint.references.push({ kind: "conversation-tail", role, turn: host.turnId, text: redact(text).value });
    return { id: target, checkpoint };
  }, options, `tail:${role}:${digest(text)}`);
  return true;
}

// Capture is opt-in per fact rather than inferred from the turn. A marker line is
// deterministic: it never fires on an ordinary message, needs no extra model call, and
// cannot fill the queue with near-misses. Candidates land in quarantine, so nothing here
// can reach the startup budget without a person promoting it.
const NOTE = /^[ \t]*LODESTAR NOTE:[ \t]*(\S.*?)[ \t]*$/gmu;
const MAX_NOTES = 3;

export function extractNotes(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  for (const [, body] of String(text).matchAll(NOTE)) {
    const note = body.replace(/\s+/gu, " ").trim();
    if (note && note.length <= 4_096) seen.add(note);
    if (seen.size >= MAX_NOTES) break;
  }
  return [...seen];
}

export async function captureNotes(input, text, options = {}) {
  const notes = extractNotes(text);
  if (!notes.length) return 0;
  const host = hookHost(input, "capture-notes");
  if (!options.dataDir) throw new Error("Note capture requires the plugin journal directory");
  let captured = 0;
  for (const note of notes) {
    await mutateOwned("pending.add", host, options.dataDir,
      (id) => ({ id, text: redact(note).value, source: "hook" }), options, `pending.add:${digest(note)}`);
    captured += 1;
  }
  return captured;
}
export async function startupContext(input, options = {}) {
  for (const field of ["session_id", "cwd"]) safe(input[field], field, 32_768);
  const host = { sessionId: input.session_id, cwd: input.cwd };
  const envelope = await context(host, options);
  return `${STARTUP_CONTEXT_PREFIX}${canonical(envelope.data)}${STARTUP_CONTEXT_SUFFIX}`;
}

// Native local-only lifecycle adapter. The exact project/session binding is opt-in;
// it supplies record references, never executable paths or permission authority.
const COMPACT_LIMIT = 7_000;
async function compactionBinding(input) {
  for (const field of ["session_id", "cwd"]) safe(input[field], field, 32_768);
  const file = path.join(input.cwd, ".omx", "lodestar-compaction.json");
  let binding;
  try { binding = await readJson(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (binding.session_id !== input.session_id) return null;
  const allowed = ["version", "project_root", "session_id", "intent_record_id", "database"];
  if (binding.version !== 1 || Object.keys(binding).some((field) => !allowed.includes(field))) {
    throw new Error(`Unsupported compaction binding: ${file}`);
  }
  for (const field of allowed.slice(1, 4)) safe(binding[field], field, 32_768);
  if (binding.database !== undefined) {
    safe(binding.database, "database", 32_768);
    if (!path.isAbsolute(binding.database)
        || !path.resolve(binding.database).startsWith(path.resolve(input.cwd) + path.sep)) {
      throw new Error("An isolated compaction database must be inside the bound project");
    }
  }
  if (path.resolve(binding.project_root) !== path.resolve(input.cwd)) {
    throw new Error("Compaction binding does not match the hook working directory");
  }
  return binding;
}
const compactionOptions = (binding, options) => binding.database
  ? { ...options, env: { ...(options.env ?? process.env), LODESTAR_DB: binding.database } }
  : options;
async function compactionRead(input, binding, options) {
  const host = { sessionId: input.session_id, cwd: input.cwd };
  const start = await context(host, options);
  const check = await runLodestar(["work", "check", "--cwd", host.cwd,
    "--at-revision", String(start.revision), "--", binding.intent_record_id], "", options);
  if (check.more !== false || check.data?.complete !== true) {
    throw new Error("Current intent read is incomplete; compaction checkpoint is blocked");
  }
  const id = sessionRecordId("handoff", start.data.project, host);
  const exact = await exactRecord(id, host, options, start.revision);
  if (exact.ok) verifyOwner(exact.data, "handoff", start, host);
  const projection = Object.fromEntries(["plan", "actual", "delta", "continuation", "continuity"]
    .map((field) => [field, check.data[field]]));
  return { host, start, check, exact, id, projection, semantic: digest(projection) };
}
async function replayCompactionPending(host, dataDir, options) {
  const pending = await unresolvedRequests(host, dataDir, "handoff");
  if (pending.length > 1) throw new Error("Multiple pending handoff requests require explicit reconciliation");
  if (!pending.length) return;
  const { file, saved } = pending[0];
  if (saved.operation !== "handoff.checkpoint" || !saved.suffix.startsWith("compact:")) {
    throw new Error(`A non-compaction handoff request is unresolved: ${file}`);
  }
  if ((saved.automatic_replays ?? 0) >= 1) {
    throw new Error(`Automatic exact replay was already attempted; reconcile the saved request: ${file}`);
  }
  // Save the replay count before dispatch. The guarded original request and ID stay intact.
  await atomicWrite(file, { ...saved, automatic_replays: 1 });
  await mutateOwned(saved.operation, saved.host, dataDir,
    () => { throw new Error("Exact replay must never build a new request"); }, options, saved.suffix);
}
export async function checkpointForCompaction(input, dataDir, options = {}) {
  const binding = await compactionBinding(input);
  if (!binding) return { bound: false };
  options = compactionOptions(binding, options);
  const host = hookHost(input, "PreCompact");
  if (!dataDir) throw new Error("Compaction checkpoint requires the plugin journal directory");
  const lock = path.join(dataDir, "compaction", `${key(canonical([host.cwd, host.sessionId]))}.lock`);
  await mkdir(path.dirname(lock), { recursive: true });
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Compaction attempt is already locked; inspect before recovery: ${lock}`); throw error; }
  try {
    await replayCompactionPending(host, dataDir, options);
    const read = await compactionRead(input, binding, options);
    if (read.exact.ok && read.exact.data.data.state !== "open") {
      throw new Error("Bound session handoff is closed or cancelled; explicit rearming is required");
    }
    const previous = read.exact.ok ? read.exact.data.data.checkpoint.references : [];
    if (previous.some((reference) => reference.kind === "lodestar-work-check"
        && reference.semantic_sha256 === read.semantic)) {
      return { bound: true, changed: false, handoff_id: read.id, revision: read.exact.data.revision };
    }
    const requestHost = { ...host, argsDigest: read.semantic };
    const result = await mutateOwned("handoff.checkpoint", requestHost, dataDir, (id, record, start) => {
      if (start.revision !== read.check.revision) throw new Error("Intent changed before checkpoint; read again");
      if (record && record.data.state !== "open") throw new Error("Session handoff was closed before checkpoint");
      return { id, checkpoint: {
        objective: read.projection.plan.brief,
        current_state: read.projection.continuation?.next_action ?? "Read the current work check before continuing",
        completed_results: [],
        unresolved_work: read.projection.delta.requirements.filter((row) => !row.subtree_ready_to_review),
        references: [...(record?.data.checkpoint.references ?? []).filter((row) => row.kind !== "lodestar-work-check"),
          { kind: "lodestar-work-check", version: 1, intent_record_id: binding.intent_record_id,
            semantic_sha256: read.semantic, projection: redact(read.projection).value }],
      } };
    }, { ...options, basisReads: [read.check] },
    `compact:${read.semantic}:${read.exact.ok ? read.exact.data.revision : "absent"}`);
    return { bound: true, changed: true, handoff_id: read.id,
      revision: result.data.record.revision, receipt: result.request };
  } finally { await handle.close(); await unlink(lock); }
}
export async function compactRecoveryContext(input, dataDir, options = {}) {
  const binding = await compactionBinding(input);
  if (!binding) return null;
  options = compactionOptions(binding, options);
  const read = await compactionRead(input, binding, options);
  const pending = await unresolvedRequests(read.host, dataDir, "handoff");
  const status = read.exact.ok ? read.exact.data.data.state : "not_saved";
  const saved = read.exact.ok ? read.exact.data.data.checkpoint.references
    .find((reference) => reference.kind === "lodestar-work-check") : null;
  const launch = resolveLaunch(options.env ?? process.env);
  const context = { version: 1, source: "current public Lodestar reads; supplied results are not test proof",
    checkpoint_status: status, pending_requests: pending.map(({ file }) => file),
    saved_checkpoint_matches_current: saved?.semantic_sha256 === read.semantic,
    read_access: { node: launch.command, cli: launch.args[0],
      database: (options.env ?? process.env).LODESTAR_DB ?? null,
      current_work_check_args: ["work", "check", "--cwd", input.cwd, "--", binding.intent_record_id],
      saved_handoff_get_args: ["get", "--", read.id] },
    must_read_before_action: status !== "open" || pending.length > 0
      || read.projection.continuity?.complete !== true,
    current: read.projection };
  const prefix = "Lodestar compact recovery (v1):\n";
  let output = prefix + canonical(context);
  if (output.length > COMPACT_LIMIT) {
    delete context.current;
    context.omitted = "Full current projection exceeds the native context budget; follow the literal public reads.";
    context.must_read_before_action = true;
    output = prefix + canonical(context);
  }
  if (output.length > COMPACT_LIMIT) throw new Error("Required compact recovery read paths exceed the context budget");
  return output;
}
