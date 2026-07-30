import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIndexes,
  validateIndexes,
} from "../lib/indexes.mjs";

const generation = "a".repeat(64);

function fixtures() {
  return {
    catalog: {
      v: 1,
      projects: [{
        id: "p:sample",
        name: "Sample",
        roots: ["/work/sample"],
      }],
    },
    globalRecords: [{
      v: 1,
      id: "g:rules",
      kind: "rule",
      priority: 1000,
      scope: ["global"],
      aliases: ["Agent Behavior"],
      action: ["prefer exact context"],
      links: [],
    }],
    projectRecords: {
      "p:sample": [{
        v: 1,
        id: "p:sample:commands",
        kind: "command",
        priority: 900,
        scope: ["project:p:sample"],
        aliases: ["Test Runner"],
        topics: ["Verification"],
        summary: "Run the project test suite",
        commands: { test: "npm test" },
        links: ["p:sample:docs"],
      }, {
        v: 1,
        id: "p:sample:docs",
        kind: "index",
        priority: 700,
        scope: ["project:p:sample"],
        summary: "Release documentation",
        locators: [{
          type: "file",
          path: "docs/release.md",
          anchor: "rollback",
        }],
        links: [],
      }],
    },
  };
}

test("builds deterministic ID-to-shard routes without byte offsets", async () => {
  const input = fixtures();
  const indexes = await buildIndexes({
    generation,
    ...input,
    probeLocator: async () => ({ status: "ok" }),
  });
  assert.deepEqual(indexes["routes.json"], {
    v: 1,
    generation,
    records: {
      "g:rules": {
        shard: "records/global.jsonl",
        scope: ["global"],
      },
      "p:sample:commands": {
        shard: "records/projects/p-sample.jsonl",
        scope: ["project:p:sample"],
      },
      "p:sample:docs": {
        shard: "records/projects/p-sample.jsonl",
        scope: ["project:p:sample"],
      },
    },
  });
  assert.equal(JSON.stringify(indexes).includes("offset"), false);

  const reversed = await buildIndexes({
    generation,
    catalog: input.catalog,
    globalRecords: [...input.globalRecords].reverse(),
    projectRecords: {
      "p:sample": [...input.projectRecords["p:sample"]].reverse(),
    },
    probeLocator: async () => ({ status: "ok" }),
  });
  assert.deepEqual(reversed, indexes);
});

test("indexes only structured searchable fields by scope", async () => {
  const indexes = await buildIndexes({
    generation,
    ...fixtures(),
    probeLocator: async () => ({ status: "ok" }),
  });
  assert.deepEqual(indexes["search/global.json"], {
    v: 1,
    generation,
    scope: "global",
    terms: {
      agent: ["g:rules"],
      behavior: ["g:rules"],
      context: ["g:rules"],
      exact: ["g:rules"],
      "g:rules": ["g:rules"],
      prefer: ["g:rules"],
    },
  });
  assert.deepEqual(
    indexes["search/p-sample.json"].terms.test,
    ["p:sample:commands"],
  );
  assert.deepEqual(
    indexes["search/p-sample.json"].terms.release,
    ["p:sample:docs"],
  );
  assert.equal(
    Object.hasOwn(indexes["search/global.json"].terms, "npm"),
    false,
  );
  assert.deepEqual(
    indexes["search/p-sample.json"].terms.npm,
    ["p:sample:commands"],
  );
});

test("orders search postings by priority then record ID", async () => {
  const input = fixtures();
  input.projectRecords["p:sample"].push({
    v: 1,
    id: "p:sample:alternate",
    kind: "command",
    priority: 950,
    scope: ["project:p:sample"],
    summary: "Test alternative",
    links: [],
  });
  const indexes = await buildIndexes({
    generation,
    ...input,
    probeLocator: async () => ({ status: "ok" }),
  });
  assert.deepEqual(
    indexes["search/p-sample.json"].terms.test,
    ["p:sample:alternate", "p:sample:commands"],
  );
});

test("records locator health without reading document content", async () => {
  const calls = [];
  const indexes = await buildIndexes({
    generation,
    ...fixtures(),
    probeLocator: async (request) => {
      calls.push(request);
      return {
        status: "missing",
        checked_path: request.locator.path,
      };
    },
  });
  assert.deepEqual(calls, [{
    project: fixtures().catalog.projects[0],
    record: fixtures().projectRecords["p:sample"][1],
    locator: fixtures().projectRecords["p:sample"][1].locators[0],
  }]);
  assert.deepEqual(indexes["locator-health.json"], {
    v: 1,
    generation,
    locators: {
      "p:sample:docs#0": {
        status: "missing",
        checked_path: "docs/release.md",
      },
    },
  });
});

test("validates index generations and allowed health states", async () => {
  const indexes = await buildIndexes({
    generation,
    ...fixtures(),
    probeLocator: async () => ({ status: "unchecked" }),
  });
  assert.deepEqual(validateIndexes(indexes, generation), indexes);

  indexes["search/global.json"].generation = "b".repeat(64);
  assert.throws(
    () => validateIndexes(indexes, generation),
    { code: "index-generation-mismatch" },
  );
});

test("rejects duplicate routes", async () => {
  const input = fixtures();
  input.projectRecords["p:sample"].push({
    ...input.globalRecords[0],
    scope: ["project:p:sample"],
  });
  await assert.rejects(
    buildIndexes({
      generation,
      ...input,
      probeLocator: async () => ({ status: "ok" }),
    }),
    { code: "duplicate-route" },
  );
});
