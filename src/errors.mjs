import { boundedDiagnosticValue } from "./diagnostics.mjs";

const DEFAULT_ACTION =
  "Review the identifiers and retry with valid Lodestar input.";

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
  error.identifiers = boundedDiagnosticValue(identifiers);
  if (action) error.action = action;
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
  if (error?.name === "LodestarError") return error;
  return lodestarError(code, message, {
    identifiers,
    action,
    cause: error,
  });
}

export function errorPayload(error) {
  const known = error?.name === "LodestarError";
  return {
    code: known ? error.code : "internal_error",
    message: known
      ? error.message
      : "Lodestar could not complete the operation.",
    identifiers: known && error.identifiers
      ? error.identifiers
      : {},
    action: known && error.action
      ? error.action
      : known
        ? DEFAULT_ACTION
        : "Retry the command. If it fails again, run lodestar doctor.",
  };
}

export function errorEnvelope(error) {
  return {
    ok: false,
    error: errorPayload(error),
  };
}

export function exitCodeFor(error) {
  const code = error?.code ?? "internal_error";
  if (
    code.endsWith("_not_found")
    || code.endsWith("_conflict")
    || code === "record_not_found"
  ) {
    return 3;
  }
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
    || code === "import_cleanup_failed"
    || code === "import_commit_outcome_unknown"
  ) {
    return 5;
  }
  if (
    code.startsWith("invalid_")
    || code === "resource_limit"
    || code === "unknown_command"
    || code === "unknown_option"
    || code === "missing_argument"
  ) {
    return 2;
  }
  return 1;
}
