import { lodestarError } from "./errors.mjs";

const text = { type: "string", minLength: 1 };
const list = { type: "array" };
const object = { type: "object" };
const optional = { evidence: list, conditions: list, direction: { type: ["object", "null"] },
  rejected_alternative: {}, supersedes_event_id: { type: ["string", "null"] }, resolved_heads: list };
const define = (required, properties) => ({ type: "object", required,
  properties, additionalProperties: false });

// These declarations are consumed by CLI validation and shipped native tools.
// Callers do not maintain separate domain field lists or defaults.
export const MUTATION_INPUTS = Object.freeze({
  "decision.set": define(["key", "value", "reason", "status"], {
    key: text, value: text, reason: text, status: { enum: ["accepted", "blocked"] }, ...optional }),
  "decision.status": define(["key", "reason", "status"], {
    key: text, reason: text, status: { enum: ["accepted", "blocked"] }, ...optional }),
  "decision.drop": define(["key", "reason", "status"], {
    key: text, reason: text, status: { enum: ["dead", "superseded"] }, successor: {}, ...optional }),
  "decision.inject": define(["include_agent_decisions"], { include_agent_decisions: { type: "boolean" } }),
  "work.start": define(["id", "description"], { id: text, description: text,
    artifacts: list, decision_ids: list }),
  "work.report": define(["id", "outcome", "description", "action_id"], {
    id: text, outcome: { enum: ["attempted", "interrupted", "failed", "completed", "verified", "unknown"] },
    description: text, action_id: text, evidence: list, artifacts: list, decision_ids: list,
    checkpoint_ids: list, unresolved_consequence: { type: ["string", "null"] }, observed_at: text }),
  "work.done": define(["id", "outcome", "description", "action_id"], {
    id: text, outcome: { enum: ["completed", "verified"] }, description: text, action_id: text,
    evidence: list, artifacts: list, decision_ids: list, checkpoint_ids: list,
    unresolved_consequence: { type: ["string", "null"] }, observed_at: text }),
  "work.expire": define(["targets", "reason"], { targets: list, reason: text }),
  "handoff.arm": define(["id", "checkpoint"], { id: text, checkpoint: object }),
  "handoff.checkpoint": define(["id", "checkpoint"], { id: text, checkpoint: object,
    state: { enum: ["open", "closed"] }, reason: text }),
  "handoff.now": define(["id", "reason"], { id: text, reason: text }),
  "handoff.claim": define(["id"], { id: text }),
  "handoff.disarm": define(["id", "reason"], { id: text, reason: text }),
  "pending.add": define(["id", "text"], { id: text, text, source: {} }),
  "pending.promote": define(["id", "destination"], { id: text, destination: object }),
  "pending.drop": define(["id", "reason"], { id: text, reason: text }),
});

export function validateDomainInput(operation, input) {
  const schema = MUTATION_INPUTS[operation];
  if (!schema) throw lodestarError("unknown_operation", "Unsupported mutation operation.", { identifiers: { operation } });
  if (!input || typeof input !== "object" || Array.isArray(input)) throw lodestarError("invalid_input", "A structured domain input is required.");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) throw lodestarError("invalid_input", "Unknown domain control field.", { identifiers: { operation, field: key } });
  }
  for (const key of schema.required) if (!Object.hasOwn(input, key)) {
    throw lodestarError("missing_argument", "Required domain field is missing.", { identifiers: { operation, field: key } });
  }
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties[key], kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = rule.type === undefined ? null : [].concat(rule.type);
    if ((types && !types.includes(kind)) || (rule.enum && !rule.enum.includes(value)) ||
        (rule.minLength && value.length < rule.minLength)) {
      throw lodestarError("invalid_input", "Invalid domain field.", { identifiers: { operation, field: key } });
    }
  }
  return input;
}

const identity = ["--cwd", "--session", "--agent", "--harness"];
export const HOST_OPTIONS = Object.freeze({
  "--target": "target", "--home": "home", "--codex-root": "codexRoot",
  "--codex-home": "codexHome", "--claude-home": "claudeHome",
  "--xdg-config-home": "xdgConfigHome", "--hermes-home": "hermesHome", "--opencode-root": "opencodeRoot",
});
export const hostOptions = (options) => Object.fromEntries(Object.entries(HOST_OPTIONS)
  .filter(([flag]) => options[flag] !== undefined).map(([flag, field]) => [field, options[flag]]));
export const INSTALLATION_OPTIONS = Object.freeze({ ...HOST_OPTIONS,
  "--wsl-shim": "wslShim", "--posix-shim": "posixShim" });
export const installationOptions = (options) => Object.fromEntries(Object.entries(INSTALLATION_OPTIONS)
  .filter(([flag]) => options[flag] !== undefined).map(([flag, field]) => [field, options[flag]]));
export const PATH_OPTIONS = Object.freeze(["--cwd", "--file", "--db", "--source", "--wsl-shim", "--posix-shim",
  "--args-file", "--output", ...Object.keys(HOST_OPTIONS).filter((flag) => !["--target", "--codex-root"].includes(flag))]);
const domain = (usage, summary, positionals) => ({ usage, summary,
  values: [...identity, "--file", "--limit", "--at-revision"], booleans: [], positionals });
export const COMMANDS = Object.freeze({
  setup: { usage: "lodestar setup [--target <codex|claude|hermes|opencode|all>] [--apply] [--replace-local]",
    summary: "Plan or explicitly apply native skill installation with backups and interrupted-install recovery.",
    values: Object.keys(INSTALLATION_OPTIONS),
    booleans: ["--apply", "--replace-local"], positionals: 0 },
  start: { usage: "lodestar start [--cwd <path>] [--topic <text>] [identity options]",
    summary: "Read fresh relevant project context without changing state.",
    values: [...identity, "--topic", ...Object.keys(INSTALLATION_OPTIONS)], booleans: [], positionals: 0 },
  init: { usage: "lodestar init [--migrate|--promote-recovery --file <request.json>] [--db <path>]",
    summary: "Explicitly create a current store or apply a preserving conversion.",
    values: ["--file"], booleans: ["--migrate", "--promote-recovery"], positionals: 0 },
  put: { usage: "lodestar put [--file <request.json>]", summary: "Create or update using the shared guarded mutation contract.",
    values: ["--file"], booleans: [], positionals: 0 },
  get: { usage: "lodestar get <id-or-alias> [--history|--raw]", summary: "Read an exact record, raw evidence, or preserved history and update basis.",
    values: [], booleans: ["--history", "--raw"], positionals: 1 },
  find: { usage: "lodestar find <query> [--scope <scope>] [--kind <kind>] [--history] [--limit <n> --offset <n> --at-revision <n>]",
    summary: "Search current records, with explicit history and stable paging when requested.",
    values: ["--scope", "--kind", "--limit", "--offset", "--at-revision"], booleans: ["--history"], positionals: 1 },
  links: { usage: "lodestar links <id-or-alias> [--limit <n> --offset <n> --at-revision <n>]",
    summary: "Read explicit relationships, including historical peers.",
    values: ["--limit", "--offset", "--at-revision"], booleans: [], positionals: 1 },
  delete: { usage: "lodestar delete [--file <request.json>]", summary: "Retire a record with a checked revision and preserved history.",
    values: ["--file"], booleans: [], positionals: 0 },
  doctor: { usage: "lodestar doctor [--migration-preflight|--recovery-preflight --source <accepted.db>] [--db <recovered.db>]",
    summary: "Inspect integrity or return a read-only conversion or recovery basis.",
    values: ["--source"], booleans: ["--migration-preflight", "--recovery-preflight"], positionals: 0 },
  export: { usage: "lodestar export [--db <path>]", summary: "Export exact raw rows and metadata as private recovery evidence.", values: [], booleans: [], positionals: 0 },
  work: domain("lodestar work <status|history|start|report|done|expire> [--file <request.json>]",
    "Read advisory work or record consequential outcomes through the shared contract.", { min: 0, max: 1 }),
  handoff: domain("lodestar handoff <status|history|arm|checkpoint|now|claim|disarm> [--file <request.json>]",
    "Read continuity or explicitly update/claim a transfer; never creates sessions.", 1),
  decision: domain("lodestar decision <show|status|set|drop|inject> [key] [--file <request.json>]",
    "Read exact decision streams or record a checked attributed change.", { min: 1, max: 2 }),
  pending: domain("lodestar pending <list|add|promote|drop> [--file <request.json>]",
    "Keep candidates unresolved until an explicit checked promotion.", { min: 0, max: 1 }),
  agents: { usage: "lodestar agents [status|verify|template] [--cwd <path>] [--mode <stub|full>]",
    summary: "Inspect native instruction routing or print its template.", values: ["--cwd", "--mode"], booleans: [], positionals: { min: 0, max: 1 } },
  skills: { usage: "lodestar skills [verify] [--target <codex|claude|hermes|opencode|all>] [--home <path>]",
    summary: "Compare complete maintained/package/installed skill payloads.",
    values: Object.keys(HOST_OPTIONS), booleans: [], positionals: { min: 0, max: 1 } },
});

// Core dispatch and native tools share the operation effect classification.
// In particular, decision.status changes a decision; decision.show reads it.
export const READ_OPERATIONS = Object.freeze({
  start: ["start"], get: ["get"], find: ["find"], links: ["links"],
  doctor: ["doctor"], export: ["export"],
  "work.status": ["work", "status"], "work.history": ["work", "history"],
  "handoff.status": ["handoff", "status"], "handoff.history": ["handoff", "history"],
  "decision.show": ["decision", "show"], "pending.list": ["pending", "list"],
  "skills.verify": ["skills", "verify"], "agents.status": ["agents", "status"],
  "agents.verify": ["agents", "verify"], "agents.template": ["agents", "template"],
});
