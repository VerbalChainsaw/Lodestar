import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { run } from "../agentctx.mjs";
import { withStoreFixture } from "../test-support/store-fixture.mjs";

test("agent follows start, get, resolve, then scoped find", async () => {
  await withStoreFixture(async (home) => {
    const root = path.join(home, "project");
    await mkdir(root);
    return {
      catalog: {
        v: 1,
        projects: [{ id: "p:demo", name: "Demo", roots: [root] }],
      },
      schema: { v: 1, record_kinds: ["rule", "index", "command"] },
      globalRecords: [{
        v: 1,
        id: "g:behavior",
        kind: "rule",
        priority: 1000,
        required: true,
        scope: ["global"],
        action: ["use linked context before repository search"],
        links: [],
      }],
      projectRecords: {
        "p:demo": [{
          v: 1,
          id: "p:demo:entrypoints",
          kind: "index",
          priority: 900,
          required: true,
          scope: ["project:p:demo"],
          summary: "Project entrypoints",
          links: ["p:demo:commands", "p:demo:docs"],
        }, {
          v: 1,
          id: "p:demo:commands",
          kind: "command",
          priority: 850,
          scope: ["project:p:demo"],
          commands: { test: "npm test" },
          links: [],
        }, {
          v: 1,
          id: "p:demo:docs",
          kind: "index",
          priority: 800,
          scope: ["project:p:demo"],
          summary: "Release rollback documentation",
          links: [],
        }],
      },
      root,
    };
  }, async ({ home, source }) => {
    async function command(...args) {
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
      assert.equal(code, 0);
      assert.deepEqual(errors, []);
      return output[0];
    }

    const startup = await command("start");
    assert.deepEqual(
      startup.required.map(({ id }) => id),
      ["g:behavior", "p:demo:entrypoints"],
    );

    const entrypoint = await command("get", "p:demo:entrypoints");
    assert.deepEqual(entrypoint.links, [
      "p:demo:commands",
      "p:demo:docs",
    ]);

    const linked = await command(
      "resolve",
      "p:demo:entrypoints",
      "--depth",
      "1",
    );
    assert.deepEqual(
      linked.records.map(({ id }) => id),
      ["p:demo:entrypoints", "p:demo:commands", "p:demo:docs"],
    );

    const found = await command("find", "release rollback");
    assert.deepEqual(found.results.map(({ id }) => id), ["p:demo:docs"]);
  });
});
