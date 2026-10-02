import { lodestarError } from "./errors.mjs";

const text = { type: "string", minLength: 1 };
const list = { type: "array" };
const object = { type: "object" };
const define = (required, properties) => ({ type: "object", required,
  properties, additionalProperties: false });
const checkpointShape = define(["objective", "current_state", "completed_results", "unresolved_work", "references"], {
  objective: text, current_state: text, completed_results: list, unresolved_work: list, references: list });
const directionShape = { ...define(["kind", "attribution", "reference", "instruction"], {
  kind: { enum: ["user"] }, attribution: { enum: ["asserted", "host_observed"] },
  reference: text, instruction: text }), type: ["object", "null"] };
const promotionDestinationShape = define(["operation", "input"], {
  operation: { enum: ["put", "decision.set"] },
  input: { type: "object", description: "The destination operation input: a put create/update input, or a decision.set input." } });
const optional = { evidence: list, conditions: list, direction: directionShape,
  rejected_alternative: {}, supersedes_event_id: { type: ["string", "null"] }, resolved_heads: list };

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
  "handoff.arm": define(["id", "checkpoint"], { id: text, checkpoint: checkpointShape }),
  "handoff.checkpoint": define(["id", "checkpoint"], { id: text, checkpoint: checkpointShape,
    state: { enum: ["open", "closed"] }, reason: text }),
  "handoff.now": define(["id", "reason"], { id: text, reason: text }),
  "handoff.claim": define(["id"], { id: text }),
  "handoff.disarm": define(["id", "reason"], { id: text, reason: text }),
  "pending.add": define(["id", "text"], { id: text, text, source: {} }),
  "pending.promote": define(["id", "destination"], { id: text, destination: promotionDestinationShape }),
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
const domain = (usage, summary, positionals, { limitedReads = true, paging = false } = {}) => ({ usage,
  summary: `${summary} Reads accept ${limitedReads ? "--limit and " : ""}--at-revision; mutations are guarded by the request write basis.`,
  values: [...identity, "--file", ...(limitedReads ? ["--limit"] : []), ...(paging ? ["--offset"] : []), "--at-revision"],
  booleans: [], positionals });
export const COMMANDS = Object.freeze({
  setup: { usage: "lodestar setup [--target <codex|claude|hermes|opencode|all>] [--apply] [--replace-local]",
    summary: "Plan or explicitly apply native skill installation with backups and interrupted-install recovery.",
    values: Object.keys(INSTALLATION_OPTIONS),
    booleans: ["--apply", "--replace-local"], positionals: 0 },
  start: { usage: "lodestar start [--cwd <path>] [--topic <text>] [--compact] [identity options]",
    summary: "Read fresh relevant project context without changing state. --compact returns bounded references after the same checks and requires a full start for omitted instructions and dependent work.",
    values: [...identity, "--topic", ...Object.keys(INSTALLATION_OPTIONS)], booleans: ["--compact"], positionals: 0 },
  init: { usage: "lodestar init [--migrate|--promote-recovery --file <request.json>] [--db <path>]",
    summary: "Explicitly create a current store or apply a preserving conversion.",
    values: ["--file"], booleans: ["--migrate", "--promote-recovery"], positionals: 0 },
  "migration-backup": { usage: "lodestar migration-backup <new-image.db> --db <schema-four-source.db>",
    summary: "Create and restore-test a new SQLite image for explicit schema-four migration. The source remains read-only; an existing destination is never replaced.",
    values: [], booleans: [], positionals: 1 },
  put: { usage: "lodestar put [--file <request.json>]", summary: "Create or update using the shared guarded mutation contract; update inputs require both set and remove.",
    values: ["--file"], booleans: [], positionals: 0 },
  get: { usage: "lodestar get <id-or-alias> [--history|--raw] [--at-revision <n>]", summary: "Read an exact record, raw evidence, or preserved history and update basis.",
    values: ["--at-revision"], booleans: ["--history", "--raw"], positionals: 1 },
  find: { usage: "lodestar find <query>|--all [--scope <scope>] [--kind <kind>] [--history] [--compact] [--match <contains|terms>] [--explain] [--limit <n> --offset <n> --at-revision <n>]",
    summary: "Search current records with explicit history and stable paging. Default contains reads remain full; --compact returns bounded references requiring full evidence reads; --match terms applies explicit AND terms with no synonyms; --explain names matched fields.",
    values: ["--scope", "--kind", "--limit", "--offset", "--at-revision", "--match"], booleans: ["--history", "--all", "--compact", "--explain"], positionals: { min: 0, max: 1 } },
  links: { usage: "lodestar links <id-or-alias> [--limit <n> --offset <n> --at-revision <n>]",
    summary: "Read explicit relationships, including historical peers.",
    values: ["--limit", "--offset", "--at-revision"], booleans: [], positionals: 1 },
  delete: { usage: "lodestar delete [--file <request.json>]", summary: "Retire a record with a checked revision and preserved history.",
    values: ["--file"], booleans: [], positionals: 0 },
  doctor: { usage: "lodestar doctor [--migration-preflight|--recovery-preflight --source <accepted.db>] [--db <recovered.db>]",
    summary: "Inspect integrity or return a read-only conversion or recovery basis.",
    values: ["--source"], booleans: ["--migration-preflight", "--recovery-preflight"], positionals: 0 },
  export: { usage: "lodestar export [--db <path>]", summary: "Export exact raw rows and metadata as private recovery evidence.", values: [], booleans: [], positionals: 0 },
  work: domain("lodestar work <status|history|check <intent-record-id>|prepare-capture --file <draft.json>|attention [<intent-record-id>]|start|report|done|expire> [--cwd <path>]",
    "Read advisory work, check recorded intent evidence, or record consequential outcomes through the shared contract.",
    { min: 0, max: 2 }),
  handoff: domain("lodestar handoff <status|history|arm|checkpoint|now|claim|disarm> [--file <request.json>]",
    "Read continuity or explicitly update/claim a transfer; never creates sessions.", { min: 0, max: 1 }, { paging: true }),
  decision: domain("lodestar decision <show|status|set|drop|inject> [key] [--file <request.json>]",
    "Read exact decision streams with show (the default); status is a guarded write requiring structured input.", { min: 0, max: 2 }, { paging: true }),
  pending: domain("lodestar pending <list|add|promote|drop> [--file <request.json>]",
    "Keep candidates unresolved until an explicit checked promotion.", { min: 0, max: 1 }),
  recovery: { usage: "lodestar recovery <list|replay <key>> [--interface-config <path>]",
    summary: "Inspect local CLI, Manager and Loader journals or deliberately replay one exact guarded request. Replay returns the original operation envelope; preserve unresolved requests and receipts.",
    values: ["--interface-config"], booleans: [], positionals: { min: 1, max: 2 } },
  agents: { usage: "lodestar agents [status|verify|template] [--cwd <path>] [--mode <stub|full>]",
    summary: "Inspect native instruction routing or print its template.", values: ["--cwd", "--mode"], booleans: [], positionals: { min: 0, max: 1 } },
  skills: { usage: "lodestar skills [verify] [--target <codex|claude|hermes|opencode|all>] [--home <path>]",
    summary: "Compare complete maintained/package/installed skill payloads.",
    values: Object.keys(HOST_OPTIONS), booleans: [], positionals: { min: 0, max: 1 } },
  manager: { usage: "lodestar manager [--interface-config <path>] [--project <record-id>] [--cwd <path>] [--db <path>]",
    summary: "Open the interactive Lodestar Manager in this terminal.",
    values: ["--interface-config", "--project", "--cwd"], booleans: [], positionals: 0 },
});

// Core dispatch and native tools share the operation effect classification.
// In particular, decision.status changes a decision; decision.show reads it.
export const READ_OPERATIONS = Object.freeze({
  start: ["start"], get: ["get"], find: ["find"], links: ["links"], "recovery.list": ["recovery", "list"],
  doctor: ["doctor"], export: ["export"],
  "work.status": ["work", "status"], "work.history": ["work", "history"],
  "work.check": ["work", "check"],
  "work.prepare-capture": ["work", "prepare-capture"], "work.attention": ["work", "attention"],
  "handoff.status": ["handoff", "status"], "handoff.history": ["handoff", "history"],
  "decision.show": ["decision", "show"], "pending.list": ["pending", "list"],
  "skills.verify": ["skills", "verify"], "agents.status": ["agents", "status"],
  "agents.verify": ["agents", "verify"], "agents.template": ["agents", "template"],
});

const string = { type: "string", minLength: 1 };
const number = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positional = (name, index, required = true) => ({ name, binding: "positional", index, required, schema: string });
const option = (name, flag, schema = string) => ({ name, binding: "option", flag, required: false, schema });
const flag = (name, spelling) => ({ name, binding: "flag", flag: spelling, required: false, schema: { type: "boolean" } });
const page = [option("limit", "--limit", { ...number, minimum: 1 }), option("offset", "--offset", number),
  option("at_revision", "--at-revision", number)];
const domainPage = [page[0], page[2]];
const domainRevision = [page[2]];
const cwd = option("cwd", "--cwd");
const bindings = Object.freeze({
  "migration-backup": [positional("destination", 0)],
  "recovery.list": [option("interface_config", "--interface-config")],
  "recovery.replay": [positional("key", 0), option("interface_config", "--interface-config")],
  start: [cwd, option("topic", "--topic"), flag("compact", "--compact")],
  get: [positional("id", 0), flag("history", "--history"), flag("raw", "--raw"), page[2]],
  find: [positional("query", 0, false), flag("all", "--all"), option("scope", "--scope"),
    option("kind", "--kind"), flag("history", "--history"), flag("compact", "--compact"),
    flag("explain", "--explain"), option("match", "--match", { type: "string", enum: ["contains", "terms"], default: "contains" }), ...page],
  links: [positional("id", 0), ...page],
  // The generic form exposes the basic diagnostic only. Recovery planning
  // remains visible in normal command help and requires a dedicated adapter.
  doctor: [],
  export: [],
  "work.status": [cwd, ...domainPage], "work.history": [cwd, ...domainPage],
  "work.check": [cwd, positional("intent_record_id", 0), ...domainRevision],
  "work.prepare-capture": [cwd, { ...option("file", "--file"), required: true }, ...domainRevision],
  "work.attention": [cwd, positional("intent_record_id", 0, false), ...domainRevision],
  "handoff.status": [cwd, ...page], "handoff.history": [cwd, ...page],
  "decision.show": [cwd, positional("key", 0, false), ...page],
  "pending.list": [cwd, ...domainPage],
  "skills.verify": [option("target", "--target", { type: "string", enum: ["codex", "claude", "hermes", "opencode", "all"] }),
    option("home", "--home")],
  "agents.status": [cwd, option("mode", "--mode", { type: "string", enum: ["stub", "full"] })],
  "agents.verify": [cwd, option("mode", "--mode", { type: "string", enum: ["stub", "full"] })],
  "agents.template": [cwd, option("mode", "--mode", { type: "string", enum: ["stub", "full"] })],
});
const constraints = Object.freeze({
  get: [{ kind: "at_most_one", parameters: ["history", "raw"] }],
  find: [{ kind: "exactly_one", parameters: ["query", "all"] }],
});
const targetSchema = { type: "string", enum: ["codex", "claude", "hermes", "opencode", "all"] };
const valueSchemas = Object.freeze({
  "--target": targetSchema,
  "--mode": { type: "string", enum: ["stub", "full"] },
  "--match": { type: "string", enum: ["contains", "terms"], default: "contains" },
  "--limit": { ...number, minimum: 1 },
  "--offset": number,
  "--at-revision": number,
});
const globalCliInputs = Object.freeze({
  values: ["--db", "--output"].map((name) => ({ flag: name,
    schema: { type: "string", minLength: 1, format: "path" } })),
  booleans: ["--human", "--help", "--version"],
  argument_transport: { alternatives: ["--args-file <JSON-array-file>", "--args-stdin"],
    constraint: "Use one transport alone; its JSON string array contains the complete command arguments." },
});
const cliConstraints = Object.freeze({
  setup: ["--replace-local applies only when --apply is used; review the setup plan before applying."],
  init: ["--migrate and --promote-recovery are mutually exclusive; plain init creates an explicitly new store.",
    "--file is the JSON request for --migrate or --promote-recovery; stdin is accepted when --file is absent."],
  doctor: ["--migration-preflight and --recovery-preflight are mutually exclusive.",
    "--source requires --recovery-preflight; --recovery-preflight requires --source."],
  manager: ["Requires an interactive terminal; --output is unavailable for Manager."],
  "agents.status": ["--mode applies only to agents template."],
  "agents.verify": ["--mode applies only to agents template."],
  get: ["--history and --raw are mutually exclusive."],
  start: ["Default start returns full context and instructions. --compact runs the same semantic, source and native instruction checks, then omits bodies, instructions and write basis; run the exact full start before dependent work.",
    "Compact context has at most 20 records and 24000 serialized data bytes, excluding the envelope. selected_records, displayed_records and omitted_records account for summaries; projection_complete is false and instructions_complete is false even when the source checks complete.",
    "Oversized fields or exact argument arrays are omitted whole in omitted_fields; identifiers are never shortened. Repeat the original full start through --args-file or --args-stdin when the exact full_read_args are omitted."],
  find: ["Provide exactly one of query and --all. --all with --match terms is invalid; use a query for terms or --match contains for all.",
    "Default --match contains preserves contiguous substring search and full records; --explain adds deterministic matched-field reasons, not confidence in truth. --history explicitly includes historical records.",
    "--match terms uses NFC normalization, simple Unicode toLowerCase, and AND across 1–16 distinct whitespace-separated terms over the existing searchable fields and aliases; no synonyms or semantic inference.",
    "--compact defaults to a page of 20 and caps requested pages at 20 records and 24000 serialized data bytes, excluding the envelope. Bodies and write basis are omitted; read exact get -- <id> references before evidence-dependent work or guarded edits.",
    "selected_records counts selected rows including reported errors; displayed_records counts summaries; omitted_records counts valid summaries omitted for bounds. discovery_complete is false for more pages, omitted records or errors. projection_complete is false because compact omits evidence bodies. no_matches describes only this query and filters.",
    "Oversized records, fields and exact argument arrays are omitted whole in the omission ledger; identifiers are never shortened. Repeat the original full invocation through --args-file or --args-stdin when full_read_args or next are omitted. Available continuation args retain query, scope, kind, history, match, explain, compact, limit, offset and store revision; retry at the current revision after a conflict."],
});
const initBody = Object.freeze({
  "--migrate": "JSON {v:5, request_id, preflight, backup}; preflight is doctor --migration-preflight data for the source, and backup contains path, logical_digest, schema_fingerprint from the restore-tested backup preflight. See README.md#storage-and-recovery.",
  "--promote-recovery": "JSON {v:5, request_id, database_instance_id, database_epoch, reason, recovery}; recovery is doctor --recovery-preflight data for the recovered image and accepted source.",
});
function cliInputs(id, argv, inputSchema) {
  const command = argv[0];
  const definition = COMMANDS[argv[0]];
  const occupied = argv.length - 1;
  const counts = typeof definition.positionals === "number"
    ? { min: definition.positionals, max: definition.positionals } : definition.positionals;
  const remaining = id === "work.check" ? { min: 1, max: 1 }
    : id === "work.attention" ? { min: 0, max: 1 }
    : command === "work" ? { min: 0, max: 0 }
      : { min: Math.max(0, counts.min - occupied), max: Math.max(0, counts.max - occupied) };
  return {
    role: "complete CLI parser contract; parameters above are only the safe generic form adapter",
    command_values: definition.values.filter((name) => id === "work.check" ? !["--limit", "--file"].includes(name)
      : !(["work.attention", "work.prepare-capture"].includes(id) &&
        (["--limit", "--session", "--agent", "--harness"].includes(name) || (id !== "work.prepare-capture" && name === "--file")))).map((name) => ({ flag: name,
      schema: valueSchemas[name] ?? { type: "string", minLength: 1 },
      ...(name === "--file" && (inputSchema || id === "init")
        ? { body: inputSchema ? "mutation_request with input_schema" : initBody } : {}),
      ...(name === "--file" && id === "work.prepare-capture" ? { body: "draft_schema version 1; read-only preparation, no mutation request" } : {}) })),
    command_booleans: definition.booleans,
    remaining_positionals: { ...remaining, type: "string" },
    global: globalCliInputs,
    constraints: id === "work.check"
      ? ["Use one exact current knowledge record ID; --limit and --file do not apply to this read."]
      : id === "work.prepare-capture" ? ["Requires --cwd and --file with exact version 1 draft_schema. --limit and actor context do not apply; preparation writes no rows."]
        : id === "work.attention" ? ["Requires --cwd; optional exact intent ID. --limit and --file do not apply; section coverage is separate."] : cliConstraints[id] ?? [],
    ...(inputSchema ? { mutation_body: "mutation_request envelope; operation-specific input_schema below" } : {}),
    ...(id === "init" ? { mutation_body: initBody } : {}),
  };
}
// Only effects absent from the read and mutation registries need declarations.
const specialEffects = Object.freeze({ setup: "external_write", init: "external_write",
  put: "record_write", delete: "record_write", manager: "interactive", "recovery.replay": "external_write", "migration-backup": "external_write" });
const projectReads = new Set(["start", "work.status", "work.history", "work.check", "work.prepare-capture", "work.attention", "handoff.status",
  "handoff.history", "decision.show", "pending.list"]);
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const stringList = { type: "array", items: text };
export const WORK_CHECK_RECORD_SCHEMA = Object.freeze({ type: "object",
  description: "data on a current, project-scoped knowledge record; acceptance, tasks, and continuation may be added later by checked put",
  required: ["intent"], additionalProperties: false, properties: {
    intent: { type: "object", required: ["version", "brief", "user_reference", "requirements", "boundaries", "non_goals"],
      additionalProperties: false, properties: { version: { const: 1 }, brief: text,
        user_reference: text, boundaries: stringList, non_goals: stringList,
        requirements: { type: "array", minItems: 1, items: { type: "object",
          required: ["id", "text", "acceptance"], additionalProperties: false,
          properties: { id: text, text, acceptance: text, parent_id: text } } } } },
    acceptance: { type: "object", required: ["intent_sha256", "results", "blockers"],
      additionalProperties: false, properties: { intent_sha256: sha256, blockers: stringList,
        results: { type: "array", items: { type: "object",
          required: ["requirement_id", "status", "evidence", "notes"], additionalProperties: false,
          properties: { requirement_id: text, status: { enum: ["passed", "failed", "unverified"] },
            notes: { type: "string" }, evidence: { type: "array", items: { type: "object",
              required: ["id", "revision"], additionalProperties: false,
              properties: { id: text, revision: { ...number, minimum: 1 }, data_sha256: sha256 } } } } } } } },
    tasks: { type: "array", description: "Advisory native runtime references; no identity or liveness proof.",
      items: { type: "object", required: ["runtime_task_id", "owner", "requirement_ids", "status"],
        additionalProperties: false, properties: { runtime_task_id: text, owner: text,
          requirement_ids: stringList, status: text } } },
    continuation: { type: "object", description: "Recorded active branch and next action for host restoration; no task admission or runtime authority.",
      required: ["active_requirement_ids", "next_action"], additionalProperties: false,
      properties: { active_requirement_ids: { type: "array", uniqueItems: true, items: text },
        next_action: text,
        context: { type: "object", additionalProperties: false,
          required: ["version", "mission_record_ids", "requirements"],
          description: "Retrieval associations outside the approved intent hash; recorded references confer no authority.",
          properties: { version: { const: 1 }, mission_record_ids: { ...stringList, uniqueItems: true },
            requirements: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["id", "record_ids"], properties: { id: text,
                record_ids: { ...stringList, uniqueItems: true } } } } } } } },
  } });
const captureCommon={version:{const:1},intent_record_id:text,author:text};
const captureRecord=(type,extra={})=>define(['id','type','name','body',...Object.keys(extra)],{id:text,type:{const:type},name:text,body:text,...extra});
export const CAPTURE_DRAFT_SCHEMA=Object.freeze({oneOf:[
  define(['version','stage','intent_record_id','author','record'],{...captureCommon,stage:{const:'create'},record:{oneOf:[
    captureRecord('knowledge'),captureRecord('research',{source:text,claim:text,limitations:text}),
    captureRecord('result',{observed_outcome:text,evidence_reference:text,limitations:text})]}}),
  define(['version','stage','intent_record_id','author','record_id','context_target'],{...captureCommon,stage:{const:'associate'},record_id:text,
    context_target:{oneOf:[{type:'null'},define(['kind'],{kind:{const:'mission'}}),define(['kind','requirement_ids'],{kind:{const:'requirements'},
      requirement_ids:{...stringList,minItems:1,uniqueItems:true}})]},
    acceptance_result:define(['requirement_id','status','notes'],{requirement_id:text,status:{enum:['passed','failed','unverified']},notes:text}),
    initialize_continuation:define(['active_requirement_ids','next_action'],{active_requirement_ids:{...stringList,uniqueItems:true},next_action:text})})]});
const operationGuidance = Object.freeze({
  "work.check": { questions: ["What remains unfinished?", "Which acceptance evidence is unresolved?"],
    guidance: { purpose: "Inspect remaining work against a recorded intent.", use: "Supply the intent record ID and its project root.",
      scope: "One recorded intent at one store revision.", limits: "complete describes read completeness. ready_to_review and delta describe recorded acceptance; inspect issues and evidence before claiming the requested outcome. Recorded evidence does not run tests or certify completion.",
      recovery: "Refresh missing or incomplete intent/evidence reads before making a completion claim." } },
  get: { questions: ["What is the supporting evidence?", "Show the source and preserved history."],
    guidance: { purpose: "Inspect the exact supporting record and its source information.", use: "Supply a record ID or alias; choose history or raw when needed.",
      scope: "The selected record, including explicitly requested preserved history.", limits: "Stored claims and source locators are not independent source verification.",
      recovery: "A missing or failed read leaves supporting evidence unresolved; preserve the identifier and inspect history or raw evidence." } },
  "decision.show": { questions: ["Why was this decision made?", "What reason and direction were recorded?"],
    guidance: { purpose: "Read the recorded decision reason and attribution.", use: "Supply the project root and optional decision key.",
      scope: "Decision streams for the selected project.", limits: "Recorded reasons do not prove the decision remains suitable today.",
      recovery: "Treat absent or incomplete decision streams as unresolved; refresh the project and decision reads." } },
  find: { questions: ["Find previous research.", "What research has already been recorded?"],
    guidance: { purpose: "Find prior records before repeating research.", use: "Supply query or all; select research kind and project scope when appropriate.",
      scope: "Current records unless preserved history is explicitly selected.", limits: "Empty or partial matches do not establish freshness or external source accuracy.",
      recovery: "Inspect paging/errors, refine the query, and review the saved source and observation date before relying on research." } },
});
export function capabilityOperations({ put, delete: deletion, mutationRequest }) {
  const allIds = new Set([...Object.keys(READ_OPERATIONS), ...Object.keys(MUTATION_INPUTS),
    ...Object.keys(specialEffects)]);
  const operations = [...allIds].map((id) => {
    const argv = READ_OPERATIONS[id] ?? id.split(".");
    const command = argv[0];
    const effect = Object.hasOwn(READ_OPERATIONS, id) ? "read"
      : Object.hasOwn(MUTATION_INPUTS, id) ? "domain_write" : specialEffects[id];
    const inputSchema = id === "put" ? put : id === "delete" ? deletion : MUTATION_INPUTS[id] ?? null;
    return { id, argv, ...(operationGuidance[id] ?? {}), summary: id === "work.check"
      ? "Check a versioned intent and supplied acceptance evidence at one store revision; this does not run tests or certify claims."
      : COMMANDS[command]?.summary ?? "",
      effect, parameters: Object.hasOwn(bindings, id) ? bindings[id]
        : inputSchema ? [option("file", "--file")] : effect === "read" ? null : [],
      cli_inputs: cliInputs(id, argv, inputSchema),
      constraints: constraints[id] ?? [],
      ...(id === "work.check" ? { documentation: "docs/intent-evidence.md",
        record_schema: WORK_CHECK_RECORD_SCHEMA } : {}),
      ...(id === "work.prepare-capture" ? { draft_schema: CAPTURE_DRAFT_SCHEMA } : {}),
      context: { project: projectReads.has(id) || effect === "domain_write", actor: effect === "domain_write" },
      input_schema: inputSchema, mutation_request: inputSchema ? mutationRequest : null };
  });
  const covered = new Set(operations.map(({ argv }) => argv[0]));
  for (const command of Object.keys(COMMANDS)) if (!covered.has(command)) {
    throw new Error(`Unclassified CLI command: ${command}`);
  }
  return operations;
}
