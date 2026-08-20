import { lodestarError } from "./errors.mjs";
import { canonicalStringify } from "./json.mjs";

export const KNOWLEDGE_STATES = Object.freeze([
  "known",
  "known_empty",
  "unavailable",
  "unknown",
  "stale",
]);

export const FRESHNESS_STATES = Object.freeze([
  "current",
  "stale",
  "unknown",
]);

export const INSPECTION_STATES = Object.freeze([
  "inspected",
  "not_inspected",
  "inspected_no_value",
  "unknown",
]);

const CONTROL = /[\u0000-\u001f\u007f]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const RFC3339_MILLISECONDS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalid(field, reason, identifiers = {}) {
  throw lodestarError(
    "invalid_input",
    `${field} is ${reason}.`,
    {
      identifiers: { field, ...identifiers },
      action: "Correct the JSON input and retry.",
    },
  );
}

function plainObject(value, field) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(field, "not a JSON object");
  }
  return value;
}

function validString(
  value,
  field,
  {
    allowControl = false,
    requireNfc = true,
  } = {},
) {
  if (typeof value !== "string" || value.length === 0) {
    invalid(field, "missing or empty");
  }
  if (!allowControl && CONTROL.test(value)) {
    invalid(field, "not allowed to contain control characters");
  }
  if (UNPAIRED_SURROGATE.test(value)) {
    invalid(field, "not allowed to contain unpaired Unicode surrogates");
  }
  if (requireNfc && value.normalize("NFC") !== value) {
    invalid(field, "required to use NFC Unicode normalization");
  }
  return value;
}

function exactKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    invalid(field, "using unsupported fields", { unsupported: unknown });
  }
}

function unique(values, field, key = (value) => value) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) {
      invalid(field, "containing duplicate values", { duplicate: identity });
    }
    seen.add(identity);
  }
}

export function validateIdentifier(value, field = "id") {
  return validString(value, field);
}

export function validateType(value, field = "type") {
  return validString(value, field);
}

export function validateName(value, field = "name") {
  return validString(value, field);
}

export function validateScope(value, field = "scope") {
  return validString(value, field);
}

export function validateRelationship(value, field = "relationship") {
  return validString(value, field);
}

export function validateOrigin(value, field = "origin") {
  return validString(value, field);
}

export function identifierIsValid(value) {
  try {
    validateIdentifier(value);
    return true;
  } catch {
    return false;
  }
}

export function validateTimestamp(value, field = "timestamp") {
  if (
    typeof value !== "string"
    || !RFC3339_MILLISECONDS.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    invalid(field, "not an RFC3339 UTC timestamp with milliseconds");
  }
  return value;
}

export function validateContent(value) {
  plainObject(value, "content");
  if (
    !Object.hasOwn(value, "state")
    || !KNOWLEDGE_STATES.includes(value.state)
  ) {
    invalid("content.state", "not a supported knowledge state", {
      value: value.state ?? null,
    });
  }
  return canonicalStringify(value);
}

export function validateSourceMetadata(value, field = "source.metadata") {
  const metadata = plainObject(value, field);
  if (
    !Object.hasOwn(metadata, "inspection")
    || !INSPECTION_STATES.includes(metadata.inspection)
  ) {
    invalid(
      `${field}.inspection`,
      "not a supported inspection state",
      { value: metadata.inspection ?? null },
    );
  }
  return canonicalStringify(metadata);
}

function validateAlias(value, index) {
  return validateIdentifier(value, `aliases[${index}]`);
}

function validateLink(value, index) {
  plainObject(value, `links[${index}]`);
  exactKeys(
    value,
    new Set(["relationship", "to_id"]),
    `links[${index}]`,
  );
  for (const field of ["relationship", "to_id"]) {
    if (!Object.hasOwn(value, field)) {
      invalid(`links[${index}].${field}`, "missing or empty");
    }
  }
  return {
    relationship: validateRelationship(
      value.relationship,
      `links[${index}].relationship`,
    ),
    to_id: validateIdentifier(value.to_id, `links[${index}].to_id`),
  };
}

function validateSource(value, index) {
  plainObject(value, `sources[${index}]`);
  exactKeys(
    value,
    new Set(["origin", "freshness", "metadata"]),
    `sources[${index}]`,
  );
  for (const field of ["origin", "freshness", "metadata"]) {
    if (!Object.hasOwn(value, field)) {
      invalid(`sources[${index}].${field}`, "missing or empty");
    }
  }
  const metadata = value.metadata;
  const metadataJson = validateSourceMetadata(
    metadata,
    `sources[${index}].metadata`,
  );
  if (!FRESHNESS_STATES.includes(value.freshness)) {
    invalid(
      `sources[${index}].freshness`,
      "not a supported freshness state",
      { value: value.freshness ?? null },
    );
  }
  return {
    origin: validateOrigin(
      value.origin,
      `sources[${index}].origin`,
    ),
    freshness: value.freshness,
    metadata,
    metadata_json: metadataJson,
  };
}

function arrayValue(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid(field, "not an array");
  return value;
}

export function validatePutInput(value) {
  plainObject(value, "input");
  exactKeys(
    value,
    new Set([
      "id",
      "type",
      "name",
      "scope",
      "priority",
      "content",
      "aliases",
      "links",
      "sources",
    ]),
    "input",
  );
  for (const field of ["id", "type", "name", "scope", "content"]) {
    if (!Object.hasOwn(value, field)) invalid(field, "missing or empty");
  }
  if (value.priority !== undefined
    && (!Number.isSafeInteger(value.priority) || value.priority < 0)) {
    invalid("priority", "not a nonnegative safe integer");
  }
  const aliases = arrayValue(
    Object.hasOwn(value, "aliases") ? value.aliases : undefined,
    "aliases",
  ).map(validateAlias);
  const links = arrayValue(
    Object.hasOwn(value, "links") ? value.links : undefined,
    "links",
  ).map(validateLink);
  const sources = arrayValue(
    Object.hasOwn(value, "sources") ? value.sources : undefined,
    "sources",
  ).map(validateSource);
  unique(aliases, "aliases");
  unique(
    links,
    "links",
    ({ relationship, to_id: toId }) => `${relationship}\0${toId}`,
  );
  unique(sources, "sources", ({ origin }) => origin);
  return {
    id: validateIdentifier(value.id),
    type: validateType(value.type),
    name: validateName(value.name),
    scope: validateScope(value.scope),
    content: value.content,
    content_json: validateContent(value.content),
    aliases,
    links,
    sources,
  };
}

export function validateQuery(value) {
  return validString(value, "query");
}

export function validateLimit(value, {
  field = "limit",
  fallback,
}) {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  // Query limits are returned as JSON numbers and used for one-row lookahead;
  // safe integers avoid lossy pagination without imposing a product-policy maximum.
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    invalid(field, "required to be a positive safe integer", {
      value,
    });
  }
  return parsed;
}

