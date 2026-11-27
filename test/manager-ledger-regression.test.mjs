import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { executeCli } from "../src/interface-client.mjs";
import { loadInterfaceConfig } from "../src/interface-config.mjs";
import { runManager } from "../src/manager.mjs";
import { fixture } from "./helpers/contract.mjs";

async function selectionFor(f) {
  const loader = path.join(f.root, "Loader.exe");
  await writeFile(loader, "fixture");
  const config = path.join(f.root, "interfaces.json");
  await writeFile(config, JSON.stringify({ v: 1, generation: randomUUID(), loader,
    runtime: { node: process.execPath, cli: fileURLToPath(new URL("../lodestar.mjs", import.meta.url)),
      database: f.database } }));
  return loadInterfaceConfig(config);
}
function terminal(answers) {
  let output = "";
  return { io: { stdin: { isTTY: true }, stdout: { isTTY: true,
    write: (value) => { output += value; } } }, ask: async () => answers.shift() ?? null,
  output: () => output };
}
for (const [label, text, code] of [
  ["decoded duplicate keys", '{"value":1,"val\\u0075e":2}', "invalid_json"],
  ["lossy decimal", '{"value":0.100000000000000005}', "unsupported_numeric_value"],
  ["unsafe integer", '{"value":9007199254740993}', "unsupported_numeric_value"],
]) test(`Manager refuses ${label} before journaling or write dispatch`, async (t) => {
  const f = await fixture(t); const selection = await selectionFor(f);
  const before = (await f.create("note:edit", "note", { value: 7 })).value.data;
  const term = terminal(["3", "note:edit", "1", "5", "", "", "", text, "SAVE", "6", "2", "9"]);
  let writes = 0;
  await runManager({ selection, ...term, execute: async (selected, invocation) => {
    if (invocation.operation === "put") writes += 1;
    return executeCli(selected, invocation);
  } });
  assert.equal(writes, 0, "strict admission precedes even a reviewed SAVE");
  const after = (await f.cli(["get", "note:edit"])).value.data;
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.data, before.data);
  assert.match(term.output(), new RegExp(code));
  assert.match(term.output(), /Action:/);
  assert.doesNotMatch(term.output(), /Action:\s*(?:undefined|null)/);
});
test("Manager strict editor still reviews and commits valid data", async (t) => {
  const f = await fixture(t); const selection = await selectionFor(f);
  await f.create("note:edit", "note", { value: 7 });
  const term = terminal(["3", "note:edit", "1", "5", "", "", "", '{"value":8}', "SAVE", "6", "2", "9"]);
  assert.equal(await runManager({ selection, ...term }), 0);
  assert.equal((await f.cli(["get", "note:edit"])).value.data.data.value, 8);
});
test("unreadable recovery root gives path and safe action and returns to Manager", async (t) => {
  const f = await fixture(t); const selection = await selectionFor(f);
  const journalRoot = path.join(f.root, "pending");
  await writeFile(journalRoot, "preserve existing bytes");
  const term = terminal(["7", "9"]);
  assert.equal(await runManager({ selection, ...term }), 0);
  assert.match(term.output(), /Recovery unavailable/);
  assert.ok(term.output().includes(journalRoot));
  assert.match(term.output(), /ENOTDIR/);
  assert.match(term.output(), /Action:.*preserve/i);
  assert.equal(await readFile(journalRoot, "utf8"), "preserve existing bytes");
});
