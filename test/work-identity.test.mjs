import assert from "node:assert/strict";
import test from "node:test";

import { NATIVE_TOOLS } from "../codex-plugin/scripts/lodestar-mcp.mjs";
import { normalizeMutationRequest } from "../src/records.mjs";

const basis = {
  database_instance_id: "a".repeat(64),
  database_epoch: "b".repeat(64),
  project_scope: "project:test",
  checkout: null,
  targets: [],
};

test("the native mutation schema cannot fabricate actor or session identity", () => {
  const serialized = JSON.stringify(NATIVE_TOOLS.find(({ name }) => name === "lodestar_mutate"));
  assert.doesNotMatch(serialized, /session_id|authenticated_user|host_attestation/u);
  const request = normalizeMutationRequest({
    v: 5, request_id: "anonymous-factual-write", write_basis: basis,
    input: { mode: "create", record: {} },
  });
  assert.equal(request.actor, null);
});

test("only an actual adapter context may fill an omitted actor", () => {
  const request = { v: 5, request_id: "host-context-write", write_basis: basis,
    input: { id: "work:test", description: "Observed work" } };
  const actor = { id: "codex:actual-session", agent: "codex", harness: "codex" };
  assert.deepEqual(normalizeMutationRequest(request, { actor }).actor, actor);
  const supplied = { v: 5, request_id: request.request_id,
    database_instance_id: basis.database_instance_id, database_epoch: basis.database_epoch,
    project_scope: basis.project_scope, checkout: basis.checkout,
    actor: { id: "external:declared", agent: "external", harness: "native" },
    preconditions: [], input: request.input };
  assert.deepEqual(normalizeMutationRequest(supplied, { actor }).actor, supplied.actor,
    "host defaults must never replace an actor already bound into a full request");
});
