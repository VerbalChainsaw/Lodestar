import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { callNativeTool } from "../codex-plugin/scripts/lodestar-mcp.mjs";
import { fixture } from "./helpers/contract.mjs";

const actor = { id: "agent:observed", agent: "agent", session: "observed", harness: "test" };

test("a native read cannot change a decision through a mutation request file", async (t) => {
  const f = await fixture(t);
  await f.create("project:read-boundary", "project", { roots: [f.root] }, "project:read-boundary");
  const targets = [{ kind: "record", id: "project:read-boundary" },
    { kind: "decision", scope: "project:read-boundary", key: "build" }];
  const initial = await f.request({ key: "build", value: "current", reason: "Observed", status: "accepted" }, targets,
    "project:read-boundary", actor);
  assert.equal((await f.cli(["decision", "set", "--cwd", f.root], initial)).code, 0);
  const request = await f.request({ key: "build", reason: "Should require a mutation tool", status: "blocked" }, targets,
    "project:read-boundary", actor);
  const file = path.join(f.root, "status-request.json");
  await writeFile(file, JSON.stringify(request));
  const before = await readFile(f.database);
  let rejection;
  try {
    await callNativeTool("lodestar_read", { operation: "decision.status",
      arguments: ["--db", f.database, "--cwd", f.root, "--file", file] });
  } catch (error) { rejection = error; }
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(await readFile(f.database)), hash(before), "read tool must preserve database bytes");
  assert.match(rejection?.message ?? "", /Unknown read operation/u);
});

test("a missing record returns an exact usable absence basis even for a long identifier", async (t) => {
  const f = await fixture(t);
  const id = `fact:${"valid-name-".repeat(2500)}`;
  const missing = await f.cli(["get", id]);
  assert.equal(missing.value.error.code, "record_not_found");
  const basis = missing.value.error.identifiers.write_basis;
  assert.equal(basis.targets[0].id === id, true, "absence target must never be clipped as diagnostic text");
  const created = await f.cli(["put"], { v: 5, request_id: "create-from-absence", write_basis: basis,
    input: { mode: "create", record: { id, kind: "fact", name: "New fact", scope: "global",
      availability: "known", data: { observation: true }, aliases: [], links: [], sources: [] } } });
  assert.equal(created.code, 0, JSON.stringify(created.value));
  assert.equal(created.value.data.id, id);
});

test("native pending mutation uses the checkout from its observed basis", async (t) => {
  const f = await fixture(t);
  await f.create("project:native-route", "project", { roots: [f.root] }, "project:native-route");
  const input = { id: "pending:route", text: "Keep this observation in the selected project" };
  const canonical = await f.request(input, [{ kind: "record", id: input.id },
    { kind: "record", id: "project:native-route" }], "project:native-route");
  const request = { v: 5, request_id: canonical.request_id, input,
    write_basis: { database_instance_id: canonical.database_instance_id, database_epoch: canonical.database_epoch,
      project_scope: canonical.project_scope, checkout: canonical.checkout,
      targets: canonical.preconditions.map(({ target, expected_revision }) => ({ ...target, expected_revision })) } };
  const prior = process.env.LODESTAR_DB;
  process.env.LODESTAR_DB = f.database;
  t.after(() => { if (prior === undefined) delete process.env.LODESTAR_DB; else process.env.LODESTAR_DB = prior; });
  const response = await callNativeTool("lodestar_mutate", { operation: "pending.add", request });
  assert.equal(response.ok, true);
  assert.equal(response.data.record.scope, "project:native-route");
  assert.equal(response.data.record.data.text, input.text);
});
