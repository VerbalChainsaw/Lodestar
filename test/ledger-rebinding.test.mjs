import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { openReadDatabase } from "../src/database.mjs";
import { writeBasis } from "../src/records.mjs";
import { fixture } from "./helpers/contract.mjs";

const actor = (session) => ({
  id: `agent:${session}`,
  agent: "agent",
  session,
  harness: "test",
});

const checkpoint = {
  objective: "Continue the checked work",
  current_state: "Ready for the next session",
  completed_results: ["Canonical project mapping prepared"],
  unresolved_work: ["Claim the transfer"],
  references: ["project:old"],
};

async function setupRebinding(t) {
  const f = await fixture(t);
  await f.create("project:old", "project", { roots: [f.root] }, "project:old");
  await f.create("project:new", "project", { roots: [] }, "project:new");
  const mutate = async (family, action, input, session = "source") => f.cli(
    [family, action, "--cwd", f.root, "--session", session, "--agent", "agent"],
    await f.request(input, [
      { kind: "record", id: input.id },
      { kind: "record", id: "project:old" },
    ], "project:old", actor(session)),
  );
  const mapping = await f.request({
    mode: "update",
    id: "project:old",
    set: {
      data: { canonical_project_id: "project:new" },
      links: [{ relationship: "canonical-project", to_id: "project:new" }],
    },
    remove: [],
  }, [
    { kind: "record", id: "project:old" },
    { kind: "record", id: "project:new" },
  ], "project:old");
  return { f, mutate, mapping };
}

test("visible work from a canonical member scope can be completed without changing its origin scope", async (t) => {
  const { f, mutate, mapping } = await setupRebinding(t);
  assert.equal((await mutate("work", "start", {
    id: "work:old",
    description: "Finish the canonical mapping",
  })).code, 0);
  const before = (await f.cli(["get", "work:old"])).value.data;
  assert.equal((await f.cli(["put"], mapping)).code, 0);

  const status = await f.cli(["work", "status", "--cwd", f.root]);
  assert.deepEqual(status.value.data.records.map(({ id, scope }) => ({ id, scope })), [
    { id: "work:old", scope: "project:old" },
  ]);
  const completed = await f.cli(
    ["work", "done", "--cwd", f.root, "--session", "next", "--agent", "agent"],
    {
      v: 5,
      request_id: "complete-rebound-work",
      write_basis: status.value.data.write_basis,
      input: {
        id: "work:old",
        outcome: "completed",
        description: "Canonical mapping finished",
        action_id: "mapping:complete",
      },
    },
  );
  assert.equal(completed.code, 0, JSON.stringify(completed.value));

  const after = (await f.cli(["get", "work:old"])).value.data;
  assert.equal(after.scope, "project:old");
  assert.equal(after.data.status, "closed");
  assert.equal(after.data.last_outcome.checkout, f.root.replaceAll("\\", "/"));
  assert.deepEqual(after.semantics, before.semantics);
  assert.deepEqual(after.aliases, before.aliases);
  assert.deepEqual(after.links, before.links);
  assert.deepEqual(after.sources, before.sources);
  assert.equal(after.created_at, before.created_at);
  const event = (await f.cli(["get", after.data.last_event_id])).value.data;
  assert.equal(event.scope, "project:old");
});

test("visible handoff from a canonical member scope can be updated and claimed without changing its origin scope", async (t) => {
  const { f, mutate, mapping } = await setupRebinding(t);
  assert.equal((await mutate("handoff", "arm", {
    id: "handoff:old",
    checkpoint,
  })).code, 0);
  const before = (await f.cli(["get", "handoff:old"])).value.data;
  assert.equal((await f.cli(["put"], mapping)).code, 0);

  const status = await f.cli(["handoff", "status", "--cwd", f.root]);
  assert.deepEqual(status.value.data.records.map(({ id, scope }) => ({ id, scope })), [
    { id: "handoff:old", scope: "project:old" },
  ]);
  const updatedCheckpoint = {
    ...checkpoint,
    current_state: "Canonical member scope remains the record origin",
  };
  const checkpointed = await f.cli(
    ["handoff", "checkpoint", "--cwd", f.root, "--session", "next", "--agent", "agent"],
    {
      v: 5,
      request_id: "checkpoint-rebound-handoff",
      write_basis: status.value.data.write_basis,
      input: { id: "handoff:old", checkpoint: updatedCheckpoint },
    },
  );
  assert.equal(checkpointed.code, 0, JSON.stringify(checkpointed.value));
  const packet = (await f.cli(["get", checkpointed.value.data.record.data.packet_id])).value.data;
  assert.equal(packet.scope, "project:old");

  const refreshed = await f.cli(["handoff", "status", "--cwd", f.root]);
  const claimed = await f.cli(
    ["handoff", "claim", "--cwd", f.root, "--session", "next", "--agent", "agent"],
    {
      v: 5,
      request_id: "claim-rebound-handoff",
      write_basis: refreshed.value.data.write_basis,
      input: { id: "handoff:old" },
    },
  );
  assert.equal(claimed.code, 0, JSON.stringify(claimed.value));

  const after = (await f.cli(["get", "handoff:old"])).value.data;
  assert.equal(after.scope, "project:old");
  assert.equal(after.data.state, "claimed");
  assert.equal(after.data.claimed_by, "agent:next");
  assert.deepEqual(after.semantics, before.semantics);
  assert.deepEqual(after.aliases, before.aliases);
  assert.deepEqual(after.links, before.links);
  assert.deepEqual(after.sources, before.sources);
  assert.equal(after.created_at, before.created_at);
});

test("an unrelated project cannot mutate work or handoff records by knowing their IDs", async (t) => {
  const { f, mutate } = await setupRebinding(t);
  assert.equal((await mutate("work", "start", {
    id: "work:old",
    description: "Old project work",
  })).code, 0);
  assert.equal((await mutate("handoff", "arm", {
    id: "handoff:old",
    checkpoint,
  })).code, 0);

  const otherRoot = path.join(f.root, "other");
  await mkdir(otherRoot);
  await f.create("project:other", "project", { roots: [otherRoot] }, "project:other");
  async function unrelatedRequest(id, input, requestId) {
    const db = await openReadDatabase(f.database);
    try {
      return {
        v: 5,
        request_id: requestId,
        write_basis: writeBasis(db, {
          projectScope: "project:other",
          checkout: otherRoot,
          targets: [
            { kind: "record", id },
            { kind: "record", id: "project:other" },
          ],
        }),
        input,
      };
    } finally { db.close(); }
  }

  const work = await f.cli(
    ["work", "done", "--cwd", otherRoot, "--session", "other", "--agent", "agent"],
    await unrelatedRequest("work:old", {
      id: "work:old",
      outcome: "completed",
      description: "Should remain untouched",
      action_id: "unrelated:work",
    }, "unrelated-work"),
  );
  assert.equal(work.value.error.code, "work_conflict");

  const handoff = await f.cli(
    ["handoff", "claim", "--cwd", otherRoot, "--session", "other", "--agent", "agent"],
    await unrelatedRequest("handoff:old", { id: "handoff:old" }, "unrelated-handoff"),
  );
  assert.equal(handoff.value.error.code, "handoff_conflict");
});
