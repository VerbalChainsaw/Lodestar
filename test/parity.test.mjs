import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { ContextStore } from "../lib/context-store.mjs";
import { run } from "../agentctx.mjs";
import { withStoreFixture } from "./helpers/store-fixture.mjs";

const coverageCategories = [
  "identity",
  "commands",
  "architecture",
  "entrypoints",
  "environment",
  "rules",
  "hazards",
  "decisions",
  "memory",
  "answers",
];

function record(id, overrides = {}) {
  return {
    v: 1,
    id,
    kind: "index",
    priority: 700,
    scope: ["project:p:demo"],
    links: [],
    ...overrides,
  };
}

async function paritySource(home) {
  const root = path.join(home, "demo");
  const api = path.join(root, "packages", "api");
  await mkdir(api, { recursive: true });
  return {
    catalog: {
      v: 1,
      projects: [{
        id: "p:demo",
        name: "Demo Project",
        aliases: ["demo_app"],
        roots: [root],
      }],
    },
    schema: { v: 1, record_kinds: ["index", "command"] },
    globalRecords: [],
    projectRecords: {
      "p:demo": [
        record("p:demo:profile", {
          covers: coverageCategories,
          summary: "Complete project profile",
        }),
        record("p:demo:commands", {
          kind: "command",
          covers: ["commands"],
          commands: { test: "npm test" },
        }),
        record("p:demo:api-rule", {
          required: true,
          within: "packages/api",
          summary: "API-only rule",
        }),
      ],
    },
    root,
    api,
  };
}

test("project lookup and path-scoped records preserve private-engine behavior", async () => {
  await withStoreFixture(paritySource, async ({ home, source }) => {
    const rootStore = await ContextStore.open({ home, cwd: source.root });
    assert.equal(rootStore.projectByName("demo app").id, "p:demo");
    assert.deepEqual((await rootStore.get("p:demo")).roots, [source.root]);
    const startup = await rootStore.start();
    assert.equal(startup.agent, "codex");
    assert.deepEqual(startup.project.roots, [source.root]);
    assert.equal(
      startup.required.some(({ id }) =>
        id === "p:demo:api-rule"),
      false,
    );

    const apiStore = await ContextStore.open({ home, cwd: source.api });
    assert.equal(
      (await apiStore.start()).required.some(({ id }) =>
        id === "p:demo:api-rule"),
      true,
    );
  });
});

test("put writes through a new generation, rebuilds indexes, and audits", async () => {
  await withStoreFixture(paritySource, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.root });
    await store.put(record("p:demo:new-answer", {
      kind: "index",
      aliases: ["new answer"],
      summary: "A newly curated answer",
    }));
    const reopened = await ContextStore.open({ home, cwd: source.root });
    assert.equal((await reopened.get("p:demo:new-answer")).summary,
      "A newly curated answer");
    assert.deepEqual(
      (await reopened.find("new answer")).results.map(({ id }) => id),
      ["p:demo:new-answer"],
    );
    const event = JSON.parse(
      (await readFile(path.join(home, "events.jsonl"), "utf8")).trim(),
    );
    assert.equal(event.op, "put");
    assert.equal(event.id, "p:demo:new-answer");
    assert.equal(JSON.stringify(event).includes("newly curated"), false);
  });
});

test("concurrent puts do not lose records", async () => {
  await withStoreFixture(paritySource, async ({ home, source }) => {
    const first = await ContextStore.open({ home, cwd: source.root });
    const second = await ContextStore.open({ home, cwd: source.root });
    await Promise.all([
      first.put(record("p:demo:first")),
      second.put(record("p:demo:second")),
    ]);
    const reopened = await ContextStore.open({ home, cwd: source.root });
    assert.equal((await reopened.get("p:demo:first")).id, "p:demo:first");
    assert.equal((await reopened.get("p:demo:second")).id, "p:demo:second");
  });
});

test("coverage and ask return deterministic project context", async () => {
  await withStoreFixture(paritySource, async ({ home, source }) => {
    const store = await ContextStore.open({ home, cwd: source.root });
    const coverage = await store.coverage({ project: "demo_app" });
    assert.equal(coverage.complete, 1);
    assert.deepEqual(coverage.projects[0].missing, []);

    const answer = await store.ask("project.commands", "p:demo");
    assert.equal(answer.project, "p:demo");
    assert.deepEqual(answer.record_ids, [
      "p:demo:commands",
      "p:demo:profile",
    ]);
  });
});

test("doctor reports missing roots and broken links without crashing", async () => {
  await withStoreFixture(paritySource, async ({ home, generation, source }) => {
    source.catalog.projects[0].roots.push(path.join(home, "missing-root"));
    await writeFile(
      path.join(generation.root, "catalog.json"),
      JSON.stringify(source.catalog),
    );
    const shard = path.join(
      generation.root,
      "records",
      "projects",
      "p-demo.jsonl",
    );
    const records = (await readFile(shard, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    records[0].links = ["p:demo:missing"];
    records[0].routes = { commands: "p:demo:missing-route" };
    await writeFile(
      shard,
      `${records.map(JSON.stringify).join("\n")}\n`,
    );

    const result = await (await ContextStore.open({
      home,
      cwd: source.root,
    })).doctor();
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(({ code }) => code === "missing-root"));
    assert.ok(result.issues.some(({ code }) => code === "broken-link"));
    assert.ok(result.issues.some(({ code }) => code === "broken-route"));
  });
});

test("CLI exposes put, doctor, coverage, and ask as JSON commands", async () => {
  await withStoreFixture(paritySource, async ({ home, source }) => {
    const invoke = async (...args) => {
      const output = [];
      const errors = [];
      const code = await run([
        ...args,
        "--home",
        home,
        "--cwd",
        source.root,
      ], {
        stdout: (line) => output.push(JSON.parse(line)),
        stderr: (line) => errors.push(JSON.parse(line)),
      });
      assert.equal(code, 0, JSON.stringify(errors));
      return output[0];
    };

    await invoke("put", "--json", JSON.stringify(record("p:demo:cli")));
    assert.equal((await invoke("doctor")).ok, true);
    assert.equal((await invoke("coverage", "--project", "p:demo")).complete, 1);
    assert.deepEqual(
      (await invoke("ask", "project.path", "p:demo")).value.roots,
      [source.root],
    );
  });
});
