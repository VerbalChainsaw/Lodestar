import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const TTL = 10 * 60_000;
const SECRET_FIELD = /(?:^|[-_])(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential)(?:$|[-_])/i;
const SECRET_TEXT = [
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9]{20,})\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
];
const key = (value) => createHash("sha256").update(String(value)).digest("hex");
const normalized = (value) => Array.isArray(value) ? value.map(normalized)
  : value && Object.getPrototypeOf(value) === Object.prototype
    ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([field, item]) => [field, normalized(item)]))
    : value;
export const canonical = (value) => `${JSON.stringify(normalized(value))}\n`;
const digest = (value) => key(canonical(value));
const safe = (value, label, maximum = 16_384) => {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
};
const paths = (root, session) => ({ auth: path.join(root, "authorizations", `${key(session)}.json`),
  attest: (token) => path.join(root, "attestations", `${token}.json`) });
async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(canonical(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const sanitize = (input) => Object.fromEntries(Object.entries(input ?? {})
  .filter(([field]) => field !== "_attestation"));

export async function authorizePrompt(input, dataDir, now = Date.now()) {
  for (const field of ["session_id", "turn_id", "cwd"]) safe(input[field], field, 32_768);
  if (!/^(?:handoff now|\$lodestar:handoff handoff now)$/u.test(String(input.prompt).trim())) return null;
  const record = { sessionId: input.session_id, turnId: input.turn_id, cwd: input.cwd,
    expiresAt: now + TTL };
  await atomicWrite(paths(dataDir, input.session_id).auth, record);
  return { additionalContext: "Call the bundled MCP tool handoff_now exactly once. Author packet as {goal:string,rules:string[] using positive wording,entries:Array<{key:string,state:'fact'|'trap'|'ask'|'unsure'|'dead',text:string,scope:string[],provenance:{kind:'user'|'tool'|'repo'|'agent',sourceRef:string,observedAt:string},generation:integer}>,work:{items:array,files:array,symbols:array,commands:array,errors:array,urls:array,ids:array,tests:array},nextMove:string,evidence:array}." };
}
export async function attestTool(input, dataDir, now = Date.now()) {
  if (!/(?:^|__)handoff_now$/u.test(String(input.tool_name))) return { matched: false };
  for (const field of ["session_id", "turn_id", "tool_use_id", "cwd"]) {
    safe(input[field], field, 32_768);
  }
  const file = paths(dataDir, input.session_id).auth;
  let auth;
  try { auth = await readJson(file); } catch { return { matched: true, allowed: false,
    reason: "handoff now is not authorized for this host session" }; }
  if (auth.expiresAt < now || auth.sessionId !== input.session_id || auth.turnId !== input.turn_id
    || auth.cwd !== input.cwd) return { matched: true, allowed: false,
    reason: "handoff now authorization does not match this session, turn, or cwd" };
  const claimed = `${file}.${input.tool_use_id}.used`;
  try { await rename(file, claimed); } catch { return { matched: true, allowed: false,
    reason: "handoff now authorization was already consumed" }; }
  const args = sanitize(input.tool_input), token = randomBytes(32).toString("hex");
  await atomicWrite(paths(dataDir, input.session_id).attest(token), { token,
    sessionId: input.session_id, cwd: input.cwd, toolName: input.tool_name,
    argsDigest: digest(args), expiresAt: now + TTL });
  await unlink(claimed);
  return { matched: true, allowed: true, updatedInput: { ...args, _attestation: token } };
}

async function consume(toolName, rawInput, dataDir, now = Date.now()) {
  const token = rawInput?._attestation;
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token)) {
    throw new Error("Missing host attestation");
  }
  const file = paths(dataDir, "unused").attest(token), claimed = `${file}.${process.pid}.used`;
  await rename(file, claimed);
  try {
    const record = await readJson(claimed), args = sanitize(rawInput);
    if (record.expiresAt < now || record.token !== token || record.toolName !== toolName
      || record.argsDigest !== digest(args)) throw new Error("Invalid or mismatched host attestation");
    return { host: record, args };
  } finally { await unlink(claimed); }
}

function redact(value, report = { count: 0, categories: new Set() }) {
  if (typeof value === "string") {
    let text = value;
    for (const pattern of SECRET_TEXT) text = text.replace(pattern, (...match) => {
      report.count += 1; report.categories.add("secret-text");
      return match[1] ? `${match[1]}[REDACTED]` : "[REDACTED]";
    });
    return { value: text, report };
  }
  if (Array.isArray(value)) return { value: value.map((item) => redact(item, report).value), report };
  if (value && Object.getPrototypeOf(value) === Object.prototype) return {
    value: Object.fromEntries(Object.entries(value).map(([field, item]) => {
      if (SECRET_FIELD.test(field) && typeof item === "string") {
        report.count += 1; report.categories.add("secret-field"); return [field, "[REDACTED]"];
      }
      return [field, redact(item, report).value];
    })), report };
  return { value, report };
}

function validateSemantic(packet) {
  if (!packet || Object.getPrototypeOf(packet) !== Object.prototype) throw new Error("packet must be an object");
  safe(packet.goal, "packet.goal", 4_096); safe(packet.nextMove, "packet.nextMove", 16_384);
  if (!Array.isArray(packet.rules) || packet.rules.length > 10
    || packet.rules.some((rule) => { safe(rule, "packet.rules", 4_096);
      return /\b(?:never|not|no|cannot|don't|avoid|reject|deny|forbid|stop)\b/iu.test(rule); })) {
    throw new Error("packet.rules must contain at most ten positive rules");
  }
  if (!Array.isArray(packet.entries) || packet.entries.length > 35) throw new Error("Invalid packet.entries");
  const keys = new Set();
  for (const entry of packet.entries) {
    if (!entry || !/^[a-z0-9][a-z0-9.-]*$/u.test(entry.key) || keys.has(entry.key)
      || !["fact", "trap", "ask", "unsure", "dead"].includes(entry.state)
      || !Number.isInteger(entry.generation) || entry.generation < 0
      || !Array.isArray(entry.scope) || entry.scope.length > 10
      || !entry.provenance || !["user", "tool", "repo", "agent"].includes(entry.provenance.kind)) {
      throw new Error("Invalid packet entry");
    }
    keys.add(entry.key); safe(entry.text, `entry ${entry.key}`, 8_192);
    safe(entry.provenance.sourceRef, `entry ${entry.key} source`, 4_096);
    safe(entry.provenance.observedAt, `entry ${entry.key} time`, 100);
  }
  if (!packet.work || Object.getPrototypeOf(packet.work) !== Object.prototype
    || !Array.isArray(packet.evidence) || packet.evidence.length > 50) {
    throw new Error("Invalid packet work or evidence");
  }
  return packet;
}

function resolveLaunch(env = process.env) {
  if (env.LODESTAR_NODE && env.LODESTAR_ENTRY) return { command: env.LODESTAR_NODE,
    args: [env.LODESTAR_ENTRY] };
  if (process.platform !== "win32") {
    const launcher = path.join(env.HOME, ".local", "bin", "lodestar");
    if (existsSync(launcher)) return { command: launcher, args: [] };
    const root = path.join(env.HOME, ".local", "opt");
    const versions = existsSync(root) ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-")
        && entry.name.endsWith("-linux-x64"))
      .map((entry) => entry.name).sort().reverse() : [];
    for (const version of versions) {
      const command = path.join(root, version, "bin", "node");
      const entry = path.join(root, version, "lib", "node_modules",
        "lodestar-agent-context", "lodestar.mjs");
      if (existsSync(command) && existsSync(entry)) return { command, args: [entry] };
    }
    return { command: env.LODESTAR_COMMAND || "lodestar", args: [] };
  }
  const root = path.join(env.USERPROFILE || env.HOME, ".local", "opt");
  const versions = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("node-"))
    .map((entry) => entry.name).sort().reverse() : [];
  for (const version of versions) {
    const command = path.join(root, version, "node.exe");
    const entry = path.join(root, version, "node_modules", "lodestar-agent-context", "lodestar.mjs");
    if (existsSync(command) && existsSync(entry)) return { command, args: [entry] };
  }
  throw new Error("Installed Lodestar runtime not found");
}
async function runLodestar(args, input = "") {
  const launch = resolveLaunch();
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], { windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.once("error", reject);
    child.once("close", (code) => {
      let envelope; try { envelope = JSON.parse(code === 0 ? stdout : stderr || stdout); }
      catch { reject(new Error(`Lodestar returned invalid JSON: ${(stderr || stdout).trim()}`)); return; }
      if (code !== 0 || envelope.ok !== true) reject(new Error(
        `Lodestar ${args.join(" ")} failed: ${envelope.error?.message ?? stderr.trim()}`));
      else resolve(envelope);
    });
    child.stdin.end(input);
  });
}

export async function executeHandoff(toolName, rawInput, dataDir) {
  const { host, args } = await consume(toolName, rawInput, dataDir);
  const redacted = redact(structuredClone(args.packet));
  const semantic = validateSemantic(redacted.value), createdAt = new Date().toISOString();
  const packet = { format: "neutral-software-handoff/v3",
    id: `HOF-${createdAt.replace(/[-:.]/gu, "")}-${randomBytes(4).toString("hex")}`,
    source: { provider: "codex", sessionId: host.sessionId, cwd: host.cwd }, ...semantic,
    integrity: { algorithm: "sha256", schemaVersion: 3, createdAt,
      redaction: { count: redacted.report.count, categories: [...redacted.report.categories].sort() } } };
  packet.integrity.digest = digest(packet);
  const envelope = await runLodestar(["handoff", "save", "--cwd", host.cwd,
    "--session", host.sessionId, "--agent", "codex", "--harness", "codex"], canonical(packet));
  return { saved: true, record: envelope.data };
}

export async function startupContext(input) {
  for (const field of ["session_id", "cwd"]) safe(input[field], field, 32_768);
  const envelope = await runLodestar(["start", "--cwd", input.cwd,
    "--session", input.session_id, "--agent", "codex", "--harness", "codex"]);
  return `Lodestar startup context (v1):\n${canonical(envelope.data)}`;
}
