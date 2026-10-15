import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeDatabase, openWriteDatabase } from "../src/database.mjs";
import { getRecord, normalizeRecord, putRecord, writeBasis } from "../src/records.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-json-values-"));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file);
  const db = await openWriteDatabase(file);
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  return { db, request: (id, input) => ({ v: 5, request_id: `json-value:${++sequence}`,
    write_basis: writeBasis(db, { targets: [{ kind: "record", id }] }), input }) };
}

const record = (id, data) => ({ id, kind: "fact", name: id, scope: "global",
  data, aliases: [], links: [], sources: [] });

for (const [label, value] of [["null", null], ["false", false], ["zero", 0],
  ["empty string", ""], ["array", [null, false, 0, ""]]]) {
  test(`application JSON ${label} survives create, get, replace and exact replay`, async (t) => {
    const { db, request } = await fixture(t);
    const id = `fact:${label}`;
    const create = request(id, { mode: "create", record: record(id, value) });
    const created = putRecord(db, create);
    assert.deepEqual(created.data.data, value);
    assert.deepEqual(normalizeRecord(getRecord(db, id)).data, value);
    const replayedCreate = putRecord(db, create);
    assert.equal(replayedCreate.request.replayed, true);
    assert.deepEqual(replayedCreate.data, created.data);

    putRecord(db, request(id, { mode: "replace", record: record(id, { temporary: true }) }));
    const replace = request(id, { mode: "replace", record: record(id, value) });
    const replaced = putRecord(db, replace);
    assert.deepEqual(replaced.data.data, value);
    assert.deepEqual(normalizeRecord(getRecord(db, id)).data, value);
    const replayedReplace = putRecord(db, replace);
    assert.equal(replayedReplace.request.replayed, true);
    assert.deepEqual(replayedReplace.data, replaced.data);

    const updated = putRecord(db, request(id, { mode: "update", id,
      set: { name: "Metadata changed" }, remove: [] }));
    assert.equal(updated.data.name, "Metadata changed");
    assert.deepEqual(updated.data.data, value);
    const before = normalizeRecord(getRecord(db, id));
    for (const input of [{ set: { data: { forbidden: true } }, remove: [] },
      { set: {}, remove: ["forbidden"] }]) {
      assert.throws(() => putRecord(db, request(id, { mode: "update", id, ...input })),
        ({ code }) => code === "invalid_mutation_contract");
      assert.deepEqual(normalizeRecord(getRecord(db, id)), before);
    }
  });
}
