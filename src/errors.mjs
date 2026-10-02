import { boundedDiagnosticValue } from "./diagnostics.mjs";

const DEFAULT_ACTION =
  "Preserve the exact command, request bytes and ID, selected database and adjacent journals. Use the configured Lodestar runtime with the same --db selection for read-only diagnosis: doctor and get --raw -- <id> to inspect any known receipt and current records. Reconcile a write against its receipt and current state before replaying only the exact saved request; inspect an affected read again after resolving its reported cause.";
const INTERNAL_ACTION =
  `This error does not establish whether a write was accepted. ${DEFAULT_ACTION}`;
const COMMAND_ACTION = "Read lodestar --help for supported commands, then lodestar <command> --help for that command's arguments. Correct the reported command, operation or option before running it again.";
const INPUT_ACTION = "Correct the reported input using lodestar <command> --help for its arguments and request schema, then run the command with the corrected input.";
const READ_ACTION = "Inspect the reported read and its selected --db database. Use lodestar <command> --help to check its arguments; resolve the reported input or storage problem, then repeat that read. For a storage failure, inspect lodestar --db <database> doctor before reading again.";
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
  "interactive_terminal_required",
  "invalid_input",
  "invalid_json",
  "invalid_mutation_contract",
  "invalid_path",
  "missing_argument",
  "missing_precondition",
  "reserved_record_type",
  "resource_limit",
  "recovery_journal_invalid",
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
  "recovery_request_conflict",
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

export function errorPayload(error, context = {}) {
  const code = knownCode(error);
  const known = code !== null;
  const fallback = ["unknown_command","unknown_operation","unknown_option"].includes(code) ? COMMAND_ACTION
    : context.read === true ? READ_ACTION
      : known && INPUT_ERROR_CODES.has(code) ? INPUT_ACTION
        : known ? DEFAULT_ACTION : INTERNAL_ACTION;
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
      ? boundedText(property(error, "action"), fallback)
      : fallback,
  };
}

export function errorEnvelope(error, context = {}) {
  return {
    ok: false,
    error: errorPayload(error, context),
  };
}

function exitCodeForCode(code) {
  if (code === "response_delivery_failed") return 5;
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

export function errorResult(error, context = {}) {
  try {
    const envelope = errorEnvelope(error, context);
    return {
      envelope,
      exitCode: exitCodeForCode(envelope.error.code),
    };
  } catch {
    return internalErrorResult();
  }
}
