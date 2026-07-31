import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeDatabase,
  openReadDatabase,
  openWriteDatabase,
} from "../src/database.mjs";
import { importV070 } from "../src/import-v070.mjs";
import { runCli } from "../src/cli.mjs";
import { convertV070 } from "../src/legacy-v070/convert.mjs";
import {
  readV070Store,
  verifyLegacySourceUnchanged,
} from "../src/legacy-v070/read.mjs";
import { getRecord, putRecord } from "../src/records.mjs";
import { Readable } from "node:stream";

const GENERATION = "a".repeat(64);
const FIXED_TIME = () => new Date("2026-07-30T12:00:00.000Z");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-import-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`);
}

async function createLegacyStore(directory, { sealed = false } = {}) {
  const source = path.join(directory, "legacy");
  const generationRoot = path.join(source, "generations", GENERATION);
  const files = {
    "catalog.json": {
      v: 1,
      projects: [{
        id: "p:demo",
        name: "Demo",
        aliases: ["demo"],
        roots: ["/demo"],
      }],
    },
    "schema/store.json": { v: 1, record: "context-record" },
    "records/global.jsonl": [
      JSON.stringify({
        v: 1,
        id: "g:rule",
        kind: "rule",
        priority: 100,
        scope: ["global"],
        links: ["p:demo:command"],
        aliases: ["guardrail"],
        summary: "Inspect before changing.",
      }),
      JSON.stringify({
        v: 1,
        kind: "memory",
        priority: 1,
        scope: ["global"],
        links: [],
        aliases: [7],
        summary: "A record without a reusable v0.7 identifier.",
      }),
      "null",
    ].join("\n") + "\n",
    "records/projects/p-demo.jsonl": JSON.stringify({
      v: 1,
      id: "p:demo:command",
      kind: "command",
      priority: 50,
      scope: ["project:p:demo"],
      links: ["g:rule"],
      aliases: ["demo command"],
      locators: [{
        type: "file",
        path: "package.json",
        anchor: "scripts",
      }],
      routes: {
        owner: "p:demo",
        ["x".repeat(100)]: "g:rule",
      },
      none_verified: true,
      verified: { source: "package.json" },
    }) + "\n",
    "indexes/locator-health.json": {
      v: 1,
      generation: GENERATION,
      locators: {
        "p:demo:command#0": {
          status: "ok",
          checked_path: "/demo/package.json",
        },
      },
    },
  };

  await writeJson(path.join(source, "current.json"), {
    v: 1,
    generation: GENERATION,
  });
  for (const [relative, value] of Object.entries(files)) {
    const destination = path.join(generationRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    const text = typeof value === "string"
      ? value
      : `${JSON.stringify(value)}\n`;
    await writeFile(destination, text);
  }
  if (sealed) {
    const manifestFiles = {};
    for (const relative of Object.keys(files).sort()) {
      const value = await readFile(path.join(generationRoot, relative));
      manifestFiles[relative] = {
        bytes: value.length,
        sha256: sha256(value),
      };
    }
    await writeJson(path.join(generationRoot, "integrity.json"), {
      v: 1,
      algorithm: "sha256",
      generation: GENERATION,
      files: manifestFiles,
    });
  }
  return { source, generationRoot };
}

async function treeFingerprint(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (child.isDirectory()) await visit(absolute);
      else entries.push([relative, sha256(await readFile(absolute))]);
    }
  }
  await visit(root);
  return sha256(JSON.stringify(entries));
}

test("dry-run and import preserve v0.7 data and never mutate its store", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const database = path.join(directory, "destination", "lodestar.db");
  const sourceBefore = await treeFingerprint(source);

  const dryRun = await importV070({
    sourcePath: source,
    database,
    dryRun: true,
    now: FIXED_TIME,
  });
  assert.equal(dryRun.dry_run, true);
  assert.equal(dryRun.destination.committed, false);
  assert.equal(dryRun.source.integrity, "unsealed");
  assert.deepEqual(dryRun.imported, {
    records: 4,
    aliases: 3,
    links: 4,
    sources: 5,
  });
  assert.equal(dryRun.reporting.truncated, false);
  assert.equal(dryRun.id_mappings.length, 1);
  assert.equal(dryRun.id_mappings[0].reason, "missing_id");
  assert.ok(dryRun.skipped.some(({ reason }) => reason === "invalid_alias"));
  assert.ok(dryRun.skipped.some(({ reason }) => reason === "item_not_object"));
  assert.ok(
    dryRun.unsupported.some(
      ({ reason }) => reason === "relationship_remapped",
    ),
  );
  await assert.rejects(access(database), { code: "ENOENT" });
  assert.equal(await treeFingerprint(source), sourceBefore);

  const imported = await importV070({
    sourcePath: source,
    database,
    now: FIXED_TIME,
  });
  assert.equal(imported.destination.committed, true);
  assert.equal(imported.validation.doctor_ok, true);
  assert.deepEqual(imported.id_mappings, dryRun.id_mappings);
  assert.equal(await treeFingerprint(source), sourceBefore);

  const db = await openReadDatabase(database);
  try {
    const command = getRecord(db, "demo command");
    assert.equal(command.id, "p:demo:command");
    assert.equal(command.scope, "project:p:demo");
    assert.equal(command.content.state, "known_empty");
    assert.equal(command.sources[0].metadata.inspection, "inspected_no_value");
    const locatorSource = command.sources.find(
      ({ origin }) => origin === "package.json",
    );
    assert.equal(locatorSource.metadata.inspection, "unknown");
    assert.equal(locatorSource.metadata.legacy.health.status, "ok");
    assert.deepEqual(
      command.links.map(({ relationship, to_id: toId }) =>
        [relationship, toId]
      ),
      [
        ["related", "g:rule"],
        [`route:${sha256(`route:${"x".repeat(100)}`).slice(0, 32)}`, "g:rule"],
        ["route:owner", "p:demo"],
      ],
    );
  } finally {
    db.close();
  }
});

test("sealed legacy stores are verified before conversion", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source, generationRoot } = await createLegacyStore(directory, {
    sealed: true,
  });
  const report = await importV070({
    sourcePath: source,
    database: path.join(directory, "sealed.db"),
    dryRun: true,
    now: FIXED_TIME,
  });
  assert.equal(report.source.integrity, "verified");

  await writeFile(
    path.join(generationRoot, "records/global.jsonl"),
    "{\"tampered\":true}\n",
  );
  await assert.rejects(
    importV070({
      sourcePath: source,
      database: path.join(directory, "tampered.db"),
      dryRun: true,
      now: FIXED_TIME,
    }),
    { code: "legacy_integrity" },
  );
});

test("import rejects nonempty and overlapping destinations", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const database = path.join(directory, "existing.db");
  await initializeDatabase(database, { now: FIXED_TIME });
  const db = await openWriteDatabase(database);
  try {
    putRecord(db, {
      id: "existing",
      type: "note",
      name: "Existing",
      scope: "global",
      content: { state: "known", value: true },
      aliases: [],
      links: [],
      sources: [],
    }, { database, now: FIXED_TIME });
  } finally {
    db.close();
  }
  await assert.rejects(
    importV070({ sourcePath: source, database, now: FIXED_TIME }),
    { code: "import_destination_not_empty" },
  );
  await assert.rejects(
    importV070({
      sourcePath: source,
      database: path.join(source, "new.db"),
      dryRun: true,
      now: FIXED_TIME,
    }),
    { code: "import_path_overlap" },
  );
});

test("import resumes an interrupted zero-byte destination reservation", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const database = path.join(directory, "reserved.db");
  await writeFile(database, "");
  const report = await importV070({
    sourcePath: source,
    database,
    now: FIXED_TIME,
  });
  assert.equal(report.destination.committed, true);
  const db = await openReadDatabase(database);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    4,
  );
  db.close();
});

test("source snapshots detect changes before commit", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const legacy = await readV070Store(source);
  await writeJson(path.join(source, "current.json"), {
    v: 1,
    generation: "b".repeat(64),
  });
  await assert.rejects(
    verifyLegacySourceUnchanged(legacy.snapshot),
    { code: "source_changed" },
  );
});

test("reader matches v0.7 UTF-16 project shard naming", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "unicode-legacy");
  const generationRoot = path.join(source, "generations", GENERATION);
  await writeJson(path.join(source, "current.json"), {
    v: 1,
    generation: GENERATION,
  });
  await writeJson(path.join(generationRoot, "catalog.json"), {
    v: 1,
    projects: [{ id: "p:😀", name: "Unicode", aliases: [], roots: [] }],
  });
  await writeJson(path.join(generationRoot, "schema/store.json"), { v: 1 });
  await mkdir(path.join(generationRoot, "records"), { recursive: true });
  await writeFile(
    path.join(generationRoot, "records", "global.jsonl"),
    "",
  );
  await mkdir(path.join(generationRoot, "records", "projects"), {
    recursive: true,
  });
  await writeFile(
    path.join(generationRoot, "records", "projects", "p---.jsonl"),
    `${JSON.stringify({
      v: 1,
      id: "p:unicode:note",
      kind: "memory",
      priority: 1,
      scope: ["project:p:😀"],
      links: [],
    })}\n`,
  );

  const legacy = await readV070Store(source);
  assert.equal(legacy.records.length, 1);
  assert.equal(legacy.records[0].defaultScope, "project:p:😀");
});

test("import rejects a destination that reaches the source through a symlink", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const linked = path.join(directory, "linked-source");
  try {
    await symlink(source, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") {
      t.skip("This platform does not permit the test symlink.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    importV070({
      sourcePath: source,
      database: path.join(linked, "escaped.db"),
      dryRun: true,
      now: FIXED_TIME,
    }),
    { code: "import_path_overlap" },
  );
});

test("import rejects a hard-linked destination without changing the source", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const sourceFile = path.join(source, "empty-reservation");
  const database = path.join(directory, "hard-linked.db");
  await writeFile(sourceFile, "");
  try {
    await link(sourceFile, database);
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip("This platform or filesystem does not permit hard links.");
      return;
    }
    throw error;
  }
  await assert.rejects(
    importV070({ sourcePath: source, database, now: FIXED_TIME }),
    { code: "import_path_overlap" },
  );
  assert.equal((await readFile(sourceFile)).length, 0);
});

test("the public import command emits its machine-readable dry-run report", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const database = path.join(directory, "cli.db");
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli([
    "import",
    source,
    "--dry-run",
    "--db",
    database,
  ], {
    stdin: Readable.from([]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.equal(exitCode, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.ok, true);
  assert.equal(output.data.dry_run, true);
  assert.equal(output.data.destination.committed, false);
  await assert.rejects(access(database), { code: "ENOENT" });
});

test("migration reporting is bounded and preserves omission counts", () => {
  const converted = convertV070({
    generation: GENERATION,
    catalog: { projects: [] },
    records: [{
      record: {
        id: "record:report-bound",
        kind: "memory",
        scope: ["global"],
        links: [],
        aliases: Array.from({ length: 2_505 }, (_, index) => index),
      },
      defaultScope: "global",
      location: {
        file: "records/global.jsonl",
        line: 1,
      },
    }],
    locatorHealth: null,
  });
  assert.equal(converted.records.length, 1);
  assert.equal(converted.report.skipped.length, 2_000);
  assert.equal(converted.report.reporting.truncated, true);
  assert.deepEqual(converted.report.reporting.sections.skipped, {
    entries_total: 2_505,
    entries_reported: 2_000,
    entries_omitted: 505,
  });
});

test("concurrent imports cannot delete or overwrite the winning destination", async (t) => {
  const directory = await temporaryDirectory(t);
  const { source } = await createLegacyStore(directory);
  const database = path.join(directory, "race", "lodestar.db");
  const attempts = await Promise.allSettled([
    importV070({ sourcePath: source, database, now: FIXED_TIME }),
    importV070({ sourcePath: source, database, now: FIXED_TIME }),
  ]);
  assert.equal(
    attempts.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  for (const attempt of attempts.filter(({ status }) => status === "rejected")) {
    assert.ok([
      "database_busy",
      "database_conflict",
      "invalid_database",
      "import_destination_not_empty",
    ].includes(attempt.reason.code), attempt.reason);
  }
  const db = await openReadDatabase(database);
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM records").get().count,
    4,
  );
  db.close();
});
