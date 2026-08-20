import { lodestarError } from "./errors.mjs";
import { transaction } from "./database.mjs";
import { allocateRevision } from "./revisions.mjs";
import {
  FRESHNESS_STATES,
  validateContent,
  validateIdentifier,
  validatePutInput,
  validateSourceMetadata,
  validateTimestamp,
} from "./validate.mjs";
function storedJson(text, validate, identifiers) {
  try {
    const value = JSON.parse(text);
    validate(value);
    return value;
  } catch (error) {
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
  return storedJson(text, validateSourceMetadata, {
    field: "metadata_json",
    ...identifiers,
  });
}
function parsedRecord(row) {
  const stored = parseStoredContent(row.content_json, { id: row.id });
  const metadata = stored._lodestar ?? {};
  const { _lodestar: _ignored, ...content } = stored;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    scope: row.scope,
    priority: Number(metadata.priority ?? 0),
    revision: Number(metadata.revision ?? 0),
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
  const aliases = db.prepare(
    "SELECT alias FROM aliases WHERE record_id = ? ORDER BY alias",
  ).all(id).map(({ alias }) => alias);
  const links = db.prepare(
    "SELECT relationship, to_id, created_at FROM links "
      + "WHERE from_id = ? ORDER BY relationship, to_id",
  ).all(id);
  const sources = db.prepare(
    "SELECT origin, freshness, metadata_json FROM sources "
      + "WHERE record_id = ? ORDER BY origin",
  ).all(id)
    .map(({ origin, freshness, metadata_json: metadataJson }) => ({
    origin,
    freshness,
    metadata: parseStoredMetadata(metadataJson, { id, origin }),
  }));
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
        identifiers: { id },
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

  db.prepare("DELETE FROM links WHERE from_id = ?").run(input.id);
  db.prepare("DELETE FROM aliases WHERE record_id = ?").run(input.id);
  db.prepare("DELETE FROM sources WHERE record_id = ?").run(input.id);

  const insertAlias = db.prepare(
    "INSERT INTO aliases(alias, record_id) VALUES (?, ?)",
  );
  for (const alias of input.aliases) insertAlias.run(alias, input.id);

  const insertLink = db.prepare(
    "INSERT INTO links(from_id, relationship, to_id, created_at) "
      + "VALUES (?, ?, ?, ?)",
  );
  for (const link of input.links) {
    insertLink.run(input.id, link.relationship, link.to_id, updatedAt);
  }

  const insertSource = db.prepare(
    "INSERT INTO sources(record_id, origin, freshness, metadata_json) "
      + "VALUES (?, ?, ?, ?)",
  );
  for (const source of input.sources) {
    insertSource.run(
      input.id,
      source.origin,
      source.freshness,
      source.metadata_json,
    );
  }
}
export function putRecord(db, value, {
  now = () => new Date(), database = null,
} = {}) {
  if (value?.type === "work" || value?.type === "decision-event"
      || value?.type === "migration-source" || value?.type?.startsWith("handoff-")) {
    throw lodestarError(
      "reserved_record_type",
      "This record type is owned by a Lodestar command family.",
      { identifiers: { type: value.type } },
    );
  }
  const timestamp = now().toISOString();
  transaction(db, () => writeRecordSnapshot(db, value, {
    createdAt: timestamp, updatedAt: timestamp, revision: allocateRevision(db),
  }), database);
  return getRecordById(db, value.id);
}

export function writeRecordSnapshot(db, value, {
  createdAt, updatedAt, revision,
}) {
  const priorityValue = value.priority ?? value.content?.value?.priority ?? 0;
  const priority = Number.isSafeInteger(priorityValue) ? priorityValue : 0;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw lodestarError("invalid_transaction",
      "A record write requires a positive transaction revision.");
  }
  const { priority: _priority, ...validatedValue } = value;
  const input = validatePutInput({
    ...validatedValue,
    content: { ...validatedValue.content, _lodestar: { priority, revision } },
  });
  replaceRecord(db, input, { createdAt, updatedAt });
  return input.id;
}

function countRows(db, sql, ...values) {
  return Number(db.prepare(sql).get(...values).count);
}

export function deleteRecord(db, identifier, { database = null } = {}) {
  return transaction(db, () => {
    const revision = allocateRevision(db);
    const id = resolveRecordId(db, identifier);
    const owned = db.prepare("SELECT type FROM records WHERE id=?").get(id);
    if (owned?.type === "work" || owned?.type === "decision-event"
        || owned?.type === "migration-source" || owned?.type?.startsWith("handoff-")) {
      throw lodestarError(
        "reserved_record_type",
        "Use the owning Lodestar command family instead of deleting this record.",
        { identifiers: { id, type: owned.type } },
      );
    }
    const deleted = {
      records: 1,
      aliases: countRows(db,
        "SELECT count(*) AS count FROM aliases WHERE record_id = ?", id),
      sources: countRows(db,
        "SELECT count(*) AS count FROM sources WHERE record_id = ?", id),
      links: countRows(db, "SELECT count(*) AS count FROM links "
        + "WHERE from_id = ? OR to_id = ?", id, id),
    };
    db.prepare("DELETE FROM records WHERE id = ?").run(id);
    return { id, deleted, revision };
  }, database);
}

export function normalizeRecord(record) {
  const value = contentData(record.content);
  const data = value && Object.getPrototypeOf(value) === Object.prototype
    ? { name: record.name, ...value, aliases: record.aliases }
    : { name: record.name, value, aliases: record.aliases };
  return { v: 1, id: record.id, kind: record.type, scope: record.scope,
    availability: record.content.state, priority: record.priority,
    revision: record.revision, updated_at: record.updated_at, data,
    links: record.links.map(({ relationship, to_id: toId }) =>
      ({ relationship, to_id: toId })), sources: record.sources };
}

export function contentData(content) {
  if (Object.hasOwn(content, "value")) return content.value;
  const { state: _state, ...data } = content;
  return data;
}

export function coercePutRecord(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (value.content !== undefined) return value;
  if (value.v !== 1 || typeof value.kind !== "string" || value.data === undefined) return value;
  const data = value.data && Object.getPrototypeOf(value.data) === Object.prototype
    ? { ...value.data }
    : { value: value.data };
  const name = typeof data.name === "string" ? data.name : value.id;
  const aliases = Array.isArray(data.aliases) ? data.aliases : [];
  delete data.name;
  delete data.aliases;
  return { id: value.id, type: value.kind, name, scope: value.scope,
    priority: value.priority ?? 0,
    content: { state: value.availability ?? "known", value: data }, aliases,
    links: value.links ?? [], sources: value.sources ?? [] };
}
