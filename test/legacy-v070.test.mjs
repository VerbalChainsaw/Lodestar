import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

  for (const item of cases) {
    const converted = convertV070(sourceWith([item.record], {
      v: 1,
      generation: GENERATION,
      locators: { [item.key]: item.health },
    }));
    const entries = converted.report.unsupported.filter(
      ({ kind, identifier }) =>
        kind === "locator_health" && identifier === item.key,
    );
    assert.deepEqual(entries.map((entry) => ({ ...entry })), [{
      kind: "locator_health",
      identifier: item.key,
      source: "indexes/locator-health.json",
      reason: "unimported_locator_health",
      disposition: "not_imported",
    }], item.key);
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

test("migration reporting is bounded and preserves omission counts", () => {
  const converted = convertV070(sourceWith([
    legacyRecord({
      id: "record:report-bound",
      aliases: Array.from({ length: 2_505 }, (_, index) => index),
    }),
  ]));
  assert.equal(converted.records.length, 1);
  assert.equal(converted.report.skipped.length, 2_000);
  assert.equal(converted.report.reporting.truncated, true);
  assert.deepEqual(converted.report.reporting.sections.skipped, {
    entries_total: 2_505,
    entries_reported: 2_000,
    entries_omitted: 505,
  });
});
