import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fixture, temporaryDirectory } from "./helpers/contract.mjs";

test("the shipped decision replay recipe uses original scope and exact saved bytes", async (t) => {
  const document = process.env.LODESTAR_RECIPE_TEST_DOCUMENT ??
    fileURLToPath(new URL("../docs/operator-recipes.md", import.meta.url));
  const text = await readFile(document, "utf8");
  const arrays = [...text.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/gu)]
    .map((match) => JSON.parse(match[1]));
  const recipe = arrays.find((value) => Array.isArray(value) && value[2] === "decision" && value[3] === "set");
  assert.ok(recipe, "The shipped dotted-operation replay recipe must exist as a literal argument array.");
  const f = await fixture(t);
  const unrelated = await temporaryDirectory(t, "lodestar-recipe-other-");
  await f.create("project:recipe", "project", { roots: [f.root] }, "project:recipe");
  await f.create("project:unrelated", "project", { roots: [unrelated] }, "project:unrelated");
  const request = await f.request({ key: "recipe:choice", value: "retain", reason: "Exact saved recipe test", status: "accepted" },
    [{ kind: "record", id: "project:recipe" },
      { kind: "decision", scope: "project:recipe", key: "recipe:choice" }], "project:recipe");
  const requestFile = path.join(f.root, "exact-request.json");
  const bytes = Buffer.from(JSON.stringify(request) + "\n");
  await writeFile(requestFile, bytes, { flag: "wx" });
  const entry = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
  const invoke = (args, cwd) => {
    const processResult = spawnSync(process.execPath, [entry, ...args],
      { cwd, windowsHide: true, encoding: "utf8", timeout: 15000 });
    assert.equal(processResult.error, undefined);
    return { processResult, envelope: JSON.parse(processResult.stdout || processResult.stderr) };
  };
  const replacements = new Map([
    ["<same-database>", f.database], ["<original-project-root>", f.root], ["<exact-request-file>", requestFile],
  ]);
  const args = recipe.map((argument) => replacements.get(argument) ?? argument);
  assert.ok(args.every((argument) => typeof argument === "string" && !/^<.*>$/u.test(argument)),
    "Every placeholder needs an explicit fixture value; never guess missing context.");
  // A saved request may not have committed. Exercise that recovery branch before
  // the receipt exists, then prove exact replay of the confirmed receipt.
  const first = invoke(args, unrelated);
  assert.equal(first.processResult.status, 0,
    "The documented pending request must use its original project before any receipt exists: " + JSON.stringify(first.envelope));
  assert.equal(first.envelope.request.replayed, false);
  const replay = invoke(args, unrelated);
  assert.equal(replay.processResult.status, 0,
    "The actual documented replay must work from another bound project: " + JSON.stringify(replay.envelope));
  assert.equal(replay.envelope.request.id, request.request_id);
  assert.equal(replay.envelope.request.replayed, true);
  assert.equal(replay.envelope.revision, first.envelope.revision);
  assert.deepEqual(await readFile(requestFile), bytes);
  const db = new DatabaseSync(f.database, { readOnly: true });
  try {
    const eventRows = db.prepare("SELECT id, scope, content_json FROM records WHERE type='decision-event'").all();
    assert.equal(eventRows.length, 1);
    assert.equal(eventRows[0].scope, "project:recipe");
    const receiptRows = db.prepare("SELECT id, content_json FROM records WHERE type='mutation-receipt'").all();
    const matching = receiptRows.filter((row) => JSON.parse(row.content_json).value.request_id === request.request_id);
    assert.equal(matching.length, 1);
    assert.equal(JSON.parse(matching[0].content_json).value.committed_revision, first.envelope.revision);
    assert.equal(createHash("sha256").update(await readFile(requestFile)).digest("hex"),
      createHash("sha256").update(bytes).digest("hex"));
  } finally { db.close(); }
});
