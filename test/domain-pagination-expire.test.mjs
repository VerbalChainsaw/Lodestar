import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

const actor = { id: "agent:paging", agent: "agent", session: "paging", harness: "test" };
const projectId = "project:paging";
const target = (id) => ({ kind: "record", id });

async function setup(t) {
  const f = await fixture(t);
  await f.create(projectId, "project", { roots: [f.root] }, projectId);
  f.domainRequest = (input, ids) => f.request(input,
    [...ids.map(target), target(projectId)], projectId, actor);
  f.work = async (action, input) => f.cli(["work", action, "--cwd", f.root],
    await f.domainRequest(input, action === "expire" ? input.targets : [input.id]));
  for (const id of ["work:a", "work:b", "work:c", "work:d"]) {
    const result = await f.work("start", { id, description: id });
    assert.equal(result.code, 0, JSON.stringify(result.value));
  }
  return f;
}

for (const [family, action] of [["work", "status"], ["work", "history"], ["pending", "list"]]) {
  test(`${family}.${action} pages every visible row with guarded literal continuation`, async (t) => {
    const f = await setup(t);
    assert.equal((await f.work("done", { id: "work:a", description: "Finished a",
      action_id: "finish:a", outcome: "completed" })).code, 0);
    for (const id of ["pending:a", "pending:b", "pending:c", "pending:d"]) {
      const result = await f.cli(["pending", "add", "--cwd", f.root],
        await f.domainRequest({ id, text: id }, [id]));
      assert.equal(result.code, 0, JSON.stringify(result.value));
    }
    const descriptor = (await f.cli(["--help"])).value.data.operations
      .find((operation) => operation.id === `${family}.${action}`);
    assert.ok(descriptor.parameters.some((parameter) => parameter.name === "offset"));
    assert.ok(descriptor.cli_inputs.command_values.some((option) => option.flag === "--offset"));
    const before = await readFile(f.database);
    const full = await f.cli([family, action, "--cwd", f.root]);
    assert.equal(full.code, 0);
    assert.ok(full.value.data.records.length > 2);
    let args = [family, action, "--cwd", f.root, "--limit", "2"];
    const records = [];
    let revision;
    for (let page = 0; page < 10; page++) {
      const result = await f.cli(args);
      assert.equal(result.code, 0, JSON.stringify(result.value));
      revision ??= result.value.revision;
      assert.equal(result.value.revision, revision);
      assert.equal(result.value.more, result.value.data.more);
      assert.ok(result.value.data.records.length <= 2);
      records.push(...result.value.data.records);
      const mutable = result.value.data.records.filter((row) => row.kind === "work" || row.kind === "pending");
      assert.deepEqual(result.value.data.write_basis.targets.map(({ id }) => id).sort(),
        [...mutable.map(({ id }) => id), projectId].sort());
      if (!result.value.more) {
        assert.deepEqual(result.value.next, []);
        break;
      }
      assert.equal(result.value.next.length, 1);
      const next = result.value.next[0];
      assert.equal(next.command, family);
      assert.equal(next.args[0], action);
      assert.equal(next.args[next.args.indexOf("--offset") + 1], String((page + 1) * 2));
      assert.equal(next.args[next.args.indexOf("--at-revision") + 1], String(revision));
      args = [next.command, ...next.args];
    }
    assert.deepEqual(records, full.value.data.records);
    assert.equal(new Set(records.map(({ id }) => id)).size, records.length);
    const pastEnd = await f.cli([family, action, "--cwd", f.root, "--limit", "2",
      "--offset", "100", "--at-revision", String(revision)]);
    assert.equal(pastEnd.code, 0);
    assert.deepEqual(pastEnd.value.data.records, []);
    assert.equal(pastEnd.value.more, false);
    assert.deepEqual(pastEnd.value.next, []);
    for (const offset of ["-1", "0.5", "9007199254740992"]) {
      const invalid = await f.cli([family, action, "--cwd", f.root, "--limit", "2", "--offset", offset]);
      assert.equal(invalid.code, 2);
      assert.equal(invalid.value.error.code, "invalid_input");
    }
    const noLimit = await f.cli([family, action, "--cwd", f.root, "--offset", "1"]);
    assert.equal(noLimit.code, 2);
    assert.equal(noLimit.value.error.code, "invalid_input");
    assert.deepEqual(await readFile(f.database), before);
    const first = await f.cli([family, action, "--cwd", f.root, "--limit", "1"]);
    const continuation = first.value.next[0];
    await f.create("note:after-page", "note", { body: "Unrelated write still advances snapshot" });
    const changed = await readFile(f.database);
    const stale = await f.cli([continuation.command, ...continuation.args]);
    assert.equal(stale.code, 3);
    assert.equal(stale.value.error.code, "read_revision_conflict");
    assert.deepEqual(await readFile(f.database), changed);
  });
}

test("non-paged work reads do not advertise or ignore offset", async (t) => {
  const f = await setup(t);
  const operations = (await f.cli(["--help"])).value.data.operations;
  const before = await readFile(f.database);
  for (const action of ["check", "prepare-capture", "attention"]) {
    const descriptor = operations.find((operation) => operation.id === `work.${action}`);
    assert.equal(descriptor.cli_inputs.command_values.some((option) => option.flag === "--offset"), false);
    const result = await f.cli(["work", action, ...(action === "check" ? ["knowledge:missing"] : []),
      "--cwd", f.root, "--offset", "0"]);
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, "unknown_option");
  }
  assert.deepEqual(await readFile(f.database), before);
});

test("work.expire closes multiple targets atomically and exact replay preserves one receipt and event set", async (t) => {
  const f = await setup(t);
  const input = { targets: ["work:a", "work:b"], reason: "Interrupted after an explicit operator review" };
  const request = await f.domainRequest(input, input.targets);
  const first = await f.cli(["work", "expire", "--cwd", f.root], request);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.equal(first.value.request.replayed, false);
  assert.equal(first.value.data.results.length, 2);
  for (const [index, result] of first.value.data.results.entries()) {
    assert.equal(result.record.id, input.targets[index]);
    assert.equal(result.record.scope, projectId);
    assert.equal(result.record.data.status, "closed");
    assert.equal(result.record.data.last_outcome.outcome, "interrupted");
    assert.equal(result.record.data.last_outcome.description, input.reason);
    assert.equal(result.record.data.last_outcome.action_id, request.request_id);
    assert.equal(result.record.data.last_outcome.actor, actor.id);
    const event = await f.cli(["get", result.event_id]);
    assert.equal(event.code, 0);
    assert.equal(event.value.data.revision, first.value.revision);
    assert.equal(event.value.data.scope, projectId);
    assert.equal(event.value.data.data.work_id, input.targets[index]);
    assert.equal(event.value.data.data.event_sequence, index);
  }
  const events = await f.cli(["find", "--all", "--kind", "work-event", "--history"]);
  assert.equal(events.value.data.records.length, 2);
  const beforeReplay = await f.cli(["export"]);
  const replay = await f.cli(["work", "expire", "--cwd", f.root], request);
  assert.equal(replay.code, 0);
  assert.equal(replay.value.request.replayed, true);
  assert.equal(replay.value.receipt_id, first.value.receipt_id);
  assert.equal(replay.value.revision, first.value.revision);
  assert.deepEqual((await f.cli(["export"])).value.data, beforeReplay.value.data);
  const staleRequest = await f.domainRequest(input, input.targets);
  assert.equal((await f.work("start", { id: "work:b", description: "Explicitly reopened" })).code, 0);
  const beforeStale = await f.cli(["export"]);
  const stale = await f.cli(["work", "expire", "--cwd", f.root], staleRequest);
  assert.equal(stale.code, 3);
  assert.equal(stale.value.error.code, "revision_conflict");
  assert.deepEqual((await f.cli(["export"])).value.data, beforeStale.value.data);
});

test("work.expire rolls back a valid first target when a later target is missing or foreign", async (t) => {
  const f = await setup(t);
  const foreignRoot = path.join(f.root, "foreign");
  await mkdir(foreignRoot);
  await f.create("project:foreign", "project", { roots: [foreignRoot] }, "project:foreign");
  const foreignRequest = await f.request({ id: "work:foreign", description: "Foreign work" },
    [target("work:foreign"), target("project:foreign")], "project:foreign", actor);
  foreignRequest.checkout = foreignRoot;
  const foreign = await f.cli(["work", "start", "--cwd", foreignRoot], foreignRequest);
  assert.equal(foreign.code, 0, JSON.stringify(foreign.value));
  for (const invalidTarget of ["work:missing", "work:foreign"]) {
    const input = { targets: ["work:a", invalidTarget], reason: "Must retain both original states" };
    const request = await f.domainRequest(input, input.targets);
    const before = await f.cli(["export"]);
    const result = await f.cli(["work", "expire", "--cwd", f.root], request);
    assert.equal(result.code, 3, JSON.stringify(result.value));
    assert.equal(result.value.error.code, invalidTarget === "work:missing" ? "work_not_found" : "work_conflict");
    assert.deepEqual((await f.cli(["export"])).value.data, before.value.data);
    assert.equal((await f.cli(["get", "work:a"])).value.data.data.status, "open");
  }
  for (const targets of [[], ["work:a", "work:a"]]) {
    const request = await f.domainRequest({ targets, reason: "Reject ambiguous expiration" }, [...new Set(targets)]);
    const before = await f.cli(["export"]);
    const result = await f.cli(["work", "expire", "--cwd", f.root], request);
    assert.equal(result.code, 2);
    assert.equal(result.value.error.code, "invalid_input");
    assert.deepEqual((await f.cli(["export"])).value.data, before.value.data);
  }
});
