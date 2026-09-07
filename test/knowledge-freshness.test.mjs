import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

test("get, find, and linked peers refresh local evidence without rewriting the saved observation", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source.txt");
  const original = Buffer.from("observed source");
  await writeFile(source, original);
  await f.create("project:freshness", "project", { roots: [f.root] }, "project:freshness");
  await f.create("fact:source", "fact", { observation: "original" }, "project:freshness");
  await f.create("fact:link", "fact", { note: "points at source" }, "project:freshness");
  const update = await f.request({ mode: "update", id: "fact:source", set: { sources: [{ origin: "local-source", freshness: "current",
    metadata: { inspection: "inspected", kind: "local_file", relation: "derived_from",
      locator: { base: "project_root", path: "source.txt" }, observed_at: "2026-09-07T00:00:00.000Z",
      fingerprint: { algorithm: "sha256", value: createHash("sha256").update(original).digest("hex"), bytes: original.length } } }] }, remove: [] },
  [{ kind: "record", id: "fact:source" }], "project:freshness");
  const updated = await f.cli(["put"], update);
  assert.equal(updated.code, 0, JSON.stringify(updated.value));
  const link = await f.request({ mode: "update", id: "fact:link", set: {
    links: [{ relationship: "related", to_id: "fact:source" }] }, remove: [] }, [{ kind: "record", id: "fact:link" }], "project:freshness");
  assert.equal((await f.cli(["put"], link)).code, 0);
  await writeFile(source, "changed after observation");
  const before = await readFile(f.database);
  const exact = await f.cli(["get", "fact:source"]);
  const found = await f.cli(["find", "fact:source"]);
  const linked = await f.cli(["links", "fact:link"]);
  for (const response of [exact, found, linked]) assert.equal(response.code, 0, JSON.stringify(response.value));
  for (const record of [exact.value.data, found.value.data.records[0], linked.value.data.links[0].peer]) {
    assert.equal(record.claim_status, "needs_reinspection");
    assert.equal(record.current_source_status[0].status, "changed");
    assert.equal(record.data.observation, "original");
    assert.equal(record.sources[0].metadata.fingerprint.bytes, original.length);
    assert.ok(record.write_basis.targets.some(({ id }) => id === "fact:source"));
  }
  assert.deepEqual(await readFile(f.database), before);
  const unchanged = await f.cli(["put"], { v: 5, request_id: "roundtrip-observed-record",
    write_basis: exact.value.data.write_basis, input: { mode: "replace", record: exact.value.data } });
  assert.equal(unchanged.code, 0, JSON.stringify(unchanged.value));
  assert.equal(unchanged.value.data.revision, exact.value.data.revision, "read annotations never change stored meaning");
});
