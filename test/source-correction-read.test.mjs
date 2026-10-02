import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

test("source correction advertises literal public raw-read arguments", async (t) => {
  const f = await fixture(t);
  const id = "-h";
  const created = await f.create(id, "fact", { note: "preserve source" });
  assert.equal(created.code, 0);
  const damaged = new DatabaseSync(f.database);
  damaged.function("lodestar_write_contract", () => 5);
  damaged.prepare("UPDATE records SET content_json=json_remove(content_json, '$._lodestar.semantics') WHERE id=?").run(id);
  damaged.close();
  const before = await readFile(f.database);
  const result = await f.cli(["get", "--", id]);
  assert.equal(result.value.error.code, "record_requires_source_correction");
  const args = result.value.error.identifiers.raw_read_args;
  assert.deepEqual(args, ["get", "--raw", "--", id]);
  assert.match(result.value.error.action, /argument array|args/u);
  const raw = await f.cli(args);
  assert.equal(raw.code, 0);
  assert.equal(raw.value.data.raw_record.id, id);
  assert.deepEqual(await readFile(f.database), before);
});
