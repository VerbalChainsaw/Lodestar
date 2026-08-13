import { lodestarError } from "./errors.mjs";

export function currentRevision(db) {
  const value = db.prepare(
    "SELECT value FROM metadata WHERE key = 'database_revision'",
  ).get()?.value;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? "")) {
    throw lodestarError(
      "database_integrity",
      "The Lodestar database revision is missing or invalid.",
    );
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) {
    throw lodestarError(
      "resource_limit",
      "The Lodestar database revision exhausted the safe integer range.",
    );
  }
  return revision;
}

export function allocateRevision(db) {
  const next = currentRevision(db) + 1;
  if (!Number.isSafeInteger(next)) {
    throw lodestarError(
      "resource_limit",
      "The Lodestar database revision exhausted the safe integer range.",
    );
  }
  db.prepare(
    "UPDATE metadata SET value = ? WHERE key = 'database_revision'",
  ).run(String(next));
  return next;
}
