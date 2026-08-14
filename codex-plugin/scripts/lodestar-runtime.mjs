import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

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
export const canonical = (value) => `${JSON.stringify(normalized(value))}\n`;
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

export function parseHandoffCommand(prompt) {
  return /^(?:handoff) (arm|status|checkpoint|now|disarm)$/u
    .exec(String(prompt).trim())?.[1] ?? null;
}

function toolCommand(name) {
  return /(?:^|__)lodestar_handoff_(arm|status|checkpoint|now|disarm)$/u
    .exec(String(name))?.[1] ?? null;
}

export function workToolCommand(name) {
  return /(?:^|__)lodestar_work_(start|done|status)$/u.exec(String(name))?.[1] ?? null;
}

function packetSchema() {
  return "{goal:string,rules:string[],entries:Array<{key:string,state:'fact'|'trap'|"
    + "'ask'|'unsure'|'dead',text:string,scope:string[],provenance:{kind:'user'|'tool'|"
    + "'repo'|'agent'|'decision',sourceRef:string,observedAt:string},generation:integer}>,"
    + "work:object,nextMove:string,evidence:array}. A dead entry requires evidence "
    + "{key:'dead:<entry-key>',kind:'user'|'decision',sourceRef:<matching provenance>}.";
}

export async function authorizePrompt(input, dataDir, now = Date.now()) {
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
    toolName: input.tool_name, argsDigest: digest(args), expiresAt: now + AUTH_TTL_MS });
  await unlink(claimed);
  return { matched: true, allowed: true, updatedInput: { ...args, _attestation: token } };
}

async function consume(toolName, rawInput, dataDir, now = Date.now()) {
  const token = rawInput?._attestation;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error("Missing host attestation");
  }
  const file = paths(dataDir, "unused").attest(token);
  const claimed = `${file}.${process.pid}.used`;
  await rename(file, claimed);
  try {
    const record = await readJson(claimed), args = sanitize(rawInput);
    // Either family may have issued the token; the command must still match the tool it
    // was minted for, so a work attestation can never be replayed as a continuity one.
    const expected = toolCommand(toolName) ?? workToolCommand(toolName);
    if (record.expiresAt < now || record.token !== token || record.toolName !== toolName
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
    .map((entry) => entry.name).sort().reverse() : [];
  for (const version of versions) {
    const command = path.join(root, version, "node.exe");
    const entry = path.join(root, version, "node_modules", "lodestar-agent-context",
      "lodestar.mjs");
    if (existsSync(command) && existsSync(entry)) return { command, args: [entry] };
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

async function runLodestar(args, input = "", options = {}) {
  const launch = options.launch ?? resolveLaunch(options.env ?? process.env);
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env,
    });
    let stdout = "", stderr = "", settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const append = (prior, value) => {
      const next = prior + value;
      if (Buffer.byteLength(next, "utf8") > OUTPUT_LIMIT) {
        child.kill();
        finish(new Error("One-shot Lodestar output exceeded its limit."));
      }
      return next;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout = append(stdout, value); });
    child.stderr.on("data", (value) => { stderr = append(stderr, value); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const envelope = parseEnvelope(code === 0 ? stdout : stderr || stdout);
      if (!envelope || envelope.v !== 1) {
        finish(new Error("One-shot Lodestar returned an invalid envelope."));
      } else if (code !== 0 || envelope.ok !== true) {
        const error = new Error(`Lodestar ${args[0]} failed: `
          + `${envelope.error?.message ?? "unknown error"}`);
        error.code = envelope.error?.code;
        finish(error);
      } else finish(null, envelope);
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("One-shot Lodestar timed out."));
    }, options.timeoutMs ?? TIMEOUT_MS);
    timer.unref();
    child.stdin.end(input);
  });
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
    toolName: input.tool_name, argsDigest: digest(args), expiresAt: now + AUTH_TTL_MS });
  return { matched: true, allowed: true, updatedInput: { ...args, _attestation: token } };
}

export async function executeWork(toolName, rawInput, dataDir, options = {}) {
  const { host, args } = await consume(toolName, rawInput, dataDir, options.now?.() ?? Date.now());
  const command = workToolCommand(toolName);
  const cli = ["work", ...(command === "status" ? [] : [command]),
    "--cwd", host.cwd, "--session", host.sessionId, "--agent", "codex", "--harness", "codex"];
  if (command !== "status") {
    // report is required for start and optional for done; the CLI enforces the rest.
    const report = redact(String(args.report ?? "")).value.trim();
    if (command === "start" && !report) throw new Error("work start requires report text");
    if (report) cli.splice(2, 0, report);
  }
  const envelope = await runLodestar(cli, "", options);
  return { command, result: envelope.data };
}

export async function executeHandoff(toolName, rawInput, dataDir, options = {}) {
  const { host, args } = await consume(toolName, rawInput, dataDir, options.now?.() ?? Date.now());
  const command = toolCommand(toolName);
  const cli = ["handoff", command, "--cwd", host.cwd, "--session", host.sessionId,
    "--agent", "codex", "--harness", "codex", "--turn", host.turnId];
  const packet = ["arm", "checkpoint", "now"].includes(command)
    ? redact(structuredClone(args.packet)).value : null;
  const envelope = await runLodestar(cli, packet ? canonical(packet) : "", options);
  return { command, result: envelope.data };
}

export async function recordTail(input, role, text, options = {}) {
  try {
    for (const field of ["session_id", "turn_id", "cwd"]) safe(input[field], field, 32_768);
    if (typeof text !== "string" || !text.trim()) return false;
    const body = redact({ role, turn: input.turn_id, text }).value;
    await runLodestar(["handoff", "tail", "--cwd", input.cwd,
      "--session", input.session_id, "--agent", "codex", "--harness", "codex",
      "--turn", input.turn_id, "--role", role], canonical(body), options);
    return true;
  } catch (error) {
    if (["database_not_found", "handoff_not_armed"].includes(error.code)) return false;
    return false;
  }
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
  let captured = 0;
  for (const note of notes) {
    try {
      for (const field of ["session_id", "cwd"]) safe(input[field], field, 32_768);
      await runLodestar(["pending", "add", redact(note).value, "--cwd", input.cwd,
        "--session", input.session_id, "--agent", "codex", "--harness", "codex",
        "--source", "hook"], "", options);
      captured += 1;
    } catch {
      // A hook must never fail a session over an optional capture.
    }
  }
  return captured;
}

export async function startupContext(input, options = {}) {
  for (const field of ["session_id", "cwd"]) safe(input[field], field, 32_768);
  const envelope = await runLodestar(["start", "--cwd", input.cwd,
    "--session", input.session_id, "--agent", "codex", "--harness", "codex"], "", options);
  return `Lodestar startup context (v1):\n${canonical(envelope.data)}`;
}
