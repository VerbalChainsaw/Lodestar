// GAP-REGRESSION SUITE
//
// Two tests, both of which survived adversarial re-checking of their own premises, and both of
// which guard behaviour that was BROKEN when this audit found it and is now FIXED. They pass at
// the revision they were installed against; each is a tripwire, not a failing-before witness.
//
// WHY ONLY TWO. Candidates that did NOT survive scrutiny and are deliberately absent:
//   * "--output blocks its own retry" — the refusal is the product's consistent exclusive-create
//     design (`open(destination, "wx")`, one of 15 such call sites across src/), and temp names are
//     always randomised so a path is never reused. A test asserting the retry would encode the
//     WRONG contract and contradict the rest of the product. The only real defect was the --help
//     wording, which promised a hash receipt without stating either that the path must be new or
//     where the receipt appears. src/cli.mjs:63 (per-command) and :78 (top level) now both state
//     all four conditions: the path must be new, an occupied path is refused with output_conflict,
//     stdout carries the receipt on success, and the stderr error envelope carries it on failure.
//   * "handoff/decision cannot bound reads" — both DO report omission: `handoff status` returns
//     `more: false` and `decision show` returns `more` as a boolean, verified against a store with
//     56 handoff records and 101 decision events, where the response is ~1 KB and does not grow
//     with history. The only residue is that these two families declare no `--limit` while
//     `work`/`pending` do. That is a feature asymmetry, not a correctness defect.
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

async function scratch(t, prefix) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function cli(database, args) {
  let stdout = "", stderr = "";
  const code = await runCli(["--db", database, ...args], {
    stdin: { [Symbol.asyncIterator]: async function* () {} },
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  return { code, stdout, stderr, value: JSON.parse(stdout || stderr) };
}

// ---------------------------------------------------------------------------
// 1. A request passed to `init` must be honoured or refused — never silently dropped.
//
// Was: `init --file <request>` without --migrate returned exit 0 / ok:true, created a zero-record
// store, and ignored the request — silent intent loss reported as success.
// Now: exit 2 invalid_input, no store created, action naming --migrate and --promote-recovery.
// ---------------------------------------------------------------------------
test("init --file without --migrate refuses instead of silently ignoring the request", async (t) => {
  const root = await scratch(t, "lodestar-init-file-");
  const database = path.join(root, "lodestar.db");
  const request = path.join(root, "request.json");
  await writeFile(request, JSON.stringify({ v: 5, request_id: "init-file-guard", preflight: {}, backup: {} }));

  const result = await cli(database, ["init", "--file", request]);

  assert.notEqual(result.code, 0, "a request-bearing init without --migrate must not report success");
  assert.equal(result.value.ok, false, "a dropped request must not be reported as ok");
  assert.match(String(result.value.error?.action ?? ""), /--migrate/,
    "the refusal must name the flag that would honour the request");
  assert.equal(await stat(database).then(() => true, () => false), false,
    "the refused invocation must not create a store, or the corrected retry has to work around it");
});

// ---------------------------------------------------------------------------
// 3. A failure that happens BEFORE dispatch must not claim an unknown write outcome.
//
// The --output reservation runs before the command is even read, so nothing can have been
// accepted. It used to rethrow the raw filesystem error, which the envelope builder turned into
// `internal_error` + "This error does not establish whether a write was accepted" — sending the
// caller into a reconciliation that cannot find anything. It is now a typed input error.
// ---------------------------------------------------------------------------
test("an unreservable --output reports a typed input error, not an unknown write outcome", async (t) => {
  const root = await scratch(t, "lodestar-output-reserve-");
  const database = path.join(root, "lodestar.db");
  assert.equal((await cli(database, ["init"])).code, 0);
  const before = await readFile(database);

  const unreservable = [
    path.join(root, "missing-parent", "out.json"),   // ENOENT
    path.join(root, `${"x".repeat(300)}.json`),      // ENAMETOOLONG
  ];
  // Angle brackets are legal POSIX filename characters.
  if (process.platform === "win32") unreservable.push(path.join(root, "bad<name>.json"));

  for (const target of unreservable) {
    const r = await cli(database, ["version", "--output", target]);
    assert.equal(r.value.error?.code, "invalid_path",
      `expected a typed input error for ${path.basename(target)}, got ${r.value.error?.code}`);
    assert.equal(r.code, 2, "an input error must not take the internal-error exit");
    const action = String(r.value.error?.action ?? "");
    assert.doesNotMatch(action, /does not establish whether a write was accepted/,
      "a pre-dispatch failure must not claim the write outcome is unknown");
    assert.match(String(r.value.error?.message ?? ""), /no write was dispatched/i,
      "the message must state that nothing was dispatched");
    assert.deepEqual(await readFile(database), before);
  }
  if (process.platform !== "win32") {
    const target = path.join(root, "bad<name>.json");
    const result = await cli(database, ["version", "--output", target]);
    assert.equal(result.code, 0);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.data.output_file.path, target);
    assert.equal(JSON.parse(await readFile(target, "utf8")).ok, true);
    assert.deepEqual(await readFile(database), before);
  }
});
