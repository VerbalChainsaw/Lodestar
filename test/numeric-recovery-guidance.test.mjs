import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

for (const field of ["content_json", "metadata_json"]) {
  for (const id of ["-h", "--raw", "--", "record with spaces", "record;&$(literal)`"]) {
    test(`numeric ${field} recovery reads literal ${id} without changing evidence`, async (t) => {
      const f = await fixture(t);
      await f.create(id, "knowledge", { numeric_marker: 0 });
      const raw = new DatabaseSync(f.database);
      // The fixture deliberately admits a legacy unsafe number to test the public correction path.
      raw.function("lodestar_write_contract", () => 5);
      let original;
      try {
        if (field === "content_json") {
          original = raw.prepare("SELECT content_json FROM records WHERE id=?").get(id).content_json
            .replace('"numeric_marker":0', '"numeric_marker":9007199254740993');
          raw.prepare("UPDATE records SET content_json=? WHERE id=?").run(original, id);
        } else {
          original = '{"inspection":"unknown","numeric_marker":9007199254740993}';
          raw.prepare("INSERT INTO sources VALUES (?,?,?,?)").run(id, "fixture:legacy", "unknown", original);
        }
      } finally { raw.close(); }
      const before = await digest(f.database);
      const ordinary = await f.cli(["get", "--", id]);
      assert.equal(ordinary.value.error?.code, "record_requires_source_correction");
      const error = ordinary.value.error;
      assert.equal(error.identifiers.field, field);
      assert.equal(error.identifiers.value, "9007199254740993");
      assert.match(error.identifiers.pointer, /numeric_marker$/u);
      assert.deepEqual(error.identifiers.raw_read_args, ["get", "--raw", "--", id]);
      assert.ok(error.action.includes(JSON.stringify(error.identifiers.raw_read_args)));
      const inspected = await f.cli(error.identifiers.raw_read_args);
      assert.equal(inspected.code, 0);
      assert.equal(inspected.value.operation, "get");
      assert.equal(inspected.value.data.raw_record.id, id);
      assert.equal(field === "content_json" ? inspected.value.data.raw_record.content_json
        : inspected.value.data.raw_associations.sources[0].metadata_json, original);
      assert.equal(await digest(f.database), before);
    });
  }
}
