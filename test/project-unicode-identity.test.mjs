import assert from "node:assert/strict";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { hash, normalizeMachinePath, sameMachinePath } from "../src/project.mjs";
import { fixture } from "./helpers/contract.mjs";

test("physical Windows Unicode directories cannot be conflated by JavaScript lowercase", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await fixture(t);
  const latin = path.join(f.root, "K"), kelvin = path.join(f.root, "\u212A");
  await mkdir(latin); await mkdir(kelvin);
  const a = await stat(latin, { bigint: true }), b = await stat(kelvin, { bigint: true });
  assert.notEqual(a.ino, b.ino, "the fixture must prove two actual directory objects");
  assert.notEqual(await realpath(latin), await realpath(kelvin));
  assert.equal(sameMachinePath(latin, kelvin), false);
  await f.create("project:latin", "project", { roots: [latin] }, "project:latin");
  const before = await f.cli(["start", "--cwd", kelvin]);
  assert.notEqual(before.value.scope.project, "project:latin", "another physical checkout must not inherit this project");
  await f.create("project:kelvin", "project", { roots: [kelvin] }, "project:kelvin");
  assert.equal((await f.cli(["start", "--cwd", latin])).value.scope.project, "project:latin");
  assert.equal((await f.cli(["start", "--cwd", kelvin])).value.scope.project, "project:kelvin");
});
test("actual Unicode case aliases retain the filesystem's existing identity", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await fixture(t);
  const upper = path.join(f.root, "\u00C7"), lower = path.join(f.root, "\u00E7");
  await mkdir(upper);
  assert.equal((await stat(upper, { bigint: true })).ino, (await stat(lower, { bigint: true })).ino);
  assert.equal(sameMachinePath(upper, lower), true);
});
test("changed legacy Unicode fallback scope is surfaced with a usable read instead of silent omission", {
  skip: process.platform !== "win32",
}, async (t) => {
  const f = await fixture(t);
  const kelvin = path.join(f.root, "\u212A"); await mkdir(kelvin);
  const oldScope = `project:cwd:${hash(normalizeMachinePath(await realpath(kelvin)).toLowerCase())}`;
  await f.create("note:legacy-unicode", "note", { body: "retain" }, oldScope);
  const start = await f.cli(["start", "--cwd", kelvin]);
  assert.equal(start.code, 0, JSON.stringify(start.value));
  assert.notEqual(start.value.scope.project, oldScope);
  const issue = start.value.data.record_errors.find((entry) => entry.code === "project_identity_reinspection_required");
  assert.ok(issue, "a changed old scope with stored rows must not silently disappear");
  assert.deepEqual(issue.identifiers.read_args, ["find", "--all", "--scope", oldScope]);
  const rows = await f.cli(issue.identifiers.read_args);
  assert.equal(rows.code, 0);
  assert.ok(rows.value.data.records.some((record) => record.id === "note:legacy-unicode"));
  assert.match(issue.action, /preserve|reconcile/i);
});
