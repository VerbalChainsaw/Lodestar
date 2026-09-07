import { boundedDiagnosticValue } from "./diagnostics.mjs";

const DEFAULT_ACTION =
  "Review the identifiers and retry with valid Lodestar input.";
const INTERNAL_ACTION =
  "Retry the command. If it fails again, run lodestar doctor.";
const ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/u;
const LODESTAR_ERRORS = new WeakSet();
const COMPLETE_IDENTIFIER_CODES = new Set([
  "database_epoch_conflict",
  "database_instance_conflict",
  "migration_source_conflict",
  "missing_precondition",
  "record_requires_source_correction",
  "record_not_found", // get supplies a reusable absence write_basis, not just diagnostic prose.
  "request_conflict",
  "revision_conflict",
  "subject_conflict",
]);
const INPUT_ERROR_CODES = new Set([
  "direction_required",
  "identity_required",
  "invalid_input",
  "invalid_json",
  "invalid_mutation_contract",
  "invalid_path",
  "missing_argument",
  "missing_precondition",
  "reserved_record_type",
  "resource_limit",
  "skills_read_only",
  "unknown_command",
  "unknown_operation",
  "unknown_option",
  "unsupported_numeric_value",
]);
const CONFLICT_ERROR_CODES = new Set([
  "database_epoch_conflict",
  "database_instance_conflict",
  "decision_conflict",
  "decision_not_found",
  "handoff_conflict",
  "handoff_not_found",
  "link_target_not_found",
  "migration_source_conflict",
  "needs_reinspection",
  "pending_conflict",
  "pending_not_found",
  "project_binding_conflict",
  "project_conflict",
  "read_revision_conflict",
  "record_collision",
  "record_exists",
  "record_not_found",
  "recovery_accounting_conflict",
  "request_conflict",
  "revision_conflict",
  "subject_conflict",
  "work_conflict",
  "work_not_found",
]);

function property(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function knownCode(error) {
  if (!LODESTAR_ERRORS.has(error)) return null;
  const code = property(error, "code");
  return typeof code === "string" && ERROR_CODE.test(code) ? code : null;
}

function boundedText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const bounded = boundedDiagnosticValue(value, { maximumBytes: 2048 });
  return typeof bounded === "string" ? bounded : fallback;
}

function boundedIdentifiers(value) {
  const bounded = boundedDiagnosticValue(value);
  return bounded !== null
    && typeof bounded === "object"
    && !Array.isArray(bounded)
    ? bounded
    : {};
}

export function lodestarError(
  code,
  message,
  {
    identifiers = {},
    action,
    cause,
  } = {},
) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "LodestarError";
  error.code = code;
  error.identifiers = COMPLETE_IDENTIFIER_CODES.has(code)
    ? identifiers
    : boundedDiagnosticValue(identifiers);
  if (action) error.action = action;
  LODESTAR_ERRORS.add(error);
  return error;
}

export function wrapError(
  error,
  code,
  message,
  {
    identifiers = {},
    action,
  } = {},
) {
  if (LODESTAR_ERRORS.has(error)) return error;
  return lodestarError(code, message, {
    identifiers,
    action,
    cause: error,
  });
}

// Add only caller-owned context to branded errors. Raw thrown values may expose
// getters with side effects, so this boundary never reads from an untrusted error.
export function decorateError(error, identifiers = {}) {
  if (!LODESTAR_ERRORS.has(error)) return error;
  const code = knownCode(error);
  if (!code) return error;
  const identifiersFor = COMPLETE_IDENTIFIER_CODES.has(code) ? (value) => value ?? {} : boundedIdentifiers;
  return lodestarError(code, boundedText(property(error, "message"),
    "Lodestar could not complete the operation."), {
    identifiers: { ...identifiersFor(property(error, "identifiers")),
      ...identifiersFor(identifiers) },
    action: property(error, "action"),
    cause: error,
  });
}

export function errorPayload(error) {
  const code = knownCode(error);
  const known = code !== null;
  return {
    code: known ? code : "internal_error",
    message: known
      ? boundedText(
        property(error, "message"),
        "Lodestar could not complete the operation.",
      )
      : "Lodestar could not complete the operation.",
    identifiers: known
      ? COMPLETE_IDENTIFIER_CODES.has(code)
        ? property(error, "identifiers") ?? {}
        : boundedIdentifiers(property(error, "identifiers"))
      : {},
    action: known && property(error, "action")
      ? boundedText(property(error, "action"), DEFAULT_ACTION)
      : known
        ? DEFAULT_ACTION
        : INTERNAL_ACTION,
  };
}

export function errorEnvelope(error) {
  return {
    ok: false,
    error: errorPayload(error),
  };
}

function exitCodeForCode(code) {
  if (CONFLICT_ERROR_CODES.has(code) || code.endsWith("_not_found") || code.endsWith("_conflict")) return 3;
  if (new Set([
    "record_requires_source_correction",
    "unsupported_schema",
  ]).has(code)) return 4;
  if (INPUT_ERROR_CODES.has(code)) return 2;
  if (
    code.includes("integrity")
    || code.includes("schema")
    || code === "invalid_database"
  ) {
    return 4;
  }
  if (
    code.startsWith("database_")
    || code.endsWith("_unreadable")
    || code.endsWith("_write_failed")
  ) {
    return 5;
  }
  if (
    code.startsWith("invalid_")
  ) {
    return 2;
  }
  return 1;
}

export function exitCodeFor(error) {
  return exitCodeForCode(knownCode(error) ?? "internal_error");
}

export function internalErrorResult() {
  return {
    envelope: {
      ok: false,
      error: {
        code: "internal_error",
        message: "Lodestar could not complete the operation.",
        identifiers: {},
        action: INTERNAL_ACTION,
      },
    },
    exitCode: 1,
  };
}

export function errorResult(error) {
  try {
    const envelope = errorEnvelope(error);
    return {
      envelope,
      exitCode: exitCodeForCode(envelope.error.code),
    };
  } catch {
    return internalErrorResult();
  }
}
