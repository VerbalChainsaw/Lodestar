import assert from "node:assert/strict";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ContextStore } from "../lib/context-store.mjs";
import { run } from "../agentctx.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

function record(id, links = [], overrides = {}) {
  return {
    v: 1,
    id,
    kind: "index",
    priority: 700,
    scope: ["project:p:current"],
    links,
    ...overrides,
  };
}

async function linkedSource(home) {
  const currentRoot = path.join(home, "current");
  const otherRoot = path.join(home, "other");
  await Promise.all([
    mkdir(currentRoot),
    mkdir(otherRoot),
  ]);
  return {
    catalog: {
      v: 1,
      projects: [
        { id: "p:current", name: "Current", roots: [currentRoot] },
        { id: "p:other", name: "Other", roots: [otherRoot] },
      ],
    },
    schema: { v: 1, record_kinds: ["index"] },
    globalRecords: [],
    projectRecords: {
      "p:current": [
        record("p:current:root", [
          "p:current:beta",
          "p:current:alpha",
        ]),
        record("p:current:alpha", ["p:current:leaf"]),
        record("p:current:beta", ["p:current:root"]),
        record("p:current:leaf"),
      ],
      "p:other": [
        record("p:other:hidden", [], {
          scope: ["project:p:other"],
        }),
      ],
    },
    currentRoot,
  };
}

test("resolve performs deterministic bounded breadth-first traversal", async () => {
  await withStoreFixture(linkedSource, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.currentRoot });
    const depthOne = await store.resolve("p:current:root");
    assert.deepEqual(
      depthOne.records.map(({ id }) => id),
      ["p:current:root", "p:current:alpha", "p:current:beta"],
    );
    assert.deepEqual(depthOne.omitted_ids, ["p:current:leaf"]);

    const depthTwo = await store.resolve("p:current:root", { depth: 2 });
    assert.deepEqual(
      depthTwo.records.map(({ id }) => id),
      [
        "p:current:root",
        "p:current:alpha",
        "p:current:beta",
        "p:current:leaf",
      ],
    );
    assert.equal(depthTwo.truncated, false);
    assert.deepEqual(depthTwo.omitted_ids, []);
  });
});

test("resolve rejects depths above the hard maximum before reads", async () => {
  await withStoreFixture(linkedSource, async ({ home, source }) => {
    const reads = [];
    const fsApi = {
      realpath,
      async readFile(file, encoding) {
        reads.push(file);
        return readFile(file, encoding);
      },
    };
    const store = await ContextStore.open({
      home,
      cwd: source.currentRoot,
      fsApi,
    });
    const readsAfterOpen = reads.length;
    await assert.rejects(
      store.resolve("p:current:root", { depth: 4 }),
      { code: "resolve-depth-exceeded" },
    );
    assert.equal(reads.length, readsAfterOpen);
  });
});

test("resolve reports but does not follow denied cross-project links", async () => {
  await withStoreFixture(async (home) => {
    const source = await linkedSource(home);
    source.projectRecords["p:current"][0].links.push("p:other:hidden");
    return source;
  }, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.currentRoot });
    const result = await store.resolve("p:current:root");
    assert.equal(
      result.records.some(({ id }) => id === "p:other:hidden"),
      false,
    );
    assert.deepEqual(result.warnings, [{
      code: "scope-denied",
      id: "p:other:hidden",
    }]);
  });
});

test("resolve enforces the record budget and exposes omitted IDs", async () => {
  await withStoreFixture(async (home) => {
    const source = await linkedSource(home);
    const children = Array.from(
      { length: 30 },
      (_, index) => `p:current:child-${String(index).padStart(2, "0")}`,
    );
    source.projectRecords["p:current"][0].links = children;
    source.projectRecords["p:current"].push(
      ...children.map((id) => record(id)),
    );
    return source;
  }, async ({ home, source }) => {
    const result = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).resolve("p:current:root");
    assert.equal(result.records.length, 24);
    assert.equal(result.truncated, true);
    assert.equal(result.omitted_ids.length, 7);
    assert.equal(result.omitted_ids[0], "p:current:child-23");
  });
});

test("resolve enforces its byte budget without dropping the root", async () => {
  await withStoreFixture(async (home) => {
    const source = await linkedSource(home);
    const children = ["a", "b", "c"].map((suffix) =>
      `p:current:large-${suffix}`);
    source.projectRecords["p:current"][0].links = children;
    source.projectRecords["p:current"].push(
      ...children.map((id) => record(id, [], {
        summary: "x".repeat(8_000),
      })),
    );
    return source;
  }, async ({ home, source }) => {
    const result = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).resolve("p:current:root");
    assert.equal(result.records[0].id, "p:current:root");
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024);
    assert.equal(result.truncated, true);
    assert.ok(result.omitted_ids.length > 0);
  });
});

test("resolve is available through the JSON CLI", async () => {
  await withStoreFixture(linkedSource, async ({ home, source }) => {
    const stdout = [];
    const stderr = [];
    const code = await run([
      "resolve",
      "p:current:root",
      "--depth",
      "2",
      "--home",
      home,
      "--cwd",
      source.currentRoot,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    assert.equal(JSON.parse(stdout[0]).records.length, 4);
  });
});
