import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  initializeStateHome,
  resolveStateHome,
} from "../lib/state-home.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { readCurrentGeneration } from "../lib/generation.mjs";

test("explicit state home wins over environment overrides", () => {
  assert.equal(
    resolveStateHome({
      explicit: "./chosen",
      env: {
        LODESTAR_HOME: "/ignored/lodestar",
        AGENT_CONTEXT_HOME: "/ignored/legacy",
      },
      home: "/ignored/home",
      cwd: "/work",
    }),
    path.resolve("/work", "chosen"),
  );
});

test("LODESTAR_HOME wins over the legacy override", () => {
  assert.equal(
    resolveStateHome({
      env: {
        LODESTAR_HOME: "/state/lodestar",
        AGENT_CONTEXT_HOME: "/state/legacy",
      },
      home: "/ignored",
    }),
    path.resolve("/state/lodestar"),
  );
});

test("AGENT_CONTEXT_HOME remains a supported override", () => {
  assert.equal(
    resolveStateHome({
      env: { AGENT_CONTEXT_HOME: "/state/legacy" },
      home: "/ignored",
    }),
    path.resolve("/state/legacy"),
  );
});

test("default state home is derived from the injected home", () => {
  assert.equal(
    resolveStateHome({ env: {}, home: "/people/alex" }),
    path.resolve("/people/alex", ".lodestar"),
  );
});

test("path implementation can preserve native platform semantics", () => {
  const winPath = path.win32;
  assert.equal(
    resolveStateHome({
      env: {},
      home: String.raw`C:\Users\alex`,
      pathApi: winPath,
    }),
    String.raw`C:\Users\alex\.lodestar`,
  );
  assert.equal(
    resolveStateHome({
      env: {},
      home: "/home/alex",
      pathApi: path.posix,
    }),
    "/home/alex/.lodestar",
  );
});

test("WSL translates an explicit Windows state-home path", () => {
  assert.equal(
    resolveStateHome({
      explicit: String.raw`C:\Users\alex\.lodestar`,
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      release: "6.8.0-microsoft-standard-WSL2",
      cwd: "/work",
    }),
    "/mnt/c/Users/alex/.lodestar",
  );
});

test("initialization promotes a complete state home", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    const result = await initializeStateHome({
      destination,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    });
    assert.equal(result.created, true);
    const current = await readCurrentGeneration(destination);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(current.root, "catalog.json"), "utf8")),
      { v: 1, projects: [] },
    );
    assert.match(
      await readFile(path.join(current.root, "records", "global.jsonl"), "utf8"),
      /"g:bootstrap"/,
    );
    await access(path.join(current.root, "schema", "store.json"));
    assert.match(current.id, /^[a-f0-9]{64}$/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("an initialized blank home is immediately readable by start", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    await initializeStateHome({
      destination,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    });
    const packet = await (await ContextStore.open({
      home: destination,
      cwd: fixture,
    })).start();
    assert.deepEqual(packet.required.map(({ id }) => id), ["g:bootstrap"]);
    assert.equal(packet.project, null);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("initialization is idempotent for an existing valid state home", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    await initializeStateHome({
      destination,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    });
    const result = await initializeStateHome({
      destination,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    });
    assert.equal(result.created, false);
    assert.equal(
      (await readdir(path.join(destination, "generations"))).length,
      1,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("idempotent initialization rejects a tampered sealed state home", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    await initializeStateHome({
      destination,
      packageRoot: path.resolve(import.meta.dirname, ".."),
    });
    const current = await readCurrentGeneration(destination);
    await writeFile(
      path.join(current.root, "catalog.json"),
      `${JSON.stringify({ v: 1, projects: [{ id: "p:tampered" }] })}\n`,
    );
    await assert.rejects(
      initializeStateHome({
        destination,
        packageRoot: path.resolve(import.meta.dirname, ".."),
      }),
      { code: "integrity-checksum-mismatch" },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("initialization refuses an existing invalid directory", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    await mkdir(destination);
    await writeFile(path.join(destination, "keep.txt"), "untouched");
    await assert.rejects(
      initializeStateHome({
        destination,
        packageRoot: path.resolve(import.meta.dirname, ".."),
      }),
      { code: "invalid-state-home" },
    );
    assert.equal(
      await readFile(path.join(destination, "keep.txt"), "utf8"),
      "untouched",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed initialization leaves no destination or transaction directory", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "lodestar-state-"));
  const destination = path.join(fixture, "state");
  try {
    await assert.rejects(
      initializeStateHome({
        destination,
        packageRoot: path.resolve(fixture, "missing-package"),
      }),
    );
    await assert.rejects(access(destination));
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) =>
      readdir(fixture)), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
