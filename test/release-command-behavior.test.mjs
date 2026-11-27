import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fixture } from "./helpers/contract.mjs";

const actor = { id: "agent:release-proof", agent: "agent", session: "release-proof", harness: "test" };
const projectId = "project:release-proof";
const recordTarget = (id) => ({ kind: "record", id });
const decisionTarget = (key) => ({ kind: "decision", scope: projectId, key });

async function setup(t) {
  const f = await fixture(t);
  await f.create(projectId, "project", { roots: [f.root] }, projectId);
  f.change = async (family, action, input, targets = []) => f.cli(
    [family, action, "--cwd", f.root],
    await f.request(input, [recordTarget(projectId), ...targets], projectId, actor),
  );
  return f;
}

for (const [outcome, status] of [
  ["attempted", "open"], ["unknown", "open"], ["failed", "closed"],
  ["interrupted", "closed"], ["completed", "closed"], ["verified", "closed"],
]) {
  test(`CLI work report persists ${outcome} as ${status} with an atomic event`, async (t) => {
    const f = await setup(t);
    const id = `work:${outcome}`;
    const started = await f.change("work", "start", { id, description: "Investigate the release behavior" }, [recordTarget(id)]);
    assert.equal(started.code, 0, JSON.stringify(started.value));
    const evidence = outcome === "verified" ? [{ reference: "test:focused-result", observation: "Focused check passed" }] : [];
    const input = { id, outcome, description: `Observed ${outcome}`, action_id: `release:${outcome}`, evidence,
      observed_at: "2026-10-14T12:00:00Z", unresolved_consequence: outcome === "unknown" ? "Await result" : null };
    const reported = await f.change("work", "report", input, [recordTarget(id)]);
    assert.equal(reported.code, 0, JSON.stringify(reported.value));
    assert.equal(reported.value.operation, "work.report");
    assert.equal(reported.value.data.changed, true);
    const work = (await f.cli(["get", id])).value.data;
    const event = (await f.cli(["get", reported.value.data.event_id])).value.data;
    assert.equal(work.data.status, status);
    assert.equal(work.data.last_event_id, event.id);
    assert.equal(work.revision, reported.value.revision);
    assert.equal(event.revision, work.revision);
    assert.ok(work.revision > started.value.revision);
    assert.equal(event.kind, "work-event");
    assert.equal(event.data.work_id, id);
    for (const key of ["outcome", "description", "action_id", "evidence", "observed_at", "unresolved_consequence"]) {
      assert.deepEqual(work.data.last_outcome[key], input[key]);
      assert.deepEqual(event.data[key], input[key]);
    }
    const visible = await f.cli(["work", "status", "--cwd", f.root]);
    assert.equal(visible.code, 0);
    assert.equal(visible.value.data.records.some((record) => record.id === id), status === "open");
    const history = await f.cli(["work", "history", "--cwd", f.root]);
    assert.equal(history.code, 0, JSON.stringify(history.value));
    assert.ok(history.value.data.records.some((record) => record.id === event.id));
  });
}

test("CLI verified report rejects absent evidence without settling work or writing an event", async (t) => {
  const f = await setup(t);
  const id = "work:needs-proof";
  assert.equal((await f.change("work", "start", { id, description: "Await evidence" }, [recordTarget(id)])).code, 0);
  const before = await readFile(f.database);
  const rejected = await f.change("work", "report", {
    id, outcome: "verified", description: "Claim without evidence", action_id: "release:unsupported", evidence: [],
  }, [recordTarget(id)]);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.value.error.code, "invalid_input");
  assert.match(rejected.value.error.message, /evidence/i);
  assert.deepEqual(await readFile(f.database), before, "rejection must not create a revision, receipt, or event");
  assert.equal((await f.cli(["get", id])).value.data.data.status, "open");
  const history = await f.cli(["work", "history", "--cwd", f.root]);
  assert.equal(history.code, 0, JSON.stringify(history.value));
  assert.equal(history.value.data.records.filter(({ kind }) => kind === "work-event").length, 0);
});

test("CLI pending decision promotion settles the candidate and decision at one revision", async (t) => {
  const f = await setup(t);
  const id = "pending:decision", key = "release:behavior";
  assert.equal((await f.change("pending", "add", { id, text: "Use the inspected release behavior" }, [recordTarget(id)])).code, 0);
  const destination = { operation: "decision.set", input: {
    key, value: "retain", reason: "Focused behavior checks support this choice", status: "accepted",
  } };
  const result = await f.change("pending", "promote", { id, destination }, [recordTarget(id), decisionTarget(key)]);
  assert.equal(result.code, 0, JSON.stringify(result.value));
  assert.equal(result.value.data.settled, true);
  const candidate = (await f.cli(["get", id])).value.data;
  const decision = (await f.cli(["get", result.value.data.promoted.record.id])).value.data;
  assert.equal(candidate.semantics.lifecycle, "superseded");
  assert.equal(candidate.data.text, "Use the inspected release behavior");
  assert.deepEqual(candidate.data.destination, destination);
  assert.equal(candidate.revision, decision.revision);
  assert.equal(decision.revision, result.value.revision);
  assert.equal(decision.kind, "decision-event");
  assert.equal(decision.data.key, key);
  assert.equal(decision.data.value, "retain");
  const shown = await f.cli(["decision", "show", key, "--cwd", f.root]);
  assert.equal(shown.value.data.facts[0].value, "retain");
  assert.equal((await f.cli(["pending", "list", "--cwd", f.root])).value.data.count, 0);
});

test("CLI conflicting promotion predecessor rolls back decision and candidate settlement", async (t) => {
  const f = await setup(t);
  const id = "pending:conflict", key = "release:checked-head";
  assert.equal((await f.change("decision", "set", {
    key, value: "original", reason: "Existing checked choice", status: "accepted",
  }, [decisionTarget(key)])).code, 0);
  assert.equal((await f.change("pending", "add", { id, text: "Propose a successor" }, [recordTarget(id)])).code, 0);
  const candidate = (await f.cli(["get", id])).value.data;
  const shown = (await f.cli(["decision", "show", key, "--cwd", f.root])).value.data;
  const before = await readFile(f.database);
  const result = await f.change("pending", "promote", { id, destination: { operation: "decision.set", input: {
    key, value: "replacement", reason: "Incorrect supplied predecessor", status: "accepted", supersedes_event_id: null,
  } } }, [recordTarget(id), decisionTarget(key)]);
  assert.notEqual(result.code, 0);
  assert.equal(result.value.error.code, "decision_conflict");
  assert.deepEqual(await readFile(f.database), before, "destination conflict must roll back the complete promotion transaction");
  assert.deepEqual((await f.cli(["get", id])).value.data, candidate);
  assert.deepEqual((await f.cli(["decision", "show", key, "--cwd", f.root])).value.data, shown);
  assert.equal((await f.cli(["pending", "list", "--cwd", f.root])).value.data.count, 1);
});

async function fileSnapshot(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    result[entry.name] = entry.isDirectory() ? await fileSnapshot(file) : (await readFile(file)).toString("base64");
  }
  return result;
}

test("CLI agents verify and blocked setup plan return exit 4 while preserving user files", async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.root, "AGENTS.md"), "# User rules\r\nPreserve these exact bytes.\r\n");
  const launcher = path.join(f.root, "user-launcher");
  await writeFile(launcher, "User-owned launcher content\r\n");
  const before = await fileSnapshot(f.root);
  const agents = await f.cli(["agents", "verify", "--cwd", f.root]);
  assert.equal(agents.code, 4, JSON.stringify(agents.value));
  assert.equal(agents.value.operation, "agents.verify");
  assert.equal(agents.value.data.verified, false);
  assert.equal(agents.value.data.state, "custom");
  const planned = await f.cli(["setup", "--target", "codex", "--home", f.root,
    "--codex-home", path.join(f.root, ".codex"), "--posix-shim", launcher]);
  assert.equal(planned.code, 4, JSON.stringify(planned.value));
  assert.equal(planned.value.operation, "setup");
  assert.equal(planned.value.data.ready, false);
  assert.equal(planned.value.data.applied, false);
  assert.equal(planned.value.data.launchers.find(({ target }) => target === launcher).blocked, true);
  assert.deepEqual(await fileSnapshot(f.root), before, "diagnostics preserve files and create no setup state or database changes");
});
