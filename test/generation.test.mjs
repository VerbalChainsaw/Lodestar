import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "../lib/generation.mjs";

function source(overrides = {}) {
  return {
    catalog: { v: 1, projects: [] },
    schema: { v: 1, record_kinds: ["rule"] },
    globalRecords: [{
      v: 1,
      id: "g:bootstrap",
      kind: "rule",
      priority: 1000,
      scope: ["global"],
      links: [],
    }],
    projectRecords: {},
    indexes: {},
    ...overrides,
  };
}

async function fixture(run) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lodestar-generation-"));
  try {
    await mkdir(path.join(home, "generations"));
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("builds a content-addressed immutable generation", async () => {
  await fixture(async (home) => {
    const first = await buildGeneration({ home, source: source() });
    const second = await buildGeneration({ home, source: source() });

    assert.equal(first.id, second.id);
    assert.match(first.id, /^[a-f0-9]{64}$/);
    assert.equal(
      await readFile(path.join(first.root, "records", "global.jsonl"), "utf8"),
      '{"id":"g:bootstrap","kind":"rule","links":[],"priority":1000,"scope":["global"],"v":1}\n',
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(first.root, "catalog.json"), "utf8")),
      { projects: [], v: 1 },
    );
  });
});

test("builds generation-stamped indexes before promotion", async () => {
  await fixture(async (home) => {
    const generation = await buildGeneration({
      home,
      source: source(),
      indexBuilder: async (id) => ({
        "routes.json": {
          v: 1,
          generation: id,
          records: {},
        },
        "search/global.json": {
          v: 1,
          generation: id,
          scope: "global",
          terms: {},
        },
      }),
    });
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(generation.root, "indexes", "routes.json"),
          "utf8",
        ),
      ).generation,
      generation.id,
    );
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(generation.root, "indexes", "search", "global.json"),
          "utf8",
        ),
      ).generation,
      generation.id,
    );
  });
});

test("promotes one pointer only after the generation exists", async () => {
  await fixture(async (home) => {
    const generation = await buildGeneration({ home, source: source() });
    await promoteGeneration({ home, generation });
    const current = await readCurrentGeneration(home);
    assert.equal(current.id, generation.id);
    assert.equal(current.root, generation.root);
  });
});

test("pointer promotion failure leaves the previous generation active", async () => {
  await fixture(async (home) => {
    const oldGeneration = await buildGeneration({ home, source: source() });
    await promoteGeneration({ home, generation: oldGeneration });
    const newGeneration = await buildGeneration({
      home,
      source: source({
        globalRecords: [{
          ...source().globalRecords[0],
          id: "g:replacement",
        }],
      }),
    });
    const fsApi = {
      rename: async (from, to) => {
        if (to === path.join(home, "current.json")) {
          throw Object.assign(new Error("simulated"), { code: "EIO" });
        }
        return rename(from, to);
      },
      writeFile,
    };

    await assert.rejects(
      promoteGeneration({ home, generation: newGeneration, fsApi }),
      (error) =>
        error.code === "atomic-replace-failed"
        && error.cause?.code === "EIO",
    );
    assert.equal((await readCurrentGeneration(home)).id, oldGeneration.id);
  });
});

test("a captured generation stays stable after pointer replacement", async () => {
  await fixture(async (home) => {
    const oldGeneration = await buildGeneration({ home, source: source() });
    await promoteGeneration({ home, generation: oldGeneration });
    const captured = await readCurrentGeneration(home);
    const newGeneration = await buildGeneration({
      home,
      source: source({
        globalRecords: [{
          ...source().globalRecords[0],
          id: "g:new",
        }],
      }),
    });
    await promoteGeneration({ home, generation: newGeneration });

    assert.equal(captured.id, oldGeneration.id);
    assert.equal(
      JSON.parse(await readFile(path.join(captured.root, "catalog.json"), "utf8")).v,
      1,
    );
    assert.equal((await readCurrentGeneration(home)).id, newGeneration.id);
  });
});
