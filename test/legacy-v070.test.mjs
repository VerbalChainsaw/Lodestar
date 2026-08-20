import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importV070 } from "../src/import-v070.mjs";
import { convertV070 } from "../src/legacy-v070/convert.mjs";
import { readV070Store } from "../src/legacy-v070/read.mjs";

const GENERATION = "a".repeat(64);

function sourceWith(records, locatorHealth = null) {
  return {
    generation: GENERATION,
    catalog: { projects: [] },
    records: records.map((record, index) => ({
      record,
      defaultScope: "global",
      location: {
        file: "records/global.jsonl",
        line: index + 1,
      },
    })),
    locatorHealth,
  };
}

function legacyRecord(value = {}) {
  return {
    kind: "memory",
    scope: ["global"],
    links: [],
    aliases: [],
    ...value,
  };
}

test("generated IDs cannot consume a later valid original ID", () => {
  const missing = legacyRecord({ marker: "generated" });
  const generated = convertV070(sourceWith([missing]))
    .report.id_mappings[0].record_id;
  const converted = convertV070(sourceWith([
    missing,
    legacyRecord({ id: generated, marker: "original" }),
  ]));
  const byMarker = Object.fromEntries(
    converted.records.map((record) => [
      record.content.value.marker,
      record.id,
    ]),
  );

  assert.equal(byMarker.original, generated);
  assert.notEqual(byMarker.generated, generated);
  assert.equal(
    converted.report.id_mappings.find(
      ({ source_id: sourceId }) => sourceId === generated,
    ),
    undefined,
  );
});

test("locator-health evidence without a matching locator is reported", () => {
  const converted = convertV070(sourceWith([], {
    v: 1,
    generation: GENERATION,
    locators: {
      "orphan-record#0": {
        status: "ok",
        checked_path: "/project/package.json",
      },
    },
  }));

  assert.ok(converted.report.unsupported.some((entry) =>
    entry.kind === "locator_health"
    && entry.identifier === "orphan-record#0"
    && entry.reason === "orphan_locator_health"
    && entry.disposition === "not_imported"
  ));
});

test("locator health uses the same key normalization for non-string IDs", () => {
  const converted = convertV070(sourceWith([
    legacyRecord({
      id: 7,
      locators: [{ type: "file", path: "numeric.txt" }],
    }),
  ], {
    v: 1,
    generation: GENERATION,
    locators: {
      "7#0": {
        status: "ok",
        checked_path: "/project/numeric.txt",
      },
    },
  }));
  const locatorSource = converted.records[0].sources.find(
    ({ origin }) => origin === "numeric.txt",
  );

  assert.equal(locatorSource.metadata.legacy.health.status, "ok");
  assert.equal(
    converted.report.unsupported.some(
      ({ identifier, reason }) =>
        identifier === "7#0" && reason === "orphan_locator_health",
    ),
    false,
  );
});

test("ambiguous locator health is not copied across duplicate IDs", () => {
  const converted = convertV070(sourceWith([
    legacyRecord({
      id: "duplicate:id",
      locators: [{ type: "file", path: "first.txt" }],
    }),
    legacyRecord({
      id: "duplicate:id",
      locators: [{ type: "file", path: "second.txt" }],
    }),
  ], {
    v: 1,
    generation: GENERATION,
    locators: {
      "duplicate:id#0": {
        status: "ok",
        checked_path: "/project/first.txt",
      },
    },
  }));
  const attached = converted.records.flatMap(({ sources }) =>
    sources.filter(({ metadata }) => metadata.legacy.health !== undefined)
  );

  assert.equal(attached.length, 0);
  assert.ok(converted.report.unsupported.some((entry) =>
    entry.kind === "locator_health"
    && entry.identifier === "duplicate:id#0"
    && entry.reason === "ambiguous_locator_health"
    && entry.owners === 2
    && entry.disposition === "not_imported"
  ));
});

test("every unique locator-health observation is imported or reported", () => {
  const cases = [
    {
      key: "record:rejected#0",
      record: legacyRecord({
        id: "record:rejected",
        locators: [{ type: "file", path: "rejected.txt" }],
        oversized: "x".repeat(256 * 1024),
      }),
      health: { status: "ok" },
    },
    {
      key: "record:invalid-locator#0",
      record: legacyRecord({
        id: "record:invalid-locator",
        locators: [{ type: "file" }],
      }),
      health: { status: "missing" },
    },
    {
      key: "record:duplicate-origin#1",
      record: legacyRecord({
        id: "record:duplicate-origin",
        locators: [
          { type: "file", path: "same.txt" },
          { type: "file", path: "same.txt" },
        ],
      }),
      health: { status: "unreadable" },
    },
    {
      key: "record:source-limit#31",
      record: legacyRecord({
        id: "record:source-limit",
        locators: Array.from({ length: 32 }, (_, index) => ({
          type: "file",
          path: `source-${index}.txt`,
        })),
      }),
      health: { status: "unchecked" },
    },
    {
      key: "record:compacted#0",
      record: legacyRecord({
        id: "record:compacted",
        locators: [{ type: "file", path: "compacted.txt" }],
      }),
      health: {
        status: "ok",
        detail: "x".repeat(65 * 1024),
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const converted = convertV070(sourceWith([item.record], {
      v: 1,
      generation: GENERATION,
      locators: { [item.key]: item.health },
    }));
    const entries = converted.report.unsupported.filter(
      ({ kind, identifier }) =>
        kind === "locator_health" && identifier === item.key,
    );
    const expectedUnimported = [1, 2].includes(index);
    assert.equal(entries.length, expectedUnimported ? 1 : 0, item.key);
    if (expectedUnimported) {
      assert.deepEqual(entries[0], {
        kind: "locator_health",
        identifier: item.key,
        source: "indexes/locator-health.json",
        reason: "unimported_locator_health",
        disposition: "not_imported",
      });
    }
  }
});

test("the v0.7 reader rejects a different current-pointer version", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-pointer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "legacy");
  await mkdir(source);
  await writeFile(path.join(source, "current.json"), `${JSON.stringify({
    v: 2,
    generation: GENERATION,
  })}\n`);

  await assert.rejects(
    readV070Store(source),
    ({ code }) => code === "legacy_source_invalid",
  );
});

test("migration processes every legacy field item and reports full details", () => {
  const oversizedAlias = "x".repeat(5_000);
  const converted = convertV070(sourceWith([
    legacyRecord({
      id: "record:unbounded-report",
      aliases: [
        ...Array.from({ length: 10_001 }, (_, index) => index),
        oversizedAlias,
      ],
    }),
  ]));
  assert.equal(converted.records.length, 1);
  assert.equal(converted.report.skipped.length, 10_001);
  assert.ok(converted.records[0].aliases.includes(oversizedAlias));
  assert.equal(
    converted.report.skipped.some(({ reason }) => reason === "field_processing_limit"),
    false,
  );
  assert.equal(converted.report.reporting.truncated, false);
  assert.deepEqual(converted.report.reporting.sections.skipped, {
    entries_total: 10_001,
    entries_reported: 10_001,
    entries_omitted: 0,
  });
});

test("dry-run imports more than the former legacy record ceiling", {
  timeout: 300_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-record-volume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "legacy");
  const generationRoot = path.join(source, "generations", GENERATION);
  await mkdir(path.join(generationRoot, "records", "projects"), { recursive: true });
  await mkdir(path.join(generationRoot, "schema"), { recursive: true });
  await writeFile(path.join(source, "current.json"), `${JSON.stringify({
    v: 1,
    generation: GENERATION,
  })}\n`);
  await writeFile(path.join(generationRoot, "catalog.json"), `${JSON.stringify({
    v: 1,
    projects: [],
  })}\n`);
  await writeFile(path.join(generationRoot, "schema", "store.json"), "{\"v\":1}\n");
  const records = Array.from({ length: 100_001 }, (_, index) => JSON.stringify(
    legacyRecord({ id: `record:${index}` }),
  )).join("\n");
  await writeFile(
    path.join(generationRoot, "records", "global.jsonl"),
    `${records}\n`,
  );

  const report = await importV070({
    sourcePath: source,
    database: path.join(directory, "destination.db"),
    dryRun: true,
    now: () => new Date("2026-07-30T12:00:00.000Z"),
  });
  assert.equal(report.imported.records, 100_001);
  assert.equal(report.skipped.length, 0);
  assert.equal(report.validation.doctor_ok, true);
});
