import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { run } from "../agentctx.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { migrateLegacyStore } from "../tools/migrate-legacy.mjs";

async function writeLegacyStore(root, projectRoot, {
  context = "records/projects/demo.jsonl",
} = {}) {
  await mkdir(path.join(root, "records", "projects"), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(root, "catalog.json"), JSON.stringify({
    v: 1,
    projects: [{
      id: "p:demo",
      name: "Demo",
      aliases: ["demo"],
      roots: [projectRoot],
      context,
    }],
  }));
  await writeFile(
    path.join(root, "records", "global.jsonl"),
    `${JSON.stringify({
      id: "g:rules",
      kind: "rule",
      priority: 1_000,
      required: true,
      scope: ["global"],
      links: [],
      action: ["preserve-context"],
    })}\n`,
  );
  if (!context.includes("..")) {
    await writeFile(
      path.join(root, context),
      [
        {
          id: "p:demo:index",
          kind: "index",
          priority: 900,
          required: true,
          links: ["p:demo:commands"],
          locators: [{ path: "README.md", role: "entrypoint" }],
          routes: { GET: ["/health", "/ready"] },
        },
        {
          id: "p:demo:commands",
          kind: "command",
          priority: 800,
          required: false,
          links: [],
          commands: { test: "node --test" },
        },
      ].map(JSON.stringify).join("\n") + "\n",
    );
  }
}

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-legacy-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("legacy migration is lossless, atomic, and leaves its source untouched", async () => {
  await withTemp(async (root) => {
    const legacy = path.join(root, "legacy");
    const projectRoot = path.join(root, "project");
    const home = path.join(root, "lodestar");
    await writeLegacyStore(legacy, projectRoot);
    const sourceBefore = await readFile(
      path.join(legacy, "records", "projects", "demo.jsonl"),
      "utf8",
    );

    const preview = await migrateLegacyStore({
      home,
      sourceHome: legacy,
      dryRun: true,
    });
    assert.deepEqual(
      {
        ok: preview.ok,
        dry_run: preview.dry_run,
        projects: preview.projects,
        records: preview.records,
      },
      { ok: true, dry_run: true, projects: 1, records: 3 },
    );
    await assert.rejects(access(home));

    const result = await migrateLegacyStore({
      home,
      sourceHome: legacy,
      now: () => new Date("2026-07-29T20:00:00.000Z"),
    });
    assert.equal(result.migrated, true);
    assert.equal(result.projects, 1);
    assert.equal(result.records, 3);

    const store = await ContextStore.open({ home, cwd: projectRoot });
    const source = await store.sourceSnapshot();
    assert.equal(source.catalog.projects[0].context, undefined);
    assert.deepEqual(
      source.globalRecords.map(({ id, v, scope }) => ({ id, v, scope })),
      [{ id: "g:rules", v: 1, scope: ["global"] }],
    );
    const [index, commands] = source.projectRecords["p:demo"];
    assert.equal(index.id, "p:demo:commands");
    assert.equal(commands.id, "p:demo:index");
    assert.equal(commands.v, 1);
    assert.deepEqual(commands.scope, ["project:p:demo"]);
    assert.equal(commands.locators[0].type, "file");
    assert.deepEqual(commands.legacy_routes, {
      GET: ["/health", "/ready"],
    });
    assert.equal(commands.routes, undefined);
    assert.equal(
      (await store.find("ready")).results[0].id,
      "p:demo:index",
    );
    assert.match(
      await readFile(path.join(home, "events.jsonl"), "utf8"),
      /"op":"migrate-legacy"/,
    );
    assert.equal(
      await readFile(
        path.join(legacy, "records", "projects", "demo.jsonl"),
        "utf8",
      ),
      sourceBefore,
    );

    await assert.rejects(
      migrateLegacyStore({ home, sourceHome: legacy }),
      { code: "legacy-migration-destination-exists" },
    );
  });
});

test("legacy migration rejects context traversal and CLI reports structured errors", async () => {
  await withTemp(async (root) => {
    const legacy = path.join(root, "legacy");
    const projectRoot = path.join(root, "project");
    const home = path.join(root, "lodestar");
    await writeLegacyStore(legacy, projectRoot, {
      context: "../outside.jsonl",
    });
    const stdout = [];
    const stderr = [];
    const exitCode = await run([
      "migrate-legacy",
      "--from",
      legacy,
      "--home",
      home,
    ], {
      cwd: root,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(stdout, []);
    const failure = JSON.parse(stderr[0]);
    assert.equal(failure.error.code, "legacy-path-invalid");
    await assert.rejects(access(home));
  });
});
