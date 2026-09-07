import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const entry = path.resolve(process.argv[2] ?? ".package-smoke/node_modules/lodestar-agent-context/lodestar.mjs");
const temporaryRoot = path.resolve(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryRoot, "lodestar-packed-smoke-"));
const database = path.join(directory, "registry.db");
let checks = 0;
function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [entry, ...args, "--db", database], {
    cwd: directory, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedStatus, `${args.join(" ")}: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse((result.stdout || result.stderr).trim());
  assert.equal(envelope.ok, expectedStatus === 0);
  checks += 1;
  return envelope;
}
async function mutate(command, request) {
  const file = path.join(directory, `${request.request_id}.json`);
  await writeFile(file, JSON.stringify(request), "utf8");
  return run([command, "--file", file]);
}
try {
  run(["--help"]);
  run(["init"]);
  const missing = run(["get", "smoke"], 3);
  assert.equal(missing.error.code, "record_not_found");
  const create = { v: 5, request_id: "packed-smoke-create",
    write_basis: missing.error.identifiers.write_basis,
    input: { mode: "create", record: { id: "smoke", kind: "note", name: "Smoke", scope: "global",
      availability: "known", data: { text: "packed — 日本語\r\nsecond line" },
      aliases: ["packed smoke"], links: [], sources: [] } } };
  const accepted = await mutate("put", create);
  const replayed = await mutate("put", create);
  assert.equal(replayed.revision, accepted.revision);
  const current = run(["get", "packed smoke"]);
  assert.deepEqual(current.data.data, create.input.record.data);
  assert.equal(run(["find", "packed"]).data.records.length, 1);
  assert.deepEqual(run(["links", "smoke"]).data.links, []);
  assert.equal(run(["doctor"]).data.healthy, true);
  run(["export"]);
  await mutate("delete", { v: 5, request_id: "packed-smoke-retire",
    write_basis: current.data.write_basis, input: { id: "smoke", reason: "Packed artifact verified" } });
  assert.equal(run(["get", "smoke"]).data.semantics.lifecycle, "historical");
  assert.equal(run(["find", "packed"]).data.records.length, 0);
  console.log(JSON.stringify({ ok: true, contract: 5, checks, entry,
    explicit_initialization: true, observed_bases: true, exact_replay: true,
    unicode_and_line_endings: true, retirement: true }));
} finally {
  assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
  assert.ok(path.basename(directory).startsWith("lodestar-packed-smoke-"));
  await rm(directory, { recursive: true, force: true });
}
