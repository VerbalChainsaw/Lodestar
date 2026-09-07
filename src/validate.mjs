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
export const SEMANTIC_LIFECYCLES = Object.freeze([
  "current", "unresolved", "historical", "superseded",
]);
export const SEMANTIC_BASES = Object.freeze([
  "asserted", "observed", "user_direction", "legacy_unverified",
]);
export const CONTEXT_ROLES = Object.freeze(["orientation", "on_demand"]);
export const SOURCE_KINDS = Object.freeze([
  "local_file", "package_manifest", "runtime_observation",
  "external_observation", "user_direction",
]);
export const SOURCE_RELATIONS = Object.freeze([
  "content_owner", "derived_from", "verification_input", "supporting_evidence",
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
  if (value._lodestar !== undefined) {
    plainObject(value._lodestar, "content._lodestar");
    exactKeys(value._lodestar, new Set(["priority", "revision", "semantics"]),
      "content._lodestar");
    if (!Number.isSafeInteger(value._lodestar.priority)
      || !Number.isSafeInteger(value._lodestar.revision)
      || value._lodestar.revision < 1) {
      invalid("content._lodestar", "using invalid core revision metadata");
    }
    if (value._lodestar.semantics !== undefined) {
      validateSemantics(value._lodestar.semantics);
    }
  }
  return canonicalStringify(value);
}

export function validateSemantics(value, field = "semantics") {
  const semantics = plainObject(value, field);
  exactKeys(semantics, new Set(["subject", "lifecycle", "context_role", "basis",
    "applicability", "provenance", "reason", "supersedes", "conditions",
    "retirement_reason"]), field);
  if (semantics.subject !== undefined) validateIdentifier(semantics.subject, `${field}.subject`);
  if (!SEMANTIC_LIFECYCLES.includes(semantics.lifecycle)) {
    invalid(`${field}.lifecycle`, "not a supported lifecycle", { value: semantics.lifecycle ?? null });
  }
  if (!CONTEXT_ROLES.includes(semantics.context_role)) {
    invalid(`${field}.context_role`, "not a supported context role", { value: semantics.context_role ?? null });
  }
  if (!SEMANTIC_BASES.includes(semantics.basis)) {
    invalid(`${field}.basis`, "not a supported semantic basis", { value: semantics.basis ?? null });
  }
  if (!plainObject(semantics.applicability, `${field}.applicability`)) return semantics;
  exactKeys(semantics.applicability, new Set(["project", "checkout"]), `${field}.applicability`);
  if (semantics.applicability.project !== null) {
    validateScope(semantics.applicability.project, `${field}.applicability.project`);
  }
  if (semantics.applicability.checkout !== null) {
    validateIdentifier(semantics.applicability.checkout, `${field}.applicability.checkout`);
  }
  return semantics;
}

export function validateSourceMetadata(value, field = "source.metadata", {
  allowLegacy = false,
} = {}) {
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
  if (allowLegacy && metadata.kind === undefined) return canonicalStringify(metadata);
  exactKeys(metadata, new Set(["inspection", "kind", "relation", "locator",
    "observed_at", "fingerprint", "claim", "evidence_ref"]), field);
  if (!SOURCE_KINDS.includes(metadata.kind)) {
    invalid(`${field}.kind`, "not a supported source kind", { value: metadata.kind ?? null });
  }
  if (!SOURCE_RELATIONS.includes(metadata.relation)) {
    invalid(`${field}.relation`, "not a supported source relation", { value: metadata.relation ?? null });
  }
  if (metadata.observed_at !== undefined) validateTimestamp(metadata.observed_at,
    `${field}.observed_at`);
  if (["local_file", "package_manifest"].includes(metadata.kind)) {
    plainObject(metadata.locator, `${field}.locator`);
    exactKeys(metadata.locator, new Set(["base", "path", "source_id"]), `${field}.locator`);
    if (!["project_root", "checkout_root", "source_root", "absolute"]
      .includes(metadata.locator.base)) invalid(`${field}.locator.base`, "not supported");
    validString(metadata.locator.path, `${field}.locator.path`, { requireNfc: false });
    if (metadata.locator.base === "source_root") {
      validString(metadata.locator.source_id, `${field}.locator.source_id`);
    } else if (metadata.locator.source_id !== undefined) {
      invalid(`${field}.locator.source_id`, "allowed only with source_root");
    }
    const fingerprint = plainObject(metadata.fingerprint, `${field}.fingerprint`);
    exactKeys(fingerprint, new Set(["algorithm", "value", "bytes"]), `${field}.fingerprint`);
    if (fingerprint.algorithm !== "sha256" || !/^[0-9a-f]{64}$/u.test(fingerprint.value ?? "")
      || !Number.isSafeInteger(fingerprint.bytes) || fingerprint.bytes < 0) {
      invalid(`${field}.fingerprint`, "not a complete SHA-256 byte fingerprint");
    }
    validateTimestamp(metadata.observed_at, `${field}.observed_at`);
  } else if (["runtime_observation", "external_observation"].includes(metadata.kind)) {
    validateTimestamp(metadata.observed_at, `${field}.observed_at`);
    if (metadata.evidence_ref === undefined || metadata.evidence_ref === null) {
      invalid(`${field}.evidence_ref`, "required for runtime or external observations");
    }
    validString(metadata.evidence_ref, `${field}.evidence_ref`, { requireNfc: false });
  } else if (metadata.kind === "user_direction"
    && metadata.evidence_ref !== null && metadata.evidence_ref !== undefined) {
    validString(metadata.evidence_ref, `${field}.evidence_ref`, { requireNfc: false });
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
  for (const field of ["origin", "freshness"]) {
    if (!Object.hasOwn(value, field)) {
      invalid(`sources[${index}].${field}`, "missing or empty");
    }
  }
  const metadata = Object.hasOwn(value, "metadata") ? value.metadata : {};
  // Stored metadata always carries an inspection state (the schema enforces it);
  // a source that omits it has not been inspected, so default rather than reject.
  const storedMetadata = Object.hasOwn(metadata, "inspection")
    ? metadata
    : { ...metadata, inspection: "not_inspected" };
  const metadataJson = validateSourceMetadata(
    storedMetadata,
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
    metadata: storedMetadata,
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

export function validateOffset(value, { field = "offset" } = {}) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid(field, "required to be a nonnegative safe integer", {
      value,
    });
  }
  return parsed;
}
