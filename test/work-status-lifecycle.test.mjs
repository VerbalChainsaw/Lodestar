import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { admittedTransaction, openWriteDatabase } from "../src/database.mjs";
import { fixture } from "./helpers/contract.mjs";

const scope = "project:work-lifecycle";
const historicalScope = "project:work-lifecycle-before";
const actor = { id: "agent:lifecycle", agent: "agent", session: "lifecycle", harness: "test" };
const target = id => ({ kind: "record", id });
const visibleIds = ["work:current-a", "work:current-b", "work:current-member", "work:unresolved"];
const ok = response => {
  assert.equal(response.code, 0, JSON.stringify(response.value));
  return response.value.data;
};
const ids = records => records.map(record => record.id).sort();

async function setup(t) {
  const f = await fixture(t);
  await f.create(scope, "project", { roots: [] }, scope);
  await f.create(historicalScope, "project", { roots: [f.root] }, historicalScope);
  const change = async (action, input, selectedScope = scope, bindingIds = [scope, historicalScope]) =>
    ok(await f.cli(["work", action, "--cwd", f.root], await f.request(input,
      [target(input.id), ...bindingIds.map(target)], selectedScope, actor)));
  await change("start", { id: "work:current-member", description: "Current work in the prior project scope" },
    historicalScope, [historicalScope]);
  ok(await f.cli(["put"], await f.request({ mode: "update", id: historicalScope,
    set: { data: { canonical_project_id: scope },
      links: [{ relationship: "canonical-project", to_id: scope }] }, remove: [],
  }, [target(scope), target(historicalScope)], historicalScope)));
  for (const id of ["work:current-a", "work:current-b", "work:current-closed"])
    await change("start", { id, description: id });
  await change("done", { id: "work:current-closed", description: "Explicitly finished current work",
    outcome: "completed", action_id: "finish:current-closed" });
  const retired = [];
  for (const lifecycle of ["unresolved", "historical", "superseded"]) {
    const id = `work:${lifecycle}`;
    await change("start", { id, description: id });
    const reported = await change("report", {
      id, outcome: "unknown", description: `Observed ${lifecycle} work`,
      action_id: `observation:${lifecycle}`, unresolved_consequence: "Retain the original unresolved outcome",
    });
    // Reserved work records cannot be retired through ordinary put/delete. Model
    // existing imported lifecycle metadata only inside this disposable fixture.
    const db = await openWriteDatabase(f.database);
    try {
      admittedTransaction(db, () => db.prepare("UPDATE records SET content_json="
        + "json_set(content_json,'$._lodestar.semantics.lifecycle',?) WHERE id=?").run(lifecycle, id), f.database);
    } finally { db.close(); }
    if (lifecycle !== "unresolved") retired.push({ id, eventId: reported.event_id, lifecycle });
  }
  return { ...f, retired };
}

test("work status retains current and unresolved open records, including canonical member scope work", async t => {
  const f = await setup(t), before = await readFile(f.database);
  const status = ok(await f.cli(["work", "status", "--cwd", f.root]));
  assert.deepEqual(ids(status.records), visibleIds);
  assert.equal(status.records.find(record => record.id === "work:current-member").scope, historicalScope);
  assert.equal(status.records.find(record => record.id === "work:unresolved").semantics.lifecycle, "unresolved");
  assert.equal(status.complete, true);
  assert.deepEqual(status.record_errors, []);
  assert.deepEqual(await readFile(f.database), before, "Status must not retire, close, or rewrite records");
});

test("start and Attention retain current and unresolved open work consistently", async t => {
  const f = await setup(t), before = await readFile(f.database);
  const start = ok(await f.cli(["start", "--cwd", f.root]));
  assert.deepEqual(ids(start.active_work), visibleIds);
  const attention = ok(await f.cli(["work", "attention", "--cwd", f.root]));
  assert.deepEqual(ids(attention.sections.work.items), visibleIds);
  assert.equal(attention.sections.work.complete, true);
  assert.equal(attention.sections.work.more, false);
  assert.equal(attention.sections.work.omitted_count, 0);
  assert.deepEqual(await readFile(f.database), before, "Orientation and Attention are read-only");
});

test("status paging and write bases exclude retired rows before applying the page limit", async t => {
  const f = await setup(t), before = await readFile(f.database);
  let args = ["work", "status", "--cwd", f.root, "--limit", "1"];
  const seen = [];
  let revision;
  for (let page = 0; page < visibleIds.length; page++) {
    const response = await f.cli(args), status = ok(response);
    revision ??= response.value.revision;
    assert.equal(response.value.revision, revision);
    assert.equal(status.records.length, 1);
    assert.ok(visibleIds.includes(status.records[0].id), "A retired record consumed an open-work page");
    seen.push(status.records[0].id);
    assert.deepEqual(ids(status.write_basis.targets), [scope, historicalScope, status.records[0].id].sort());
    const more = page < visibleIds.length - 1;
    assert.equal(status.more, more);
    assert.equal(response.value.more, more);
    if (more) {
      assert.equal(response.value.next.length, 1);
      const next = response.value.next[0];
      assert.equal(next.args[next.args.indexOf("--offset") + 1], String(page + 1));
      assert.equal(next.args[next.args.indexOf("--at-revision") + 1], String(revision));
      args = [next.command, ...next.args];
    } else assert.deepEqual(response.value.next, []);
  }
  assert.deepEqual(seen.sort(), visibleIds);
  const end = await f.cli(["work", "status", "--cwd", f.root, "--limit", "1", "--offset", String(visibleIds.length),
    "--at-revision", String(revision)]);
  assert.deepEqual(ok(end).records, []);
  assert.equal(end.value.more, false);
  assert.deepEqual(end.value.next, []);
  assert.deepEqual(ids(end.value.data.write_basis.targets), [scope, historicalScope].sort());
  assert.deepEqual(await readFile(f.database), before, "Paging must not modify lifecycle or work outcomes");
});

test("work history preserves retired open records and their unresolved outcome events", async t => {
  const f = await setup(t), before = await readFile(f.database);
  const history = ok(await f.cli(["work", "history", "--cwd", f.root]));
  assert.equal(history.complete, true);
  assert.deepEqual(ids(history.records.filter(record => record.kind === "work")),
    [...visibleIds, "work:current-closed", ...f.retired.map(record => record.id)].sort());
  assert.equal(history.records.find(record => record.id === "work:unresolved").semantics.lifecycle, "unresolved");
  for (const { id, eventId, lifecycle } of f.retired) {
    const record = history.records.find(record => record.id === id);
    const event = history.records.find(record => record.id === eventId);
    assert.equal(record.semantics.lifecycle, lifecycle);
    assert.equal(record.data.status, "open", "Retirement must not fabricate completion");
    assert.equal(record.data.last_outcome.outcome, "unknown");
    assert.equal(record.data.last_event_id, eventId);
    assert.equal(event.kind, "work-event");
    assert.equal(event.data.work_id, id);
    assert.equal(event.data.outcome, "unknown");
    assert.equal(event.data.unresolved_consequence, "Retain the original unresolved outcome");
    assert.equal(ok(await f.cli(["get", "--", id])).data.status, "open");
  }
  assert.deepEqual(await readFile(f.database), before, "History must preserve source records and events");
});

test("status reports a named source-correction gap for missing required semantic metadata", async t => {
  const f = await setup(t), damagedId = "work:current-a";
  const db = await openWriteDatabase(f.database);
  try {
    admittedTransaction(db, () => db.prepare("UPDATE records SET content_json="
      + "json_remove(content_json,'$._lodestar.semantics') WHERE id=?").run(damagedId), f.database);
  } finally { db.close(); }
  const before = await readFile(f.database);
  const status = ok(await f.cli(["work", "status", "--cwd", f.root]));
  assert.deepEqual(ids(status.records), visibleIds.filter(id => id !== damagedId));
  assert.equal(status.complete, false, "A SQL lifecycle fallback must not hide damaged metadata");
  assert.equal(status.record_errors.length, 1);
  assert.equal(status.record_errors[0].code, "record_requires_source_correction");
  assert.equal(status.record_errors[0].identifiers.id, damagedId);
  assert.deepEqual(status.record_errors[0].identifiers.raw_read_args, ["get", "--raw", "--", damagedId]);
  assert.deepEqual(await readFile(f.database), before, "A diagnostic read must not repair or retire damaged work");
});

test("status, start and Attention reject malformed present semantics at the read boundary", async t => {
  const f = await setup(t), damagedId = "work:current-a";
  const db = await openWriteDatabase(f.database);
  try {
    admittedTransaction(db, () => db.prepare("UPDATE records SET content_json="
      + "json_remove(content_json,'$._lodestar.semantics.lifecycle') WHERE id=?").run(damagedId), f.database);
  } finally { db.close(); }
  const before = await readFile(f.database);
  for (const args of [
    ["work", "status", "--cwd", f.root],
    ["start", "--cwd", f.root],
    ["work", "attention", "--cwd", f.root],
  ]) {
    const result = await f.cli(args);
    assert.equal(result.code, 4, `Malformed present semantics must reject ${args.join(" ")}`);
    assert.equal(result.value.ok, false);
    assert.equal(result.value.error.code, "database_integrity");
    assert.equal(result.value.error.identifiers.id, damagedId);
    assert.deepEqual(await readFile(f.database), before, "Rejected reads must preserve malformed source bytes");
  }
});
