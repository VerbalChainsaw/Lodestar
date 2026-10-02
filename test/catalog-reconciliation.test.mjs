import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

async function catalogFixture(t) {
  const f = await fixture(t);
  const primary = path.join(f.root, "primary"), alternate = path.join(f.root, "alternate");
  await mkdir(primary); await mkdir(alternate);
  const catalog = path.join(f.root, "projects.json");
  await f.create("project:one", "project", { roots: [primary, alternate], local_note: "keep" }, "project:one");
  await f.create("config:lodestar:sources", "config", { catalog_sources: [
    { id: "test", locator: catalog, source_owned_fields: ["name", "path", "aliases"] },
  ] });
  const entries = [{ id: "one", name: "One", path: primary, aliases: ["one"], description: "original" }];
  const write = () => writeFile(catalog, JSON.stringify({ projects: entries }));
  await write();
  const start = async (cwd = primary) => (await f.cli(["start", "--cwd", cwd])).value.data;
  let sequence = 0;
  const apply = async (preview) => {
    assert.equal(preview.status, "reconciliation_available", JSON.stringify(preview));
    const result = await f.cli(["put"], { v: 5, request_id: `catalog-${++sequence}`,
      write_basis: preview.write_basis, input: preview.input });
    assert.equal(result.code, 0, JSON.stringify(result.value));
  };
  return { ...f, primary, alternate, entries, write, start, apply };
}

test("catalog updates preserve extra roots and replace only the former catalog primary", async (t) => {
  const f = await catalogFixture(t);
  // Reconciliation can begin from an already known alternate root.
  await f.apply((await f.start(f.alternate)).catalog[0]);
  assert.equal((await f.start(f.alternate)).project.id, "project:one");
  f.entries[0].description = "description-only change"; await f.write();
  await f.apply((await f.start()).catalog[0]);
  assert.deepEqual((await f.cli(["get", "project:one"])).value.data.data.roots,
    [f.primary, f.alternate].map(p => p.replaceAll("\\", "/")));
  const moved = path.join(f.root, "moved"); await mkdir(moved);
  f.entries[0].path = moved; await f.write();
  await f.apply((await f.start()).catalog[0]);
  const record = (await f.cli(["get", "project:one"])).value.data;
  assert.deepEqual(record.data.roots, [moved, f.alternate].map(p => p.replaceAll("\\", "/")));
  assert.equal(record.data.local_note, "keep");
  for (const cwd of [moved, f.alternate]) {
    const result = await f.start(cwd);
    assert.equal(result.project.id, "project:one");
    assert.equal(result.catalog[0].status, "unchanged");
  }
  assert.notEqual((await f.start(f.primary)).project.id, "project:one");
});

test("shared catalog aliases preserve an existing native owner without unusable proposals", async (t) => {
  const f = await catalogFixture(t);
  const other = path.join(f.root, "other"); await mkdir(other);
  await f.create("project:other", "project", { roots: [other] }, "project:other");
  const request = await f.request({ mode: "update", id: "project:other", set: { aliases: ["shared"] }, remove: [] },
    [{ kind: "record", id: "project:other" }]);
  assert.equal((await f.cli(["put"], request)).code, 0);
  f.entries[0].aliases.push("SHARED");
  f.entries.push({ name: "Other", path: other, aliases: ["shared"] }); await f.write();
  const preview = (await f.start()).catalog[0];
  assert.deepEqual(preview.ambiguous_aliases.map(x => x.alias), ["SHARED"]);
  await f.apply(preview);
  assert.equal((await f.cli(["get", "shared"])).value.data.id, "project:other");
  assert.equal((await f.cli(["get", "one"])).value.data.id, "project:one");
  f.entries[0].description = "later edit"; await f.write();
  await f.apply((await f.start()).catalog[0]);
  assert.equal((await f.cli(["get", "shared"])).value.data.id, "project:other");
  await f.apply((await f.start(other)).catalog[0]);
  assert.equal((await f.cli(["get", "shared"])).value.data.id, "project:other");
});

test("a shared alias with no native owner stays ambiguous regardless of reconciliation order", async (t) => {
  const f = await catalogFixture(t);
  const other = path.join(f.root, "other"); await mkdir(other);
  await f.create("project:other", "project", { roots: [other] }, "project:other");
  f.entries[0].aliases.push("shared");
  f.entries.push({ name: "Other", path: other, aliases: ["other", "SHARED"] }); await f.write();
  for (const cwd of [other, f.primary]) await f.apply((await f.start(cwd)).catalog[0]);
  assert.equal((await f.cli(["get", "shared"])).value.error.code, "record_not_found");
  assert.equal((await f.cli(["get", "one"])).value.data.id, "project:one");
  assert.equal((await f.cli(["get", "other"])).value.data.id, "project:other");
});

test("unique catalog aliases owned by another record return a conflict before mutation", async (t) => {
  const f = await catalogFixture(t);
  await f.create("legacy:one", "fact", { text: "preserve" });
  const request = await f.request({ mode: "update", id: "legacy:one", set: { aliases: ["one"] }, remove: [] },
    [{ kind: "record", id: "legacy:one" }]);
  assert.equal((await f.cli(["put"], request)).code, 0);
  const preview = (await f.start()).catalog[0];
  assert.equal(preview.status, "project_conflict");
  assert.equal(preview.reason, "alias_ownership");
  assert.equal(preview.input, undefined);
});

test("catalog source evidence refreshes after an unrelated entry changes", async (t) => {
  const f = await catalogFixture(t);
  await f.apply((await f.start()).catalog[0]);
  f.entries.push({ name: "Unrelated", path: path.join(f.root, "unrelated") }); await f.write();
  await f.apply((await f.start()).catalog[0]);
  const record = (await f.cli(["get", "project:one"])).value.data;
  assert.equal(record.current_source_status[0].status, "unchanged");
  assert.equal((await f.start()).catalog[0].status, "unchanged");
});

test("native aliases retain the exact case-sensitive identity contract", async (t) => {
  const f = await catalogFixture(t);
  await f.create("index:one", "index", { text: "portfolio" });
  const request = await f.request({ mode: "update", id: "index:one", set: { aliases: ["ONE"] }, remove: [] },
    [{ kind: "record", id: "index:one" }]);
  assert.equal((await f.cli(["put"], request)).code, 0);
  await f.apply((await f.start()).catalog[0]);
  assert.equal((await f.cli(["get", "one"])).value.data.id, "project:one");
  assert.equal((await f.cli(["get", "ONE"])).value.data.id, "index:one");
});
