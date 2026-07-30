import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ContextStore } from "../lib/context-store.mjs";
import {
  AGENTCTX_VERSION,
  run,
} from "../agentctx.mjs";
import { withStoreFixture } from "../test-support/store-fixture.mjs";

function baseRecord(overrides = {}) {
  return {
    v: 1,
    id: "g:rules",
    kind: "rule",
    priority: 1000,
    scope: ["global"],
    links: [],
    ...overrides,
  };
}

async function retrievalSource(home, overrides = {}) {
  const currentRoot = path.join(home, "projects", "current");
  const unrelatedRoot = path.join(home, "projects", "unrelated");
  await Promise.all([
    mkdir(currentRoot, { recursive: true }),
    mkdir(unrelatedRoot, { recursive: true }),
  ]);
  return {
    catalog: {
      v: 1,
      projects: [{
        id: "p:current",
        name: "Current",
        roots: [currentRoot],
      }, {
        id: "p:unrelated",
        name: "Unrelated",
        roots: [unrelatedRoot],
      }],
    },
    schema: { v: 1, record_kinds: ["rule", "command", "index"] },
    globalRecords: [
      baseRecord({
        required: true,
        action: ["load global behavior"],
      }),
      baseRecord({
        id: "g:optional",
        kind: "index",
        priority: 400,
        summary: "Shared optional context",
      }),
      baseRecord({
        id: "g:index:vocabulary",
        kind: "index",
        priority: 100,
        startup: false,
        vocabulary: {
          verify: ["test"],
        },
      }),
    ],
    projectRecords: {
      "p:current": [
        baseRecord({
          id: "p:current:commands",
          kind: "command",
          priority: 900,
          scope: ["project:p:current"],
          required: true,
          commands: { test: "npm test" },
          links: ["p:current:docs"],
        }),
        baseRecord({
          id: "p:current:docs",
          kind: "index",
          priority: 700,
          scope: ["project:p:current"],
          summary: "Release and rollback guide",
          locators: [{
            type: "file",
            path: "docs/release.md",
            anchor: "rollback",
          }],
        }),
      ],
      "p:unrelated": [
        baseRecord({
          id: "p:unrelated:secret",
          priority: 999,
          scope: ["project:p:unrelated"],
          summary: "Unrelated private operation",
        }),
      ],
    },
    currentRoot,
    unrelatedRoot,
    probeLocator: async ({ record, locator }) => ({
      status: record.id === "p:current:docs" ? "missing" : "unchecked",
      checked_path: locator.path,
    }),
    ...overrides,
  };
}

test("start returns required context and compact available entrypoints", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.currentRoot });
    const packet = await store.start();
    assert.equal(packet.v, 1);
    assert.equal(packet.project.id, "p:current");
    assert.deepEqual(
      packet.required.map(({ id }) => id),
      ["g:rules", "p:current:commands"],
    );
    assert.deepEqual(
      packet.available.map(({ id }) => id),
      ["p:current:docs", "g:optional"],
    );
    assert.equal(
      JSON.stringify(packet).includes("p:unrelated:secret"),
      false,
    );
    assert.equal(packet.protocol.lookup,
      "agentctx get <id> | agentctx resolve <id> | agentctx find <terms>");
  });
});

test("start exposes known-broken locator health and warnings", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.currentRoot });
    const packet = await store.start();
    const docs = packet.available.find(({ id }) => id === "p:current:docs");
    assert.equal(docs.locators[0].health.status, "missing");
    assert.deepEqual(packet.warnings, [{
      code: "locator-missing",
      id: "p:current:docs",
      locator: 0,
      next: "agentctx find release rollback",
    }]);
  });
});

test("start truncates optional cards deterministically within its byte budget", async () => {
  await withStoreFixture(async (home) => {
    const source = await retrievalSource(home);
    source.projectRecords["p:current"].push(
      ...Array.from({ length: 50 }, (_, index) => baseRecord({
        id: `p:current:large-${String(index).padStart(2, "0")}`,
        kind: "index",
        priority: 600 - index,
        scope: ["project:p:current"],
        summary: `Optional ${index} ${"x".repeat(800)}`,
      })),
    );
    return source;
  }, async ({ home, source }) => {
    const packet = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).start();
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    assert.ok(bytes > 12 * 1024);
    assert.ok(bytes <= 16 * 1024);
    assert.equal(packet.truncated, true);
    assert.ok(packet.omitted_ids.length > 0);
    assert.deepEqual(
      [...packet.omitted_ids].sort(),
      packet.omitted_ids,
    );
  });
});

test("start refuses required context that cannot fit", async () => {
  await withStoreFixture(async (home) => {
    const source = await retrievalSource(home);
    source.projectRecords["p:current"].push(baseRecord({
      id: "p:current:oversized",
      kind: "rule",
      priority: 950,
      scope: ["project:p:current"],
      required: true,
      summary: "x".repeat(20_000),
    }));
    return source;
  }, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.currentRoot });
    await assert.rejects(store.start(), { code: "startup-budget-exceeded" });
  });
});

test("find is indexed, scoped, ranked, and capped at eight cards", async () => {
  await withStoreFixture(async (home) => {
    const source = await retrievalSource(home);
    source.projectRecords["p:current"].push(
      ...Array.from({ length: 10 }, (_, index) => baseRecord({
        id: `p:current:test-${index}`,
        kind: "command",
        priority: 850 - index,
        scope: ["project:p:current"],
        summary: "Test workflow",
      })),
    );
    return source;
  }, async ({ home, source }) => {
    const result = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).find("test");
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 8);
    assert.equal(result.results[0].id, "p:current:commands");
    assert.equal(
      result.results.some(({ id }) => id.startsWith("p:unrelated")),
      false,
    );
  });
});

test("find reports an actionable scoped context miss", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const result = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).find("not-indexed-anywhere");
    assert.deepEqual(result, {
      ok: false,
      code: "context-miss",
      query: "not-indexed-anywhere",
      project: "p:current",
      results: [],
      next: ["inspect the current repository with a targeted search"],
    });
  });
});

test("find uses deterministic vocabulary reformulation within scope", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const result = await (await ContextStore.open({
      home,
      cwd: source.currentRoot,
    })).find("verify");
    assert.equal(result.ok, true);
    assert.deepEqual(result.reformulated, {
      original: ["verify"],
      terms: ["test"],
    });
    assert.equal(result.results[0].id, "p:current:commands");
  });
});

test("CLI emits one JSON result and structured JSON errors", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const stdout = [];
    const stderr = [];
    assert.equal(await run([
      "start",
      "--home",
      home,
      "--cwd",
      source.currentRoot,
      "--json",
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }), 0);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).project.id, "p:current");
    assert.deepEqual(stderr, []);

    stdout.length = 0;
    assert.equal(await run([
      "get",
      "p:unrelated:secret",
      "--home",
      home,
      "--cwd",
      source.currentRoot,
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    }), 1);
    assert.deepEqual(stdout, []);
    assert.equal(JSON.parse(stderr[0]).error.code, "scope-denied");
  });
});

test("CLI rejects a missing option value instead of treating another flag as data", async () => {
  const output = [];
  const errors = [];
  const code = await run(["start", "--home", "--cwd", "/tmp"], {
    stdout: (line) => output.push(JSON.parse(line)),
    stderr: (line) => errors.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.equal(errors[0].error.code, "invalid-option");
  assert.equal(errors[0].error.detail.option, "--home");
});

test("CLI rejects unknown and command-inapplicable options", async () => {
  for (const argv of [
    ["init", "--surprise"],
    ["migrate-legacy", "--dryrun"],
    ["get", "g:rules", "--dry-run"],
  ]) {
    const errors = [];
    const code = await run(argv, {
      stderr: (line) => errors.push(JSON.parse(line)),
      stdout: () => assert.fail("invalid options must not produce output"),
    });
    assert.equal(code, 1);
    assert.equal(errors[0].error.code, "invalid-option");
    assert.equal(errors[0].error.detail.reason, "unknown-for-command");
  }
});

test("CLI validates the command before opening a state home", async () => {
  const errors = [];
  const code = await run(["definitely-not-a-command"], {
    stdout: () => assert.fail("unexpected stdout"),
    stderr: (line) => errors.push(JSON.parse(line)),
  });
  assert.equal(code, 1);
  assert.equal(errors[0].error.code, "unknown-command");
});

test("CLI help and version succeed without opening a state home", async () => {
  for (const [argv, expected] of [
    [["--help"], /Usage:\n  agentctx <command>/],
    [["help", "doctor"], /Usage: agentctx doctor/],
    [["snapshot", "--help"], /portable snapshot/],
    [["--version"], new RegExp(`^${AGENTCTX_VERSION}$`)],
  ]) {
    const output = [];
    const errors = [];
    const code = await run(argv, {
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
      home: "/definitely/not/a/state/home",
    });
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(output.length, 1);
    assert.match(output[0], expected);
  }
});

test("CLI reports malformed JSON as an input error with a wrapped cause", async () => {
  await withStoreFixture(retrievalSource, async ({ home, source }) => {
    const errors = [];
    const code = await run([
      "put",
      "--home",
      home,
      "--cwd",
      source.currentRoot,
      "--json",
      "{not-json",
    ], {
      stdout: () => assert.fail("unexpected stdout"),
      stderr: (line) => errors.push(JSON.parse(line)),
    });
    assert.equal(code, 1);
    assert.equal(errors[0].error.code, "invalid-json");
    assert.equal(errors[0].error.detail.cause_code, null);
  });
});
