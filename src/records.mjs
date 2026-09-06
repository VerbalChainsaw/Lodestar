import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { inspectLocalSourceSync } from "./bootstrap.mjs";
import { resolveSourceLocator } from "./paths.mjs";

import { lodestarError } from "./errors.mjs";
import {
  admittedTransaction,
  assertSupportedSchema,
  readMetadata,
  transactionRevision,
} from "./database.mjs";
import { assertJsonNumericDomain, canonicalStringify } from "./json.mjs";
import { prepareProjectRoots, resolveProjectScope, sameMachinePath, validateProjectBindings } from "./project.mjs";
import { allocateRevision, currentRevision } from "./revisions.mjs";
import { CONTRACT_VERSION } from "./schema.mjs";
import {
  FRESHNESS_STATES,
  validateContent,
  validateIdentifier,
  validatePutInput,
  validateScope,
  validateSourceMetadata,
  validateTimestamp,
} from "./validate.mjs";
const activeMutations = new WeakMap();
const identitySchema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const targetFields = { kind: { enum: ["record", "decision"] }, id: { type: "string", minLength: 1 },
  scope: { type: "string", minLength: 1 }, key: { type: "string", minLength: 1 } };
const targetRequirements = [{ properties: { kind: { const: "record" } }, required: ["kind", "id"] },
  { properties: { kind: { const: "decision" } }, required: ["kind", "scope", "key"] }];
const targetSchema = { type: "object", properties: targetFields, oneOf: targetRequirements, additionalProperties: false };
const expectedRevisionSchema = { anyOf: [{ type: "null" }, { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }] };
export const WRITE_BASIS_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  required: ["database_instance_id", "database_epoch", "project_scope", "checkout", "targets"],
  properties: { database_instance_id: identitySchema, database_epoch: identitySchema,
    project_scope: { type: ["string", "null"] }, checkout: { type: ["string", "null"] },
    targets: { type: "array", items: { type: "object", properties: { ...targetFields, expected_revision: expectedRevisionSchema },
      required: ["expected_revision"], oneOf: targetRequirements, additionalProperties: false } } } });
export const MUTATION_REQUEST_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  required: ["v", "request_id", "write_basis", "input"], properties: {
    v: { const: CONTRACT_VERSION }, request_id: { type: "string", minLength: 1 },
    write_basis: WRITE_BASIS_SCHEMA, input: { type: "object" } } });
export const CANONICAL_MUTATION_REQUEST_SCHEMA = Object.freeze({ type: "object", additionalProperties: false,
  required: ["v", "request_id", "database_instance_id", "database_epoch", "project_scope", "actor", "preconditions", "input"],
  properties: { v: { const: CONTRACT_VERSION }, request_id: { type: "string", minLength: 1 },
    database_instance_id: identitySchema, database_epoch: identitySchema,
    project_scope: { type: ["string", "null"] }, checkout: { type: ["string", "null"] },
    actor: { type: ["object", "null"], required: ["id"], additionalProperties: false, properties: {
      id: { type: "string", minLength: 1 }, agent: { type: ["string", "null"] },
      harness: { type: ["string", "null"] }, session: { type: ["string", "null"] } } },
    preconditions: { type: "array", items: { type: "object", required: ["target", "expected_revision"],
      additionalProperties: false, properties: { target: targetSchema, expected_revision: expectedRevisionSchema } } },
    input: { type: "object" } } });
function storedJson(text, validate, identifiers) {
  try {
    assertJsonNumericDomain(text);
    const value = JSON.parse(text);
    validate(value);
    return value;
  } catch (error) {
    if (error?.code === "unsupported_numeric_value") {
      throw lodestarError(
        "record_requires_source_correction",
        "The stored record contains a number outside the current numeric domain.",
        {
          identifiers: { ...identifiers, ...error.identifiers },
          action: identifiers.id
            ? `Use get ${identifiers.id} --raw, then submit a guarded replacement from the source owner.`
            : "Inspect the raw stored JSON and correct its source representation.",
          cause: error,
        },
      );
    }
    throw lodestarError(
      "database_integrity",
      "The database contains invalid stored JSON.",
      {
        identifiers,
        action: "Run lodestar doctor and restore a valid external backup.",
        cause: error,
      },
    );
  }
}
export function parseStoredContent(text, identifiers = {}) {
  return storedJson(text, validateContent, {
    field: "content_json",
    ...identifiers,
  });
}
export function parseStoredMetadata(text, identifiers = {}) {
  return storedJson(text, (value) => validateSourceMetadata(value,
    "source.metadata", { allowLegacy: true }), {
    field: "metadata_json",
    ...identifiers,
  });
}
function parsedRecord(row) {
  const stored = parseStoredContent(row.content_json, { id: row.id });
  const metadata = stored._lodestar ?? {};
  if (!metadata.semantics) throw lodestarError("record_requires_source_correction", "The record is missing current-contract semantic metadata.", {
    identifiers: { id: row.id, pointer: "/_lodestar/semantics" },
    action: `Inspect get ${row.id} --raw and use an explicit checked source correction.`,
  });
  const { _lodestar: _ignored, ...content } = stored;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    scope: row.scope,
    priority: Number(metadata.priority ?? 0),
    revision: Number(metadata.revision ?? 0),
    semantics: metadata.semantics,
    content,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
export function resolveRecordId(db, identifier) {
  validateIdentifier(identifier, "identifier");
  const exact = db.prepare(
    "SELECT id FROM records WHERE id = ?",
  ).get(identifier);
  if (exact) return exact.id;
  const alias = db.prepare(
    "SELECT record_id FROM aliases WHERE alias = ?",
  ).get(identifier);
  if (alias) return alias.record_id;
  throw lodestarError(
    "record_not_found",
    "No record or alias matched the requested identifier.",
    {
      identifiers: { requested: identifier },
      action: "Use lodestar find or inspect the repository directly.",
    },
  );
}
export function getRecordById(db, id) {
  const row = db.prepare(
    "SELECT id, type, name, scope, content_json, created_at, updated_at "
      + "FROM records WHERE id = ?",
  ).get(id);
  if (!row) {
    throw lodestarError(
      "record_not_found",
      "The requested record does not exist.",
      {
        identifiers: { id },
        action: "Use lodestar find or inspect the repository directly.",
      },
    );
  }
  return recordsByRows(db, [row])[0];
}

// One query per dependent table instead of one query per record: list paths
// (startup context, find, links, decisions, pending, work) assemble many rows
// at once, and the old id-by-id lookups made them N+1.
export const RECORD_BATCH = 900;

// Fetch many ids as normalized records in a constant number of queries,
// preserving the caller's id order. Used by find/links/start command paths
// that return full records instead of summaries.
export function normalizedRecordsByIds(db, ids) {
  if (ids.length === 0) return [];
  const byId = new Map();
  for (let offset = 0; offset < ids.length; offset += RECORD_BATCH) {
    const batch = ids.slice(offset, offset + RECORD_BATCH);
    const join = batch.map(() => "?").join(",");
    for (const row of db.prepare(
      "SELECT id, type, name, scope, content_json, created_at, updated_at "
        + `FROM records WHERE id IN (${join})`,
    ).all(...batch)) byId.set(row.id, row);
  }
  return recordsByRows(db, ids.map((id) => byId.get(id)).filter(Boolean))
    .map((record) => normalizeRecord(record));
}

export function recordsByRows(db, rows) {
  const records = new Array(rows.length);
  if (rows.length === 0) return records;
  const ids = rows.map(({ id }) => id);
  const aliases = new Map();
  const links = new Map();
  const sources = new Map();
  // One prepared statement per batch size (the tail batch may be smaller than
  // RECORD_BATCH) instead of one per batch: at 20K records that is ~2 prepares
  // per table instead of ~23.
  const aliasesStatement = new Map();
  const linksStatement = new Map();
  const sourcesStatement = new Map();
  const statementFor = (cache, sql) => (size) => {
    let stmt = cache.get(size);
    if (!stmt) {
      const join = Array(size).fill("?").join(",");
      stmt = db.prepare(sql.replaceAll("?", join));
      cache.set(size, stmt);
    }
    return stmt;
  };
  const aliasStatement = statementFor(aliasesStatement,
    "SELECT record_id, alias FROM aliases WHERE record_id IN (?) ORDER BY alias");
  const linkStatement = statementFor(linksStatement,
    "SELECT from_id, relationship, to_id, created_at FROM links "
      + "WHERE from_id IN (?) ORDER BY relationship, to_id");
  const sourceStatement = statementFor(sourcesStatement,
    "SELECT record_id, origin, freshness, metadata_json FROM sources "
      + "WHERE record_id IN (?) ORDER BY origin");
  for (let offset = 0; offset < ids.length; offset += RECORD_BATCH) {
    const batch = ids.slice(offset, offset + RECORD_BATCH);
    for (const { record_id, alias } of aliasStatement(batch.length).all(...batch)) {
      (aliases.get(record_id) ?? aliases.set(record_id, []).get(record_id)).push(alias);
    }
    for (const row of linkStatement(batch.length).all(...batch)) {
      (links.get(row.from_id) ?? links.set(row.from_id, []).get(row.from_id)).push(row);
    }
    for (const row of sourceStatement(batch.length).all(...batch)) {
      (sources.get(row.record_id) ?? sources.set(row.record_id, []).get(row.record_id)).push(row);
    }
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    records[index] = assembleRecord(db, row,
      aliases.get(row.id) ?? [],
      links.get(row.id) ?? [],
      (sources.get(row.id) ?? []).map(({ origin, freshness, metadata_json: metadataJson }) => ({
        origin,
        freshness,
        metadata: parseStoredMetadata(metadataJson, { id: row.id, origin }),
      })),
    );
  }
  return records;
}

function assembleRecord(db, row, aliases, links, sources) {
  const record = {
    ...parsedRecord(row),
    aliases,
    links,
    sources,
  };
  try {
    validateTimestamp(record.created_at, "records.created_at");
    validateTimestamp(record.updated_at, "records.updated_at");
    for (const link of links) {
      validateTimestamp(link.created_at, "links.created_at");
    }
    for (const source of sources) {
      if (!FRESHNESS_STATES.includes(source.freshness)) throw new Error();
    }
    validatePutInput({
      id: record.id,
      type: record.type,
      name: record.name,
      scope: record.scope,
      content: record.content,
      aliases,
      links: links.map(({ relationship, to_id: toId }) => ({
        relationship,
        to_id: toId,
      })),
      sources,
    });
  } catch (error) {
    if (error?.code === "database_integrity") throw error;
    throw lodestarError(
      "database_integrity",
      "The database contains an invalid record row.",
      {
        identifiers: { id: record.id },
        action: "Run lodestar doctor and restore a valid external backup.",
        cause: error,
      },
    );
  }
  return record;
}
export function getRecord(db, identifier) {
  return getRecordById(db, resolveRecordId(db, identifier));
}
function assertAliasAvailability(db, id, aliases) {
  const aliasOwner = db.prepare(
    "SELECT record_id FROM aliases WHERE alias = ?",
  );
  const recordOwner = db.prepare(
    "SELECT id FROM records WHERE id = ?",
  );
  if (aliasOwner.get(id)) {
    throw lodestarError(
      "identifier_conflict",
      "The record ID conflicts with an existing alias.",
      {
        identifiers: { id },
        action: "Choose an ID that is not already an alias.",
      },
    );
  }
  for (const alias of aliases) {
    if (alias === id) {
      throw lodestarError(
        "alias_conflict",
        "An alias cannot be identical to its owning record ID.",
        {
          identifiers: { id, alias },
          action: "Remove the redundant alias and retry.",
        },
      );
    }
    const record = recordOwner.get(alias);
    if (record) {
      throw lodestarError(
        "alias_conflict",
        "An alias conflicts with a record ID.",
        {
          identifiers: { id, alias, record_id: record.id },
          action: "Choose an alias that is not a record ID.",
        },
      );
    }
    const owner = aliasOwner.get(alias);
    if (owner && owner.record_id !== id) {
      throw lodestarError(
        "alias_conflict",
        "An alias already belongs to another record.",
        {
          identifiers: {
            id,
            alias,
            record_id: owner.record_id,
          },
          action: "Choose a globally unique alias.",
        },
      );
    }
  }
}
function replaceRecord(
  db,
  input,
  {
    createdAt,
    updatedAt,
  },
) {
  assertAliasAvailability(db, input.id, input.aliases);
  const current = db.prepare(
    "SELECT created_at FROM records WHERE id = ?",
  ).get(input.id);

  db.prepare(
    "INSERT INTO records(id, type, name, scope, content_json, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?) "
      + "ON CONFLICT(id) DO UPDATE SET "
      + "type = excluded.type, name = excluded.name, scope = excluded.scope, "
      + "content_json = excluded.content_json, updated_at = excluded.updated_at",
  ).run(
    input.id,
    input.type,
    input.name,
    input.scope,
    input.content_json,
    current?.created_at ?? createdAt,
    updatedAt,
  );

  const target = db.prepare("SELECT id FROM records WHERE id = ?");
  for (const link of input.links) {
    if (!target.get(link.to_id)) {
      throw lodestarError(
        "link_target_not_found",
        "A link target does not exist.",
        {
          identifiers: {
            id: input.id,
            relationship: link.relationship,
            to_id: link.to_id,
          },
          action: "Create the target record before adding this link.",
        },
      );
    }
  }

  const priorLinks = db.prepare("SELECT relationship,to_id FROM links WHERE from_id=?").all(input.id);
  const linkKey = (link) => canonicalStringify([link.relationship, link.to_id]);
  const desiredLinks = new Set(input.links.map(linkKey)), existingLinks = new Set(priorLinks.map(linkKey));
  for (const link of priorLinks) if (!desiredLinks.has(linkKey(link))) {
    db.prepare("DELETE FROM links WHERE from_id=? AND relationship=? AND to_id=?").run(input.id, link.relationship, link.to_id);
  }
  const priorAliases = db.prepare("SELECT alias FROM aliases WHERE record_id=?").all(input.id).map(({ alias }) => alias);
  for (const alias of priorAliases) if (!input.aliases.includes(alias)) db.prepare("DELETE FROM aliases WHERE alias=?").run(alias);
  const priorSources = new Map(db.prepare("SELECT origin,freshness,metadata_json FROM sources WHERE record_id=?").all(input.id)
    .map((source) => [source.origin, source]));
  for (const origin of priorSources.keys()) if (!input.sources.some((source) => source.origin === origin)) {
    db.prepare("DELETE FROM sources WHERE record_id=? AND origin=?").run(input.id, origin);
  }

  const insertAlias = db.prepare(
    "INSERT INTO aliases(alias, record_id) VALUES (?, ?)",
  );
  for (const alias of input.aliases) if (!priorAliases.includes(alias)) insertAlias.run(alias, input.id);

  const insertLink = db.prepare(
    "INSERT INTO links(from_id, relationship, to_id, created_at) "
      + "VALUES (?, ?, ?, ?)",
  );
  for (const link of input.links) {
    if (!existingLinks.has(linkKey(link))) insertLink.run(input.id, link.relationship, link.to_id, updatedAt);
  }

  const insertSource = db.prepare(
    "INSERT INTO sources(record_id, origin, freshness, metadata_json) "
      + "VALUES (?, ?, ?, ?) ON CONFLICT(record_id,origin) DO UPDATE SET freshness=excluded.freshness, metadata_json=excluded.metadata_json",
  );
  for (const source of input.sources) {
    const prior = priorSources.get(source.origin);
    if (prior && prior.freshness === source.freshness
      && canonicalStringify(parseStoredMetadata(prior.metadata_json, { id: input.id, origin: source.origin })) === canonicalStringify(source.metadata)) continue;
    insertSource.run(
      input.id,
      source.origin,
      source.freshness,
      source.metadata_json,
    );
  }
}
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function invalidMutation(message, identifiers = {}) {
  throw lodestarError("invalid_mutation_contract", message, {
    identifiers,
    action: "Upgrade the caller and submit the complete Lodestar contract-5 mutation.",
  });
}

function exactKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) invalidMutation(`${field} contains unsupported fields.`, {
    field,
    unsupported: unknown.sort(),
  });
}

function normalizedTarget(target, field) {
  if (!plain(target)) invalidMutation(`${field} must be an object.`, { field });
  if (target.kind === "record") {
    exactKeys(target, ["kind", "id"], field);
    validateIdentifier(target.id, `${field}.id`);
    return { kind: "record", id: target.id };
  }
  if (target.kind === "decision") {
    exactKeys(target, ["kind", "scope", "key"], field);
    validateScope(target.scope, `${field}.scope`);
    validateIdentifier(target.key, `${field}.key`);
    if (target.key.trim() !== target.key) {
      invalidMutation("Decision keys cannot have leading or trailing whitespace.", { field });
    }
    return { kind: "decision", scope: target.scope, key: target.key };
  }
  invalidMutation(`${field}.kind is unsupported.`, { field, kind: target.kind ?? null });
}

function targetKey(target) {
  return canonicalStringify(target);
}

export function normalizeMutationRequest(value, { actor = null } = {}) {
  if (!plain(value) || value.v !== CONTRACT_VERSION) {
    invalidMutation("The mutation must use Lodestar contract version 5.", {
      expected: CONTRACT_VERSION,
      actual: value?.v ?? null,
    });
  }
  let request = value;
  if (Object.hasOwn(value, "write_basis")) {
    exactKeys(value, ["v", "request_id", "write_basis", "input"], "request");
    const basis = value.write_basis;
    if (!plain(basis)) invalidMutation("write_basis must be an object.");
    exactKeys(basis, Object.keys(WRITE_BASIS_SCHEMA.properties), "write_basis");
    request = {
      v: CONTRACT_VERSION,
      request_id: value.request_id,
      database_instance_id: basis.database_instance_id,
      database_epoch: basis.database_epoch,
      project_scope: basis.project_scope ?? null,
      checkout: basis.checkout ?? null,
      actor,
      preconditions: (basis.targets ?? []).map((entry, index) => {
        if (!plain(entry) || !Object.hasOwn(entry, "expected_revision")) {
          invalidMutation("Each write-basis target needs expected_revision.", { index });
        }
        const { expected_revision: expectedRevision, ...target } = entry;
        return { target: normalizedTarget(target, `write_basis.targets[${index}]`),
          expected_revision: expectedRevision };
      }),
      input: value.input,
    };
  }
  exactKeys(request, ["v", "request_id", "database_instance_id", "database_epoch",
    "project_scope", "checkout", "actor", "preconditions", "input"], "request");
  validateIdentifier(request.request_id, "request_id");
  if (!/^[0-9a-f]{64}$/u.test(request.database_instance_id ?? "")) {
    invalidMutation("database_instance_id must be a complete 64-character hexadecimal ID.");
  }
  if (!/^[0-9a-f]{64}$/u.test(request.database_epoch ?? "")) {
    invalidMutation("database_epoch must be a complete 64-character hexadecimal ID.");
  }
  if (request.project_scope !== null) validateScope(request.project_scope, "project_scope");
  if ((request.checkout ?? null) !== null) validateIdentifier(request.checkout, "checkout");
  if (request.actor !== null && !plain(request.actor)) {
    invalidMutation("actor must be null or an object.");
  }
  if (request.actor) {
    exactKeys(request.actor, ["id", "agent", "harness", "session"], "actor");
    validateIdentifier(request.actor.id, "actor.id");
    for (const field of ["agent", "harness", "session"]) if (request.actor[field] != null) validateIdentifier(request.actor[field], `actor.${field}`);
  }
  if (!Array.isArray(request.preconditions)) {
    invalidMutation("preconditions must be an array.");
  }
  const preconditions = request.preconditions.map((entry, index) => {
    if (!plain(entry)) invalidMutation("A precondition must be an object.", { index });
    exactKeys(entry, ["target", "expected_revision"], `preconditions[${index}]`);
    const expected = entry.expected_revision;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) {
      invalidMutation("expected_revision must be null or a positive safe integer.", { index });
    }
    return { target: normalizedTarget(entry.target, `preconditions[${index}].target`),
      expected_revision: expected };
  });
  const duplicates = new Set();
  for (const entry of preconditions) {
    const key = targetKey(entry.target);
    if (duplicates.has(key)) invalidMutation("A precondition target is duplicated.", { target: entry.target });
    duplicates.add(key);
  }
  if (!plain(request.input)) invalidMutation("input must be an object.");
  canonicalStringify(request.input);
  return { ...request, checkout: request.checkout ?? null,
    actor: request.actor ?? actor, preconditions };
}

function rawAssociations(db, id) {
  return {
    aliases: db.prepare("SELECT alias, record_id FROM aliases WHERE record_id=? ORDER BY alias")
      .all(id),
    links: db.prepare("SELECT from_id, relationship, to_id, created_at FROM links "
      + "WHERE from_id=? OR to_id=? ORDER BY from_id, relationship, to_id").all(id, id),
    sources: db.prepare("SELECT record_id, origin, freshness, metadata_json FROM sources "
      + "WHERE record_id=? ORDER BY origin").all(id),
  };
}

function rawRecordById(db, id) {
  return db.prepare("SELECT id,type,name,scope,content_json,created_at,updated_at "
    + "FROM records WHERE id=?").get(id) ?? null;
}

function beforeImage(db, id) {
  const row = rawRecordById(db, id);
  return row ? { raw_record: row, raw_associations: rawAssociations(db, id) } : null;
}

function targetRevision(db, target) {
  if (target.kind === "record") {
    const row = db.prepare("SELECT id, json_extract(content_json, '$._lodestar.revision') "
      + "AS revision FROM records WHERE id=?").get(target.id);
    if (!row) return null;
    const revision = Number(row.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw lodestarError("database_integrity",
        "The stored record is missing its core revision metadata.", {
          identifiers: { id: target.id, revision: row.revision ?? null },
          action: "Run lodestar doctor and inspect the record raw.",
        });
    }
    return revision;
  }
  const rows = db.prepare("SELECT content_json FROM records WHERE type='decision-event' "
    + "AND scope=? ORDER BY CAST(json_extract(content_json, '$._lodestar.revision') AS INTEGER), id")
    .all(target.scope);
  let revision = null;
  for (const row of rows) {
    const content = parseStoredContent(row.content_json);
    if (contentData(content)?.key === target.key) {
      const candidate = Number(content._lodestar?.revision ?? 0);
      if (Number.isSafeInteger(candidate) && candidate > (revision ?? 0)) {
        revision = candidate;
      }
    }
  }
  return revision;
}

export function writeBasis(db, {
  projectScope = null,
  checkout = null,
  targets = [],
} = {}) {
  const metadata = readMetadata(db);
  const binding = resolveProjectScope(db, projectScope, checkout);
  const distinct = [...new Map([...targets, ...(binding?.binding_preconditions ?? []).map(({ target }) => target)].map((target, index) => {
    const normalized = normalizedTarget(target, `targets[${index}]`);
    return [targetKey(normalized), normalized];
  })).values()];
  return {
    database_instance_id: metadata.database_instance_id,
    database_epoch: metadata.database_epoch,
    project_scope: binding?.scope ?? projectScope,
    checkout,
    targets: distinct.map((target) => ({
      ...target,
      expected_revision: targetRevision(db, target),
    })),
  };
}

function receiptId(request) {
  return `mutation-receipt:${createHash("sha256")
    .update(canonicalStringify([
      request.database_instance_id,
      request.database_epoch,
      request.request_id,
    ])).digest("hex")}`;
}

function storedReceipt(db, id) {
  const row = rawRecordById(db, id);
  if (!row) return null;
  const record = parseStoredContent(row.content_json, { id });
  if (row.type !== "mutation-receipt") {
    throw lodestarError("database_integrity", "A mutation receipt ID is owned by another record type.", {
      identifiers: { id, type: row.type },
    });
  }
  return contentData(record);
}

export function mutate(db, operation, value, callback, {
  database = null,
  now = () => new Date(),
  requiredTargets = [],
  actor = null,
  project = null,
  resolveBinding = false,
} = {}) {
  validateIdentifier(operation, "operation");
  if (typeof callback !== "function" || callback.constructor?.name === "AsyncFunction") {
    invalidMutation("Mutation callbacks must be synchronous.");
  }
  const request = normalizeMutationRequest(value, { actor });
  const payloadHash = createHash("sha256")
    .update(canonicalStringify([operation, request])).digest("hex");
  const id = receiptId(request);
  return admittedTransaction(db, () => {
    assertSupportedSchema(db, database);
    const metadata = readMetadata(db, database);
    const revisionBefore = currentRevision(db);
    if (metadata.database_instance_id !== request.database_instance_id) {
      throw lodestarError("database_instance_conflict", "The request belongs to another database instance.", {
        identifiers: { expected: request.database_instance_id,
          actual: metadata.database_instance_id, request_id: request.request_id },
        action: "Refresh the record and submit a new logical request against this database.",
      });
    }
    if (metadata.database_epoch !== request.database_epoch) {
      throw lodestarError("database_epoch_conflict", "The request belongs to another database recovery epoch.", {
        identifiers: { expected: request.database_epoch,
          actual: metadata.database_epoch, request_id: request.request_id },
        action: "Refresh the record after recovery and submit a new logical request.",
      });
    }
    const receipt = storedReceipt(db, id);
    if (receipt) {
      if (receipt.payload_sha256 !== payloadHash) {
        throw lodestarError("request_conflict", "The request ID was already accepted with different input.", {
          identifiers: { request_id: request.request_id, receipt_id: id },
          action: "Replay the exact original request or use a new request ID for changed meaning.",
        });
      }
      return {
        ...receipt.result,
        request: { id: request.request_id, replayed: true,
          committed_revision: receipt.committed_revision },
        receipt_id: id,
        revision: receipt.committed_revision,
      };
    }
    const effectiveProject = resolveBinding ? resolveProjectScope(db, request.project_scope, request.checkout) : project;
    if (effectiveProject && (request.project_scope !== effectiveProject.scope
      || (request.checkout !== null && !sameMachinePath(request.checkout, effectiveProject.checkout_root)))) {
      throw lodestarError("project_binding_conflict", "The request no longer matches the resolved project or checkout.", {
        identifiers: { requested: request.project_scope, current: effectiveProject.scope,
          requested_checkout: request.checkout, current_checkout: effectiveProject.checkout_root },
        action: "Read current context and prepare the affected update again.",
      });
    }
    const supplied = new Map(request.preconditions.map((entry) => [
      targetKey(entry.target), entry,
    ]));
    const needed = [...requiredTargets, ...(effectiveProject?.binding_preconditions ?? []).map(({ target }) => target)];
    const missing = needed.map((target, index) =>
      normalizedTarget(target, `requiredTargets[${index}]`))
      .filter((target) => !supplied.has(targetKey(target)));
    if (missing.length) {
      throw lodestarError("missing_precondition", "The mutation is missing required target preconditions.", {
        identifiers: {
          request_id: request.request_id,
          required_basis: writeBasis(db, { projectScope: request.project_scope, targets: missing }),
        },
        action: "Refresh the named targets and retry with a new logical request.",
      });
    }
    for (const entry of request.preconditions) {
      const actual = targetRevision(db, entry.target);
      if (actual !== entry.expected_revision) {
        throw lodestarError("revision_conflict", "A mutation target changed after it was read.", {
          identifiers: { request_id: request.request_id, target: entry.target,
            expected_revision: entry.expected_revision, actual_revision: actual,
            write_basis: writeBasis(db, { projectScope: request.project_scope,
              targets: [entry.target] }) },
          action: "Review the changed target and submit a new logical request.",
        });
      }
    }
    const captures = new Map(request.preconditions
      .filter(({ target }) => target.kind === "record")
      .map(({ target }) => [target.id, beforeImage(db, target.id)]));
    const revision = allocateRevision(db);
    const timestamp = now().toISOString();
    validateTimestamp(timestamp, "timestamp");
    if (activeMutations.has(db)) {
      throw lodestarError("invalid_transaction",
        "A domain callback cannot start another logical mutation.");
    }
    activeMutations.set(db, request);
    let callbackResult;
    try {
      callbackResult = callback({ request, revision, timestamp });
    } finally {
      activeMutations.delete(db);
    }
    if (callbackResult && typeof callbackResult.then === "function") {
      invalidMutation("Mutation callbacks must be synchronous.");
    }
    const data = plain(callbackResult) && Object.hasOwn(callbackResult, "data")
      ? callbackResult.data : callbackResult;
    const changedIds = plain(callbackResult) && Array.isArray(callbackResult.changed_ids)
      ? callbackResult.changed_ids : [];
    const beforeImages = changedIds.map((changedId) => captures.get(changedId))
      .filter(Boolean);
    const accepted = { data };
    canonicalStringify(accepted);
    const receiptData = {
      request_id: request.request_id,
      database_epoch: request.database_epoch,
      operation,
      payload_sha256: payloadHash,
      committed_revision: revision,
      result: accepted,
      changed_ids: changedIds,
      before_images: beforeImages,
      database_revision_before: revisionBefore,
    };
    writeRecordSnapshot(db, {
      id,
      type: "mutation-receipt",
      name: `Mutation receipt ${request.request_id}`,
      scope: request.project_scope ?? "global",
      content: { state: "known", value: receiptData },
      aliases: [], links: [], sources: [],
    }, { createdAt: timestamp, updatedAt: timestamp, revision });
    return {
      data,
      request: { id: request.request_id, replayed: false,
        committed_revision: revision },
      receipt_id: id,
      revision,
    };
  }, database);
}

export function writeRecordSnapshot(db, value, {
  createdAt, updatedAt, revision,
}) {
  const immutable = ["decision-event", "work-event", "handoff-packet", "mutation-receipt", "migration-source"].includes(value.type);
  if (immutable && rawRecordById(db, value.id)) throw lodestarError("record_collision", "An immutable event ID already exists; the transaction was rolled back.", {
    identifiers: { id: value.id, kind: value.type }, action: "Inspect the conflicting record; never replace it implicitly.",
  });
  const priority = value.priority === undefined ? 0 : value.priority;
  if (!Number.isSafeInteger(priority)) invalidMutation("Record priority must be a safe integer.");
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw lodestarError("invalid_transaction",
      "A record write requires a positive transaction revision.");
  }
  if (transactionRevision(db) !== revision) {
    throw lodestarError(
      "invalid_transaction",
      "A record snapshot requires the admitted mutation revision.",
    );
  }
  const { priority: _priority, semantics: suppliedSemantics, ...validatedValue } = value;
  const semantics = validatedValue.semantics
    ?? suppliedSemantics
    ?? validatedValue.content?._lodestar?.semantics
    ?? { lifecycle: immutable ? "historical" : "current", context_role: "on_demand", basis: "asserted",
      applicability: { project: value.scope, checkout: null } };
  const content = { ...validatedValue.content };
  delete content._lodestar;
  const input = validatePutInput({
    ...validatedValue,
    content: {
      ...content,
      _lodestar: { priority, revision, ...(semantics ? { semantics } : {}) },
    },
  });
  replaceRecord(db, input, { createdAt, updatedAt });
  return input.id;
}

function internalRecord(value) {
  if (!plain(value)) invalidMutation("record must be an object.");
  exactKeys(value, ["id", "kind", "name", "scope", "availability", "priority",
    "data", "aliases", "links", "sources", "semantics", "v", "revision",
    "created_at", "updated_at", "write_basis"], "record");
  for (const field of ["id", "kind", "name", "scope", "data", "aliases",
    "links", "sources"]) {
    if (!Object.hasOwn(value, field)) invalidMutation(`record.${field} is required.`);
  }
  return {
    id: value.id,
    type: value.kind,
    name: value.name,
    scope: value.scope,
    priority: value.priority === undefined ? 0 : value.priority,
    content: { state: value.availability ?? "unknown", value: value.data ?? {} },
    aliases: value.aliases ?? [],
    links: value.links ?? [],
    sources: value.sources ?? [],
    semantics: value.semantics ?? {
      lifecycle: "current",
      context_role: "on_demand",
      basis: "asserted",
      applicability: { project: value.scope, checkout: null },
    },
  };
}

function assertOrdinaryType(type) {
  if (["work", "work-event", "decision-event", "migration-source",
    "mutation-receipt", "pending", "startup-snapshot", "handoff",
    "handoff-packet"].includes(type) || type?.startsWith("handoff-")) {
    throw lodestarError(
      "reserved_record_type",
      "This record type is owned by a Lodestar command family.",
      { identifiers: { type } },
    );
  }
}

function assertSubjectAvailable(db, record) {
  const semantics = record.semantics;
  if (!semantics?.subject || semantics.lifecycle !== "current") return;
  const rows = db.prepare("SELECT id,json_extract(content_json,'$._lodestar.semantics') semantics_json FROM records WHERE id<>? "
    + "AND json_extract(content_json,'$._lodestar.semantics.subject')=? "
    + "AND json_extract(content_json,'$._lodestar.semantics.lifecycle')='current'").all(record.id, semantics.subject);
  const conflicting = [];
  for (const row of rows) {
    assertJsonNumericDomain(row.semantics_json);
    const other = JSON.parse(row.semantics_json);
    if (canonicalStringify(other.applicability ?? null) === canonicalStringify(semantics.applicability ?? null)) conflicting.push(row.id);
  }
  if (conflicting.length) {
    throw lodestarError("subject_conflict", "Another current record owns this subject and applicability.", {
      identifiers: { id: record.id, subject: semantics.subject,
        conflicting_ids: conflicting,
        write_basis: writeBasis(db, { projectScope: record.scope,
          targets: conflicting.map((id) => ({ kind: "record", id })) }) },
      action: "Review the existing current record and submit an explicit successor/update.",
    });
  }
}

function updateRecordValue(current, input) {
  const allowedSet = ["name", "availability", "priority", "data", "aliases",
    "links", "sources", "semantics"];
  exactKeys(input, ["mode", "id", "set", "remove"], "input");
  if (!plain(input.set) || !Array.isArray(input.remove)) {
    invalidMutation("update requires object set and array remove fields.");
  }
  exactKeys(input.set, allowedSet, "input.set");
  const overlap = input.remove.filter((key) => Object.hasOwn(input.set.data ?? {}, key));
  if (overlap.length) invalidMutation("data set/remove fields overlap.", { overlap });
  if (!plain(current.data) && (Object.hasOwn(input.set, "data") || input.remove.length)) {
    invalidMutation("Targeted data updates require object data; use explicit replace for a scalar or array.");
  }
  const data = plain(current.data) ? { ...current.data } : current.data;
  if (Object.hasOwn(input.set, "data")) {
    if (!plain(input.set.data)) invalidMutation("input.set.data must be an object.");
    Object.assign(data, input.set.data);
  }
  for (const key of input.remove) delete data[key];
  return internalRecord({
    ...current,
    ...input.set,
    id: current.id,
    kind: current.kind,
    scope: current.scope,
    data,
  });
}

export function preparePutEvidence(db, input, value) {
  const request = normalizeMutationRequest(value);
  // Replay is settled under admission before applying any input. Its original
  // result remains available even if the source has since moved or disappeared.
  if (storedReceipt(db, receiptId(request))) return {};
  const projectRoots = prepareProjectRoots(db, input);
  const current = input.mode === "update" ? normalizeRecord(getRecordById(db, input.id)) : null;
  const record = current ? updateRecordValue(current, input) : internalRecord(input.record);
  const evidence = [];
  const sourceBindings = [];
  const project = resolveProjectScope(db, request.project_scope, request.checkout) ?? {};
  if (project.id) {
    const data = normalizeRecord(getRecordById(db, project.id)).data;
    project.root = data.roots?.[0] ?? data.root;
  }
  let sourceRoots = {};
  for (const source of record.sources ?? []) {
    const metadata = source.metadata;
    if (metadata.relation !== "content_owner" || !["local_file", "package_manifest"].includes(metadata.kind)) continue;
    validateSourceMetadata(metadata);
    if (metadata.locator.base === "source_root") {
      const configRow = rawRecordById(db, "config:lodestar:sources");
      const config = configRow ? normalizeRecord(getRecordById(db, configRow.id)).data : {};
      sourceBindings.push({ target: { kind: "record", id: "config:lodestar:sources" },
        expected_revision: configRow ? normalizeRecord(getRecordById(db, configRow.id)).revision : null });
      sourceRoots = Object.fromEntries((config.skill_source_roots ?? []).map((source) => [source.id, source.locator]));
    }
    const located = resolveSourceLocator(metadata.locator, { project, sourceRoots });
    const actual = inspectLocalSourceSync(located.path);
    let contained = true;
    if (located.root && actual.status === "observed") {
      const relative = path.relative(realpathSync.native(located.root), actual.path);
      contained = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }
    if (!contained || actual.status !== "observed" || actual.sha256 !== metadata.fingerprint.value
      || actual.bytes !== metadata.fingerprint.bytes) {
      throw lodestarError("needs_reinspection", "The current content owner no longer matches the inspected source.", {
        identifiers: { id: record.id, origin: source.origin, path: located.path, status: actual.status },
        action: "Read the source again and prepare the update from its current bytes.",
      });
    }
    evidence.push(canonicalStringify(source));
  }
  return { projectRoots, sourceEvidence: evidence, sourceBindings };
}

export function putRecord(db, value, options = {}) {
  const input = value?.input;
  const mode = input?.mode;
  if (!["create", "update", "replace"].includes(mode)) {
    invalidMutation("put input.mode must be create, update, or replace.");
  }
  const id = mode === "update" ? input.id : input?.record?.id;
  validateIdentifier(id, "input.id");
  const prepared = preparePutEvidence(db, input, value);
  return mutate(db, "put", value, ({ revision, timestamp }) => {
    const data = applyPutInput(db, input, { revision, timestamp, ...prepared });
    return { data, changed_ids: data.revision === revision ? [id] : [] };
  }, { ...options, resolveBinding: true, requiredTargets: [{ kind: "record", id }] });
}

export function applyPutInput(db, input, {
  revision,
  timestamp,
  projectRoots,
  sourceEvidence,
  sourceBindings = [],
}) {
  const mode = input?.mode;
  if (!["create", "update", "replace"].includes(mode)) {
    invalidMutation("put input.mode must be create, update, or replace.");
  }
  const id = mode === "update" ? input.id : input?.record?.id;
  const existing = rawRecordById(db, id);
  if (mode === "create" && /^(?:decision:|work-event:|handoff-packet:|mutation-receipt:|migration-source:|startup-snapshot:)/u.test(id)) {
    throw lodestarError("reserved_record_type", "This ID namespace belongs to immutable Lodestar history.", { identifiers: { id } });
  }
  if (mode === "create" && existing) throw lodestarError("record_exists", "Create requires an absent record ID.", { identifiers: { id } });
  if (mode === "replace" && !existing) throw lodestarError("record_not_found", "Replace requires an existing record ID.", { identifiers: { id } });
  let record;
  if (mode === "update") {
    record = updateRecordValue(normalizeRecord(getRecordById(db, id)), input);
  } else {
    exactKeys(input, ["mode", "record"], "input");
    record = internalRecord(input.record);
    if (mode === "replace" && (!Object.hasOwn(input.record, "aliases")
      || !Object.hasOwn(input.record, "links")
      || !Object.hasOwn(input.record, "sources"))) {
      invalidMutation("replace requires complete aliases, links, and sources.");
    }
  }
  assertOrdinaryType(record.type);
  if (record.type === "project") {
    if (!projectRoots || !Object.hasOwn(projectRoots, "roots")) throw lodestarError("invalid_transaction", "Project root evidence must be prepared before the transaction.");
    if (projectRoots.roots !== null) record.content.value.roots = projectRoots.roots;
  }
  for (const source of record.sources ?? []) {
    if (source.metadata.relation === "content_owner" && ["local_file", "package_manifest"].includes(source.metadata.kind)
      && !sourceEvidence?.includes(canonicalStringify(source))) {
      throw lodestarError("needs_reinspection", "Current content-owner evidence must be inspected before admission.");
    }
  }
  const request = activeMutations.get(db);
  if (!request) {
    throw lodestarError("invalid_transaction",
      "Generic record changes require an active admitted mutation.");
  }
  for (const binding of sourceBindings) {
    const supplied = request.preconditions.find(({ target }) => targetKey(target) === targetKey(binding.target));
    if (!supplied || supplied.expected_revision !== binding.expected_revision) {
      throw lodestarError("missing_precondition", "The source-root configuration needs its inspected revision in the write basis.", {
        identifiers: { required_basis: writeBasis(db, { projectScope: request.project_scope, targets: [binding.target] }) },
        action: "Read the source configuration and prepare the update from that basis.",
      });
    }
  }
  const applicability = record.semantics?.applicability;
  if (request.project_scope !== null
    && applicability?.project !== request.project_scope) {
    throw lodestarError("invalid_input",
      "Record applicability does not match the mutation project scope.", {
        identifiers: { id, expected: request.project_scope,
          actual: applicability?.project ?? null },
      });
  }
  if (applicability?.checkout !== null && applicability?.checkout !== undefined
    && (request.checkout === null || !sameMachinePath(applicability.checkout, request.checkout))) {
    throw lodestarError("invalid_input",
      "Record applicability does not match the observed checkout basis.", {
        identifiers: { id, expected: request.checkout,
          actual: applicability?.checkout ?? null },
      });
  }
  assertSubjectAvailable(db, record);
  if (mode === "create" && record.type !== "project" && request.project_scope !== null
    && record.scope !== request.project_scope && record.scope !== "global") {
    throw lodestarError("project_binding_conflict", "New facts must use the resolved canonical project scope.");
  }
  if (existing && mode !== "replace") {
    const prior = normalizeRecord(getRecordById(db, id));
    if (canonicalStringify(internalRecord(prior)) === canonicalStringify(record)) return prior;
  } else if (existing) {
    try {
      const prior = normalizeRecord(getRecordById(db, id));
      if (canonicalStringify(internalRecord(prior)) === canonicalStringify(record)) return prior;
    } catch (error) { if (error.code !== "record_requires_source_correction") throw error; }
  }
  writeRecordSnapshot(db, record, { createdAt: existing?.created_at ?? timestamp,
    updatedAt: timestamp, revision });
  if (record.type === "project") {
    const required = validateProjectBindings(db, id, projectRoots);
    const supplied = new Set(request.preconditions.map(({ target }) => targetKey(target)));
    const missing = required.filter((target) => !supplied.has(targetKey(target)));
    if (missing.length) throw lodestarError("missing_precondition", "Project reconciliation requires every binding target revision.", {
      identifiers: { required_basis: writeBasis(db, { projectScope: request.project_scope, targets: missing }) },
      action: "Read the source and canonical project targets and prepare the mapping again.",
    });
  }
  return normalizeRecord(getRecordById(db, id));
}

function countRows(db, sql, ...values) {
  return Number(db.prepare(sql).get(...values).count);
}

export function deleteRecord(db, value, options = {}) {
  const input = value?.input;
  exactKeys(input ?? {}, ["id", "reason"], "input");
  validateIdentifier(input?.id, "input.id");
  validateIdentifier(input?.reason, "input.reason");
  return mutate(db, "delete", value, ({ revision, timestamp }) => {
    const current = normalizeRecord(getRecordById(db, input.id));
    assertOrdinaryType(current.kind);
    const semantics = {
      ...(current.semantics ?? {}),
      lifecycle: "historical",
      retirement_reason: input.reason,
    };
    if (canonicalStringify(current.semantics) === canonicalStringify(semantics)) {
      return { data: { id: input.id, retired: true, reason: input.reason, changed: false }, changed_ids: [] };
    }
    writeRecordSnapshot(db, internalRecord({ ...current, semantics }), {
      createdAt: current.created_at,
      updatedAt: timestamp,
      revision,
    });
    return { data: { id: input.id, retired: true, reason: input.reason },
      changed_ids: [input.id] };
  }, { ...options, resolveBinding: true, requiredTargets: [{ kind: "record", id: input.id }] });
}

export function normalizeRecord(record) {
  const value = contentData(record.content);
  const data = value;
  return { v: CONTRACT_VERSION, id: record.id, kind: record.type,
    name: record.name, scope: record.scope,
    availability: record.content.state, priority: record.priority,
    revision: record.revision, created_at: record.created_at,
    updated_at: record.updated_at, data, aliases: record.aliases,
    links: record.links.map(({ relationship, to_id: toId }) =>
      ({ relationship, to_id: toId })), sources: record.sources,
    semantics: record.semantics };
}

export function getRawRecord(db, identifier) {
  const id = resolveRecordId(db, identifier);
  const rawRecord = rawRecordById(db, id);
  return {
    raw_record: rawRecord,
    raw_associations: rawAssociations(db, id),
    write_basis: writeBasis(db, {
      projectScope: rawRecord.scope,
      targets: [{ kind: "record", id }],
    }),
  };
}

export function getRecordHistory(db, identifier) {
  const id = resolveRecordId(db, identifier);
  const versions = [];
  const receipts = db.prepare("SELECT id,content_json FROM records "
    + "WHERE type IN ('mutation-receipt','migration-source') "
    + "ORDER BY CAST(json_extract(content_json, '$._lodestar.revision') AS INTEGER), id")
    .all();
  for (const receipt of receipts) {
    const data = contentData(parseStoredContent(receipt.content_json, { id: receipt.id }));
    for (let sequence = 0; sequence < (data.before_images ?? []).length; sequence += 1) {
      const image = data.before_images[sequence];
      if (image.raw_record?.id === id) versions.push({
        revision: data.committed_revision ?? data.destination?.revision,
        sequence,
        receipt_id: receipt.id,
        ...image,
      });
    }
  }
  return {
    id,
    versions,
    current: beforeImage(db, id),
    write_basis: writeBasis(db, {
      projectScope: rawRecordById(db, id)?.scope ?? null,
      targets: [{ kind: "record", id }],
    }),
  };
}

export function contentData(content) {
  if (Object.hasOwn(content, "value")) return content.value;
  const { state: _state, ...data } = content;
  return data;
}
