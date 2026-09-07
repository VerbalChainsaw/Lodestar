import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CONTRACT_VERSION } from '../src/schema.mjs';
import { fixture } from './helpers/contract.mjs';

test("current CLI reads are fresh, read-only, and return one contract with reusable bases", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  await f.create("fact:test", "fact", { command: "npm test" }, "project:test",
    { context_role: "orientation", lifecycle: "current", subject: "test-command" });
  const before = await readFile(f.database);
  const first = await f.cli(["start", "--cwd", f.root, "--session", "same-session"]);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  assert.equal(first.value.v, CONTRACT_VERSION);
  assert.equal(first.value.data.context[0].data.command, "npm test");
  assert.deepEqual(await readFile(f.database), before);
  const basis = first.value.data.context[0].write_basis;
  const update = { v: CONTRACT_VERSION, request_id: "update-test", write_basis: basis,
    input: { mode: "update", id: "fact:test", set: { data: { command: "npm run check" } }, remove: [] } };
  assert.equal((await f.cli(["put"], update)).code, 0);
  const second = await f.cli(["start", "--cwd", f.root, "--session", "same-session"]);
  assert.equal(second.value.data.context[0].data.command, "npm run check");
  assert.equal((await f.cli(["put"], update)).value.request.replayed, true);
  const history = await f.cli(["get", "fact:test", "--history"]);
  assert.equal(history.code, 0);
  assert.match(JSON.stringify(history.value.data), /npm test/u);
});

test("required native source changes are delivered exactly without database mutation", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, "AGENTS.md"), "First complete instruction.\r\n");
  const first = await f.cli(["start", "--cwd", f.root]);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  const own = first.value.data.required.find((source) => source.path === path.join(f.root, "AGENTS.md"));
  assert.equal(own.text, "First complete instruction.\r\n");
  await writeFile(path.join(f.root, "AGENTS.md"), "Changed complete instruction.\r\n");
  const second = await f.cli(["start", "--cwd", f.root]);
  const changed = second.value.data.required.find((source) => source.path === path.join(f.root, "AGENTS.md"));
  assert.equal(changed.text, "Changed complete instruction.\r\n");
  assert.notEqual(changed.sha256, own.sha256);
  assert.equal(second.value.revision, first.value.revision);
});

test("decisions preserve exact keys and cross-session user direction", async (t) => {
  const f = await fixture(t);
  await f.create("project:test", "project", { roots: [f.root] }, "project:test");
  const actor = { id: "agent:one", agent: "test", session: "one", harness: "test" };
  const targets = [{ kind: "record", id: "project:test" }, { kind: "decision", scope: "project:test", key: "db:Choice_A" }];
  const direction = { kind: "user", attribution: "asserted", reference: "task:user:1", instruction: "Use SQLite." };
  let req = await f.request({ key: "db:Choice_A", value: "SQLite", reason: "Local transactional state", status: "accepted", direction }, targets, "project:test", actor);
  const first = await f.cli(["decision", "set", "--cwd", f.root], req);
  assert.equal(first.code, 0, JSON.stringify(first.value));
  req = await f.request({ key: "db:Choice_A", value: "Revised", reason: "Current user corrected the choice", status: "accepted",
    direction: { ...direction, reference: "task:user:2", instruction: "Use the revised choice." } }, targets, "project:test", { ...actor, id: "agent:two", session: "two" });
  assert.equal((await f.cli(["decision", "set", "--cwd", f.root], req)).code, 0);
  const state = await f.cli(["decision", "show", "db:Choice_A", "--cwd", f.root]);
  assert.equal(state.value.data.facts[0].key, "db:Choice_A");
  assert.equal(state.value.data.facts[0].value, "Revised");
  assert.equal(state.value.data.dead[0].value, "SQLite");
});
