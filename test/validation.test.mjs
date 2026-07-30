import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { canonicalStringify } from "../lib/canonical-json.mjs";
import {
  validateGraph,
  validateRecord,
} from "../lib/validation.mjs";

function record(overrides = {}) {
  return {
    v: 1,
    id: "p:sample:commands",
    kind: "command",
    priority: 800,
    scope: ["project:p:sample"],
    commands: { test: "npm test" },
    links: [],
    ...overrides,
  };
}

test("validates the versioned record contract", () => {
  assert.deepEqual(validateRecord(record()), record());
  for (const field of ["v", "id", "kind", "priority", "scope", "links"]) {
    const invalid = record();
    delete invalid[field];
    assert.throws(
      () => validateRecord(invalid),
      (error) => error.code === "invalid-record" && error.detail.field === field,
    );
  }
});

test("rejects unknown record versions and kinds", () => {
  assert.throws(
    () => validateRecord(record({ v: 2 })),
    { code: "unsupported-record-version" },
  );
  assert.throws(
    () => validateRecord(record({ kind: "mystery" })),
    (error) => error.code === "invalid-record"
      && error.detail.field === "kind",
  );
});

test("rejects duplicate IDs and broken links", () => {
  assert.throws(
    () => validateGraph({
      catalog: { v: 1, projects: [] },
      records: [record(), record()],
    }),
    { code: "duplicate-id" },
  );
  assert.throws(
    () => validateGraph({
      catalog: { v: 1, projects: [] },
      records: [record({ links: ["p:sample:missing"] })],
    }),
    { code: "broken-link" },
  );
});

test("rejects duplicate project IDs before shards can overwrite each other", () => {
  assert.throws(
    () => validateGraph({
      catalog: {
        v: 1,
        projects: [
          { id: "p:duplicate", name: "First", roots: ["/first"] },
          { id: "p:duplicate", name: "Second", roots: ["/second"] },
        ],
      },
      records: [],
    }),
    { code: "duplicate-project-id" },
  );
});

test("confines project-relative locators without requiring the target to exist", () => {
  const root = path.resolve("/projects/sample");
  assert.doesNotThrow(() => validateGraph({
    catalog: {
      v: 1,
      projects: [{ id: "p:sample", name: "Sample", roots: [root] }],
    },
    records: [record({
      kind: "index",
      locators: [{ type: "file", path: "docs/missing.md" }],
    })],
  }));
  for (const locator of [
    { type: "file", path: "../outside.md" },
    { type: "file", path: path.resolve("/outside.md") },
  ]) {
    assert.throws(
      () => validateGraph({
        catalog: {
          v: 1,
          projects: [{ id: "p:sample", name: "Sample", roots: [root] }],
        },
        records: [record({ kind: "index", locators: [locator] })],
      }),
      { code: "locator-escape" },
    );
  }
});

test("permits explicit external locators", () => {
  for (const externalPath of [
    path.resolve("/shared/standards.md"),
    String.raw`C:\Shared\standards.md`,
  ]) {
    assert.doesNotThrow(() => validateGraph({
      catalog: {
        v: 1,
        projects: [{
          id: "p:sample",
          name: "Sample",
          roots: ["/projects/sample"],
        }],
      },
      records: [record({
        kind: "index",
        locators: [{
          type: "external-file",
          path: externalPath,
        }],
      })],
    }));
  }
});

test("canonical JSON recursively orders object keys and preserves arrays", () => {
  assert.equal(
    canonicalStringify({
      zebra: 1,
      alpha: { two: 2, one: 1 },
      list: [{ beta: 2, alpha: 1 }, "z", "a"],
    }),
    '{"alpha":{"one":1,"two":2},"list":[{"alpha":1,"beta":2},"z","a"],"zebra":1}',
  );
});

test("canonical JSON omits explicitly declared volatile fields", () => {
  const first = canonicalStringify(
    { id: "x", updated_at: "one", detail: { pid: 10, stable: true } },
    { omit: new Set(["updated_at", "pid"]) },
  );
  const second = canonicalStringify(
    { id: "x", updated_at: "two", detail: { pid: 99, stable: true } },
    { omit: new Set(["updated_at", "pid"]) },
  );
  assert.equal(first, '{"detail":{"stable":true},"id":"x"}');
  assert.equal(second, first);
});
