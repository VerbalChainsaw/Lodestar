import assert from "node:assert/strict";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { atomicWriteFile } from "../lib/atomic-file.mjs";
import { ContextStore } from "../lib/context-store.mjs";
import { buildGeneration } from "../lib/generation.mjs";
import { maintainStore } from "../lib/maintenance.mjs";
import { createSnapshot } from "../lib/snapshot.mjs";
import { initializeStateHome } from "../lib/state-home.mjs";

async function temporary(runTest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "lodestar-fault-"));
  try {
    await runTest(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function source() {
  return {
    catalog: { v: 1, projects: [] },
    schema: { v: 1, record_kinds: ["answer"] },
    globalRecords: [{
      v: 1,
      id: "g:fault",
      kind: "answer",
      priority: 100,
      scope: ["global"],
      links: [],
    }],
    projectRecords: {},
    indexes: {},
  };
}

function record(id) {
  return {
    v: 1,
    id,
    kind: "answer",
    priority: 100,
    scope: ["global"],
    links: [],
  };
}

test("atomic staging failure preserves its cause and removes its temp file", async () => {
  await temporary(async (root) => {
    const target = path.join(root, "current.json");
    await writeFile(target, "before");
    const temporary = `${target}.tmp-fixed`;
    const fsApi = {
      async open(file, flags) {
        const handle = await open(file, flags);
        return {
          async sync() {
            throw Object.assign(new Error("simulated fsync failure"), {
              code: "EIO",
            });
          },
          async close() {
            await handle.close();
          },
        };
      },
    };
    await assert.rejects(
      atomicWriteFile(target, "after", {
        fsApi,
        nonce: () => "fixed",
      }),
      { code: "atomic-write-temp-failed" },
    );
    assert.equal(await readFile(target, "utf8"), "before");
    await assert.rejects(access(temporary), { code: "ENOENT" });
  });
});

test("directory sync failure after rename reports committed uncertainty", async () => {
  await temporary(async (root) => {
    const target = path.join(root, "current.json");
    await writeFile(target, "before");
    const fsApi = {
      async open(file, flags) {
        if (file === root) {
          throw Object.assign(new Error("simulated directory fsync failure"), {
            code: "EIO",
          });
        }
        return open(file, flags);
      },
    };
    const result = await atomicWriteFile(target, "after", { fsApi });
    assert.equal(result.committed, true);
    assert.equal(result.directory_sync.uncertain, true);
    assert.equal(await readFile(target, "utf8"), "after");
  });
});

test("file synchronization failure leaves no partially built generation", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await mkdir(path.join(home, "generations"), { recursive: true });
    const fsApi = {
      async open() {
        return {
          async sync() {
            throw Object.assign(new Error("simulated fsync failure"), {
              code: "EIO",
            });
          },
          async close() {},
        };
      },
    };
    await assert.rejects(
      buildGeneration({ home, source: source(), fsApi }),
      { code: "file-sync-failed" },
    );
    assert.deepEqual(
      await readdir(path.join(home, "generations")),
      [],
    );
  });
});

test("partial generation writes remove the complete build transaction", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await mkdir(path.join(home, "generations"), { recursive: true });
    let writes = 0;
    const fsApi = {
      async writeFile(file, contents, encoding) {
        writes += 1;
        if (writes === 3) {
          await writeFile(file, "partial", encoding);
          throw Object.assign(new Error("simulated full disk"), {
            code: "ENOSPC",
          });
        }
        return writeFile(file, contents, encoding);
      },
    };
    await assert.rejects(
      buildGeneration({ home, source: source(), fsApi }),
      { code: "ENOSPC" },
    );
    assert.deepEqual(await readdir(path.join(home, "generations")), []);
  });
});

test("snapshot copy failure removes its sibling transaction directory", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    const destination = path.join(root, "backup");
    await initializeStateHome({ destination: home });
    let copies = 0;
    const fsApi = {
      async copyFile(sourceFile, destinationFile) {
        copies += 1;
        if (copies === 2) {
          throw Object.assign(new Error("simulated copy failure"), {
            code: "ENOSPC",
          });
        }
        return copyFile(sourceFile, destinationFile);
      },
    };
    await assert.rejects(
      createSnapshot({ home, destination, fsApi }),
      { code: "snapshot-create-failed" },
    );
    assert.equal((await readdir(root)).some((name) =>
      name.includes(".backup.snapshot-")), false);
  });
});

test("retention rename failure restores every generation already moved", async () => {
  await temporary(async (root) => {
    const home = path.join(root, "store");
    await initializeStateHome({ destination: home });
    for (let index = 0; index < 4; index += 1) {
      const store = await ContextStore.open({ home });
      await store.put(record(`g:fault:${index}`));
    }
    const before = (await readdir(path.join(home, "generations"))).sort();
    let generationMoves = 0;
    let failed = false;
    const fsApi = {
      async rename(from, to) {
        if (
          !failed
          && from.includes(`${path.sep}generations${path.sep}`)
          && to.includes(`${path.sep}quarantine${path.sep}`)
        ) {
          generationMoves += 1;
          if (generationMoves === 2) {
            failed = true;
            throw Object.assign(new Error("simulated rename failure"), {
              code: "EIO",
            });
          }
        }
        return rename(from, to);
      },
    };
    await assert.rejects(
      maintainStore({
        home,
        retain: 2,
        apply: true,
        checkDrift: false,
        fsApi,
      }),
      { code: "generation-retention-failed" },
    );
    assert.deepEqual(
      (await readdir(path.join(home, "generations"))).sort(),
      before,
    );
    const reopened = await ContextStore.open({ home });
    assert.ok(reopened.generation.id);
  });
});
