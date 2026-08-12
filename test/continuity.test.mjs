import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  executeContinuityOperation,
  prepareContinuityRequest,
} from "../src/continuity.mjs";
import {
  initializeDatabase,
  openReadDatabase,
  openWriteDatabase,
} from "../src/database.mjs";

async function fixture(t) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "lodestar-continuity-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "lodestar.db");
  await initializeDatabase(file, {
    now: () => new Date("2026-08-12T20:00:00.000Z"),
  });
  const db = await openWriteDatabase(file);
  t.after(() => {
    try {
      db.close();
    } catch {
      // A test may close the fixture before its read-only byte snapshot.
    }
  });
  const call = (operation, args) => executeContinuityOperation(
    db,
    operation,
    operation === "continuity_status"
      ? args
      : prepareContinuityRequest(operation, args),
    { database: file },
  );
  return { directory, file, db, call };
}

function arm(call, sessionId = "session:source", turnId = "turn:arm") {
  return call("continuity_arm", {
    project_key: "project:test",
    session_id: sessionId,
    turn_id: turnId,
    packet_json: { state: "armed", session_id: sessionId },
  });
}

function checkpoint(call, lane, predecessor, sessionId, turnId, absorbed = []) {
  return call("continuity_checkpoint", {
    lane_id: lane,
    session_id: sessionId,
    turn_id: turnId,
    predecessor_packet_id: predecessor,
    packet_json: { state: "checkpoint", turn_id: turnId },
    absorbed_event_ids: absorbed,
  });
}

function schedule(call, lane, predecessor, sessionId, turnId) {
  return call("continuity_request_transfer", {
    lane_id: lane,
    source_session_id: sessionId,
    source_turn_id: turnId,
    predecessor_packet_id: predecessor,
    packet_json: { state: "handoff", turn_id: turnId },
    absorbed_event_ids: [],
  });
}

function advanceToContinuing(call, scheduled, sessionId, turnId, target) {
  const claimed = call("continuity_claim_transfer", {
    transfer_id: scheduled.transfer_id,
    source_session_id: sessionId,
    source_turn_id: turnId,
  });
  let expected = "claimed";
  for (const next of [
    "creating",
    "created",
    "injecting",
    "injected",
    "continuing",
  ]) {
    call("continuity_update_transfer", {
      transfer_id: scheduled.transfer_id,
      worker_claim_id: claimed.worker_claim_id,
      expected_phase: expected,
      next_phase: next,
      ...(next === "created" ? { target_session_id: target } : {}),
    });
    expected = next;
  }
  return claimed;
}

test("arm enforces one lane per owner while allowing many lanes per project", async (t) => {
  const { call } = await fixture(t);
  const first = arm(call);
  assert.throws(
    () => arm(call, "session:source", "turn:second"),
    ({ code }) => code === "continuity_owner_conflict",
  );
  const peer = arm(call, "session:peer", "turn:peer");
  assert.notEqual(peer.lane_id, first.lane_id);
  const all = call("continuity_status", { all: true });
  assert.equal(all.lanes.length, 2);
});

test("mutation replay returns the stored receipt and changed digest conflicts", async (t) => {
  const { db, file } = await fixture(t);
  const args = {
    project_key: "project:test",
    session_id: "session:source",
    turn_id: "turn:arm",
    packet_json: { state: "armed" },
  };
  const request = prepareContinuityRequest("continuity_arm", args);
  const first = executeContinuityOperation(db, "continuity_arm", request, {
    database: file,
  });
  const duplicate = executeContinuityOperation(db, "continuity_arm", request, {
    database: file,
  });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.lane_id, first.lane_id);

  const changed = prepareContinuityRequest("continuity_arm", {
    ...args,
    packet_json: { state: "changed" },
  });
  changed.operation_id = request.operation_id;
  assert.throws(
    () => executeContinuityOperation(db, "continuity_arm", changed, {
      database: file,
    }),
    ({ code }) => code === "operation_conflict",
  );
});

test("tail events deduplicate and checkpoint absorption is exact", async (t) => {
  const { call, db } = await fixture(t);
  const lane = arm(call);
  const args = {
    lane_id: lane.lane_id,
    session_id: "session:source",
    turn_id: "turn:work",
    event_type: "prompt.tail",
    role: "user",
    redacted_text: "redacted prompt",
  };
  const first = call("continuity_append_event", args);
  const duplicate = call("continuity_append_event", args);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event_id, first.event_id);
  assert.equal(
    db.prepare(
      "SELECT count(*) AS count FROM continuity_events "
        + "WHERE event_type = 'prompt.tail'",
    ).get().count,
    1,
  );
  const assistantArgs = {
    ...args,
    event_type: "assistant.tail",
    role: "assistant",
    redacted_text: "redacted stop tail",
  };
  const assistant = call("continuity_append_event", assistantArgs);
  assert.equal(
    call("continuity_append_event", assistantArgs).event_id,
    assistant.event_id,
  );
  const next = checkpoint(
    call,
    lane.lane_id,
    lane.packet_id,
    "session:source",
    "turn:checkpoint",
    [first.event_id],
  );
  assert.equal(next.absorbed_count, 1);
  assert.equal(
    db.prepare(
      "SELECT absorbed_packet_id FROM continuity_events WHERE event_id = ?",
    ).get(first.event_id).absorbed_packet_id,
    next.packet_id,
  );
});

test("checkpoint rejects lineage forks and packets cannot cross lanes", async (t) => {
  const { call, db } = await fixture(t);
  const first = arm(call);
  const peer = arm(call, "session:peer", "turn:peer");
  checkpoint(
    call,
    first.lane_id,
    first.packet_id,
    "session:source",
    "turn:checkpoint",
  );
  assert.throws(
    () => checkpoint(
      call,
      first.lane_id,
      first.packet_id,
      "session:source",
      "turn:fork",
    ),
    ({ code }) => code === "continuity_predecessor_conflict",
  );
  assert.throws(() => db.prepare(
    "UPDATE continuity_lanes SET active_packet_id = ? WHERE lane_id = ?",
  ).run(peer.packet_id, first.lane_id));
});

test("transfer claim, phase, active-transfer, and ownership guards are atomic", async (t) => {
  const { call } = await fixture(t);
  const lane = arm(call);
  const scheduled = schedule(
    call,
    lane.lane_id,
    lane.packet_id,
    "session:source",
    "turn:handoff",
  );
  assert.throws(
    () => schedule(
      call,
      lane.lane_id,
      scheduled.packet_id,
      "session:source",
      "turn:other",
    ),
    ({ code }) => code === "continuity_transfer_conflict",
  );
  assert.throws(
    () => call("continuity_claim_transfer", {
      transfer_id: scheduled.transfer_id,
      source_session_id: "session:source",
      source_turn_id: "turn:wrong",
    }),
    ({ code }) => code === "continuity_transfer_conflict",
  );
  const claimed = call("continuity_claim_transfer", {
    transfer_id: scheduled.transfer_id,
    source_session_id: "session:source",
    source_turn_id: "turn:handoff",
  });
  assert.throws(
    () => call("continuity_update_transfer", {
      transfer_id: scheduled.transfer_id,
      worker_claim_id: claimed.worker_claim_id,
      expected_phase: "claimed",
      next_phase: "injecting",
    }),
    ({ code }) => code === "continuity_phase_conflict",
  );
  call("continuity_update_transfer", {
    transfer_id: scheduled.transfer_id,
    worker_claim_id: claimed.worker_claim_id,
    expected_phase: "claimed",
    next_phase: "creating",
  });
  const replay = call("continuity_update_transfer", {
    transfer_id: scheduled.transfer_id,
    worker_claim_id: claimed.worker_claim_id,
    expected_phase: "claimed",
    next_phase: "creating",
  });
  assert.equal(replay.duplicate, true);
  assert.throws(
    () => call("continuity_update_transfer", {
      transfer_id: scheduled.transfer_id,
      worker_claim_id: claimed.worker_claim_id,
      expected_phase: "claimed",
      next_phase: "creating",
      error: "new worker must not replay",
    }),
    ({ code }) => code === "continuity_transfer_indeterminate",
  );
});

test("target acceptance moves ownership and terminal outcomes retain it", async (t) => {
  const { call } = await fixture(t);
  const lane = arm(call);
  const scheduled = schedule(
    call,
    lane.lane_id,
    lane.packet_id,
    "session:source",
    "turn:handoff",
  );
  const claimed = advanceToContinuing(
    call,
    scheduled,
    "session:source",
    "turn:handoff",
    "session:target",
  );
  const accepted = call("continuity_accept_target", {
    transfer_id: scheduled.transfer_id,
    worker_claim_id: claimed.worker_claim_id,
    target_session_id: "session:target",
    target_turn_id: "turn:target",
  });
  assert.equal(accepted.owner_session_id, "session:target");
  const failed = call("continuity_complete_target", {
    transfer_id: scheduled.transfer_id,
    worker_claim_id: claimed.worker_claim_id,
    target_turn_id: "turn:target",
    target_turn_status: "interrupted",
    redacted_error: "target interrupted",
  });
  assert.equal(failed.phase, "failed");
  const status = call("continuity_status", { lane_id: lane.lane_id });
  assert.equal(status.lane.owner_session_id, "session:target");
  assert.equal(status.latest_transfer.target_turn_status, "interrupted");

  const second = schedule(
    call,
    lane.lane_id,
    status.active_packet.packet_id,
    "session:target",
    "turn:second-handoff",
  );
  const secondClaim = advanceToContinuing(
    call,
    second,
    "session:target",
    "turn:second-handoff",
    "session:second-target",
  );
  call("continuity_accept_target", {
    transfer_id: second.transfer_id,
    worker_claim_id: secondClaim.worker_claim_id,
    target_session_id: "session:second-target",
    target_turn_id: "turn:second-target",
  });
  const completed = call("continuity_complete_target", {
    transfer_id: second.transfer_id,
    worker_claim_id: secondClaim.worker_claim_id,
    target_turn_id: "turn:second-target",
    target_turn_status: "completed",
  });
  assert.equal(completed.phase, "completed");
});

test("continuity status is byte-for-byte read-only", async (t) => {
  const { directory, file, db, call } = await fixture(t);
  const lane = arm(call);
  db.close();
  const snapshot = async () => ({
    digest: createHash("sha256").update(await readFile(file)).digest("hex"),
    entries: (await readdir(directory)).sort(),
  });
  const before = await snapshot();
  const read = await openReadDatabase(file);
  const status = executeContinuityOperation(
    read,
    "continuity_status",
    { lane_id: lane.lane_id },
  );
  read.close();
  assert.equal(status.found, true);
  assert.deepEqual(await snapshot(), before);
});
