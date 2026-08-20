import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BOOTSTRAP_TEXT } from "../src/bootstrap.mjs";
import {
  manageAgents,
  REPOSITORY_AGENTS_MARKER,
  repositoryAgentsText,
} from "../src/agents.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-agents-readonly-"));
  const project = path.join(directory, "project");
  await mkdir(project, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const spawn = () => ({ stdout: "", status: 128 });
  return { project, spawn, file: path.join(project, "AGENTS.md") };
}

test("AGENTS status and verification are read-only", async (t) => {
  const { project, spawn, file } = await fixture(t);
  const missing = await manageAgents("status", { cwd: project, spawn });
  assert.equal(missing.readOnly, true);
  assert.equal(missing.state, "missing");
  assert.equal(missing.verified, false);
  await assert.rejects(access(file), { code: "ENOENT" });

  await writeFile(file, BOOTSTRAP_TEXT, "utf8");
  const legacy = await manageAgents("verify", { cwd: project, spawn });
  assert.equal(legacy.state, "legacy-managed");
  assert.equal(legacy.verified, false);
  assert.equal(await readFile(file, "utf8"), BOOTSTRAP_TEXT);

  await writeFile(file, repositoryAgentsText(), "utf8");
  const verified = await manageAgents("verify", { cwd: project, spawn });
  assert.equal(verified.state, "verified");
  assert.equal(verified.verified, true);
  assert.equal(await readFile(file, "utf8"), repositoryAgentsText());
});

test("AGENTS mutation operations are retired and cannot touch missing, managed, or custom files", async (t) => {
  const { project, spawn, file } = await fixture(t);
  for (const initial of [
    null,
    `${REPOSITORY_AGENTS_MARKER}\n# stale managed content\n`,
    "# Project-owned rules\nPreserve this exact file.\n",
  ]) {
    if (initial === null) await rm(file, { force: true });
    else await writeFile(file, initial, "utf8");
    for (const action of ["apply", "remove"]) {
      await assert.rejects(
        manageAgents(action, { cwd: project, spawn }),
        ({ code }) => code === "repository_agents_read_only",
      );
      if (initial === null) await assert.rejects(access(file), { code: "ENOENT" });
      else assert.equal(await readFile(file, "utf8"), initial);
    }
  }
});

test("template returns source text without writing AGENTS.md", async (t) => {
  const { project, spawn, file } = await fixture(t);
  const stub = await manageAgents("template", { cwd: project, spawn, mode: "stub" });
  assert.equal(stub.readOnly, true);
  assert.equal(stub.text, repositoryAgentsText());
  const full = await manageAgents("template", { cwd: project, spawn, mode: "full" });
  assert.match(full.text, /^# AGENTS\.md for <PROJECT NAME>/u);
  assert.match(full.text, /delete what does not apply/iu);
  await assert.rejects(access(file), { code: "ENOENT" });
});
