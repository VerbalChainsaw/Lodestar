import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runCli } from "../src/cli.mjs";
import { createMigrationBackup, migrateDatabase, migrationPreflight } from "../src/schema-migration.mjs";
import { SCHEMA_V4_SQL } from "../src/schema.mjs";
import { temporaryDirectory } from "./helpers/contract.mjs";

async function sourceFixture(t, { version = "4", epoch = true, semantics = false } = {}) {
  const root = await temporaryDirectory(t, "lodestar-migration-evidence-");
  const file = path.join(root, "selected database 'quoted'.db");
  const raw = new DatabaseSync(file);
  const content = { state: "known", value: { kept: true },
    ...(semantics ? { _lodestar: { priority: 0, revision: 9, semantics: {
      lifecycle: "current", context_role: "on_demand", basis: "asserted",
      applicability: { project: "global", checkout: null } } } } : {}) };
  const recordJson = JSON.stringify(content);
  try {
    raw.exec(SCHEMA_V4_SQL);
    for (const [key, value] of Object.entries({ schema_version: version,
      created_at: "2026-09-06T09:00:00.000Z", database_instance_id: "a".repeat(64),
      database_revision: "9", ...(epoch ? { database_epoch: "b".repeat(64) } : {}) })) {
      raw.prepare("INSERT INTO metadata VALUES(?,?)").run(key, value);
    }
    raw.prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?)").run("fact:kept", "fact", "Kept", "global",
      recordJson, "2026-09-06T09:00:00.000Z", "2026-09-06T09:00:00.000Z");
  } finally { raw.close(); }
  return { root, file, recordJson };
}

async function cli(file, args, body = null) {
  let stdout = "", stderr = "";
  const code = await runCli(["--db", file, ...args], {
    stdin: Readable.from(body === null ? [] : [JSON.stringify(body)]),
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { code, envelope: JSON.parse(stdout || stderr), stdout, stderr };
}

async function migrationFixture(t, options) {
  const fixture = await sourceFixture(t, options);
  const result = await cli(fixture.file, ["doctor", "--migration-preflight"]);
  assert.equal(result.code, 0);
  const backup = await createMigrationBackup(fixture.file, path.join(fixture.root, "independent backup.db"));
  const request = { v: 5, request_id: "migration:evidence-contract", preflight: result.envelope.data, backup };
  return { ...fixture, request };
}

function schema4Guidance(error, file) {
  assert.equal(error.code, "unsupported_schema");
  assert.deepEqual(error.identifiers.preflight_args, ["--db", file, "doctor", "--migration-preflight"]);
  assert.equal(error.identifiers.database, file);
  assert.ok(error.action.includes(file));
  assert.match(error.action, /preserve/iu);
  assert.match(error.action, /--db/);
  assert.match(error.action, /--migration-preflight/);
  assert.doesNotMatch(error.action, /lodestar backup/);
}

for (const args of [["init"], ["get", "--", "fact:kept"]]) {
  test(`schema4 ${args[0]} refusal points to literal preserving preflight without conversion`, async (t) => {
    const { file } = await sourceFixture(t);
    const before = await readFile(file);
    const result = await cli(file, args);
    assert.equal(result.code, 4); assert.equal(result.stdout, "");
    schema4Guidance(result.envelope.error, file);
    assert.deepEqual(result.envelope.next, [result.envelope.error.action]);
    const preflight = await cli(file, result.envelope.error.identifiers.preflight_args.slice(2));
    assert.equal(preflight.code, 0); assert.equal(preflight.envelope.data.schema_version, 4);
    assert.deepEqual(await readFile(file), before);
  });
}

test("ordinary doctor gives the same selected schema4 conversion guidance", async (t) => {
  const { file } = await sourceFixture(t);
  const before = await readFile(file);
  const result = await cli(file, ["doctor"]);
  assert.equal(result.code, 4); assert.equal(result.envelope.ok, true);
  schema4Guidance(result.envelope.data.issues.find(({ code }) => code === "unsupported_schema"), file);
  assert.deepEqual(await readFile(file), before);
});

for (const version of ["3", "6", "future"]) {
  test(`schema ${version} refusal preserves the store and names matching-release recovery`, async (t) => {
    const { file } = await sourceFixture(t, { version });
    const before = await readFile(file);
    for (const args of [["init"], ["doctor"], ["doctor", "--migration-preflight"]]) {
      const result = await cli(file, args);
      assert.equal(result.code, 4);
      const error = result.envelope.ok
        ? result.envelope.data.issues.find(({ code }) => code === "unsupported_schema") : result.envelope.error;
      assert.equal(error.code, "unsupported_schema");
      assert.ok(error.action.includes(file));
      assert.match(error.action, /preserve/iu); assert.match(error.action, /matching|supports.*schema/iu);
      assert.equal(error.identifiers.preflight_args, undefined);
      assert.doesNotMatch(error.action, /--migration-preflight/);
    }
    assert.deepEqual(await readFile(file), before);
  });
}

const malformed = [
  ["missing preflight", "preflight", undefined], ["null preflight", "preflight", null],
  ["array preflight", "preflight", []], ["string preflight", "preflight", "legacy"],
  ["missing backup", "backup", undefined], ["array backup", "backup", []],
  ["string backup", "backup", "backup.db"],
  ["missing preflight version", "preflight.v", undefined], ["wrong preflight version", "preflight.v", 4],
  ["missing schema", "preflight.schema_version", undefined], ["wrong schema", "preflight.schema_version", 5],
  ["missing instance", "preflight.database_instance_id", undefined],
  ["array instance", "preflight.database_instance_id", ["a".repeat(64)]],
  ["missing epoch", "preflight.database_epoch", undefined],
  ["invalid epoch", "preflight.database_epoch", "legacy"],
  ["missing revision", "preflight.database_revision", undefined],
  ["string revision", "preflight.database_revision", "9"],
  ["fractional revision", "preflight.database_revision", 9.5],
  ["negative revision", "preflight.database_revision", -1],
  ["missing source fingerprint", "preflight.schema_fingerprint", undefined],
  ["malformed source fingerprint", "preflight.schema_fingerprint", "wrong"],
  ["array source digest", "preflight.logical_digest", ["a".repeat(64)]],
  ["missing source digest", "preflight.logical_digest", undefined],
  ["missing backup fingerprint", "backup.schema_fingerprint", undefined],
  ["malformed backup fingerprint", "backup.schema_fingerprint", "wrong"],
  ["array backup fingerprint", "backup.schema_fingerprint", ["a".repeat(64)]],
  ["missing backup digest", "backup.logical_digest", undefined],
  ["malformed backup digest", "backup.logical_digest", "wrong"],
  ["missing backup path", "backup.path", undefined], ["empty backup path", "backup.path", ""],
  ["array backup path", "backup.path", ["backup.db"]], ["NUL backup path", "backup.path", "backup\0.db"],
];
for (const [name, field, value] of malformed) {
  test(`migration rejects ${name} with a named correction and unchanged source bytes`, async (t) => {
    const { file, request } = await migrationFixture(t);
    const before = await readFile(file);
    const keys = field.split(".");
    const owner = keys.length === 1 ? request : request[keys[0]];
    if (value === undefined) delete owner[keys.at(-1)]; else owner[keys.at(-1)] = value;
    const result = await cli(file, ["init", "--migrate"], request);
    assert.equal(result.code, 2, JSON.stringify(result.envelope));
    const error = result.envelope.error;
    assert.equal(error.code, "invalid_mutation_contract");
    assert.equal(error.identifiers.field, field);
    assert.match(error.action, /preflight|backup/iu); assert.match(error.action, /preserve/iu);
    assert.equal(result.stdout, "");
    assert.deepEqual(await readFile(file), before);
    assert.equal((await migrationPreflight(file)).schema_version, 4);
  });
}

for (const mode of ["backup-only", "both-claims"]) {
  test(`valid-looking false fingerprint is rejected against restored backup (${mode})`, async (t) => {
    const { file, request } = await migrationFixture(t);
    const before = await readFile(file), backupBefore = await readFile(request.backup.path);
    request.backup.schema_fingerprint = "0".repeat(64);
    if (mode === "both-claims") request.preflight.schema_fingerprint = request.backup.schema_fingerprint;
    const result = await cli(file, ["init", "--migrate"], request);
    assert.equal(result.code, 3);
    assert.equal(result.envelope.error.code, "migration_source_conflict");
    assert.equal(result.envelope.error.identifiers.field, "schema_fingerprint");
    assert.match(result.envelope.error.action, /backup|preflight/iu);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readFile(request.backup.path), backupBefore);
  });
}

test("stale source still fails the locked logical admission without conversion", async (t) => {
  const { file, request } = await migrationFixture(t);
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE records SET name='Changed after preflight' WHERE id='fact:kept'").run(); raw.close();
  const before = await readFile(file);
  const result = await cli(file, ["init", "--migrate"], request);
  assert.equal(result.code, 3); assert.equal(result.envelope.error.identifiers.field, "logical_digest");
  assert.deepEqual(await readFile(file), before);
});

for (const semantics of [false, true]) {
  test(`valid public evidence converts ${semantics ? "unchanged" : "legacy"} record and exact replay survives missing backup`, async (t) => {
    const { root, file, recordJson, request } = await migrationFixture(t, { semantics, epoch: false });
    const requestPath = path.join(root, "migration-request.json");
    await writeFile(requestPath, JSON.stringify(request));
    const result = await cli(file, ["init", "--migrate", "--file", requestPath]);
    assert.equal(result.code, 0, JSON.stringify(result.envelope));
    assert.equal(result.envelope.data.migrated, true); assert.equal(result.envelope.data.replayed, false);
    assert.equal(result.envelope.data.schema_version, 5); assert.equal(result.envelope.revision, 10);
    assert.equal(result.envelope.database_instance_id, "a".repeat(64));
    assert.match(result.envelope.database_epoch, /^[0-9a-f]{64}$/u);
    const raw = new DatabaseSync(file, { readOnly: true });
    try {
      const row = raw.prepare("SELECT content_json FROM records WHERE id='fact:kept'").get();
      assert.deepEqual(JSON.parse(row.content_json).value, { kept: true });
      if (semantics) assert.equal(row.content_json, recordJson);
      else assert.equal(JSON.parse(row.content_json)._lodestar.semantics.basis, "legacy_unverified");
      const provenance = JSON.parse(raw.prepare("SELECT content_json FROM records WHERE id=?")
        .get(result.envelope.data.provenance_id).content_json).value;
      assert.deepEqual(provenance.backup, request.backup);
    } finally { raw.close(); }
    await unlink(request.backup.path);
    const acceptedBytes = await readFile(file);
    const replay = await cli(file, ["init", "--migrate", "--file", requestPath]);
    assert.equal(replay.code, 0); assert.equal(replay.envelope.data.replayed, true);
    assert.equal(replay.envelope.revision, 10);
    assert.deepEqual(await readFile(file), acceptedBytes);
    const altered = structuredClone(request); altered.preflight.database_revision = 8;
    await assert.rejects(migrateDatabase(file, { request: altered }), ({ code }) => code === "request_conflict");
    assert.deepEqual(await readFile(file), acceptedBytes);
  });
}
