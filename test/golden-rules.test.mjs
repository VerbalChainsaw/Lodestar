import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REQUIRED_GOVERNANCE } from "../src/bootstrap.mjs";
import { runCli } from "../src/cli.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FLOOR_BUDGET = 8 * 1024;

const EXPECTED_ACTIONS = Object.freeze([
  "authority:stop-on-truncated-clipped-malformed-or-incomplete-input",
  "authority:never-infer-missing-authorization",
  "authority:current-instruction-then-project-contracts-then-global-defaults",
  "scope:preserve-user-intent-and-smallest-sufficient-implementation",
  "environment:single-operator-prototype-development-workstation-by-default",
  "worktree:dirty-state-is-normal-and-never-blocks-work-by-itself",
  "worktree:assume-existing-changes-are-authorized-owner-work",
  "worktree:build-on-existing-work-and-fold-relevant-partial-work-forward",
  "worktree:never-quarantine-bypass-ignore-overwrite-reformat-or-rebuild-around-wip",
  "worktree:never-warn-about-dirty-state-unless-it-directly-blocks-the-task",
  "worktree:never-rollback-revert-reset-discard-restore-clean-stash-checkout-or-overwrite-without-explicit-permission",
  "worktree:wip-is-forward-motion-not-contamination",
  "priority:protect-then-honor-scope-then-produce-then-verify-then-report-then-stop",
  "execution:do-the-requested-work-not-process-theater",
  "context:read-surgically-and-stop-when-the-contract-is-established",
  "evidence:missing-is-unknown-not-proof-of-absence",
  "architecture:no-adjacent-systems-or-speculative-infrastructure",
  "gates:never-weaken-raise-partition-or-rewrite-without-explicit-authorization",
  "scope:stop-when-work-materially-exceeds-the-authorized-tranche",
  "verification:prove-the-critical-path-with-observable-evidence",
  "completion:never-imply-success-without-direct-support",
  "version-control:never-commit-publish-tag-push-or-release-without-authorization"
]);

const EXPECTED_DEFAULTS = Object.freeze({
  "authority_order": [
    "The current user instruction.",
    "Explicit project requirements and active repository contracts.",
    "These required global defaults.",
    "Triggered skills, official documentation, and verified external references.",
    "Generic best practices."
  ],
  "environment": "Assume a single-operator prototype and development workstation, not a conventional multi-developer production environment, unless the current instruction or project contract explicitly says otherwise.",
  "work_in_progress": [
    "A dirty working tree is normal and never blocks work by itself.",
    "Treat dirty, staged, untracked, uncommitted, partial, and committed-in-progress files as valid owner-authorized work in flight, including work produced by another approved agent.",
    "Build on existing work and fold relevant partial work forward.",
    "Do not quarantine, bypass, ignore, overwrite, reformat, or rebuild around work in progress.",
    "Do not warn about a dirty working tree unless it directly blocks the requested task.",
    "Never roll back, revert, reset, discard, restore, clean, stash, checkout over, or overwrite existing changes without explicit permission, even when the current state is broken or the owner is frustrated.",
    "Work in progress is forward motion, not contamination."
  ],
  "operating_order": [
    "Protect existing work, data, credentials, systems, and standing safety boundaries.",
    "Honor the current instruction and exact scope within those boundaries.",
    "Produce the requested material result.",
    "Verify the critical path with observable evidence matched to the claim.",
    "Report facts, failures, uncertainty, and remaining material risk directly.",
    "Leave optional improvements alone and stop when the requested outcome and required direct verification are complete."
  ],
  "execution": [
    "Do the requested work; do not replace implementation with commentary, ceremony, broad audits, test infrastructure, or speculative architecture.",
    "Inspect the live source, owning seams, relevant callers, adjacent context, and actual runtime boundary before changing behavior.",
    "Read surgically: use the smallest sufficient context and stop reading when the change contract is established.",
    "Current source and observed behavior outrank stale plans, screenshots, summaries, and assumptions.",
    "Missing evidence means unknown, not absent, broken, abandoned, or authorized.",
    "A blocker authorizes only the smallest seam needed to clear it; certainty never expands scope, side effects, artifacts, or authority.",
    "Use existing architecture and data contracts; reject hacks, parallel systems, and speculative infrastructure.",
    "Verify every write and completion claim against the real affected boundary, then stop."
  ],
  "version_control": [
    "Commit only with explicit authorization; an authorized commit is a forward-motion checkpoint, not a release ceremony.",
    "Never publish, tag, push, release, rewrite history, or alter unrelated staging without explicit authorization."
  ]
});

async function invoke(args) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    stdin: Readable.from([""]),
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
  });
  assert.equal(exitCode, 0, stderr);
  return { raw: stdout, value: JSON.parse(stdout) };
}

test("the canonical governance source owns the complete Golden Rules", async () => {
  const source = JSON.parse(await readFile(
    path.join(ROOT, "managed-assets", "governance.json"),
    "utf8",
  ));
  const payload = JSON.parse(await readFile(
    path.join(ROOT, "src", "skills-payload.json"),
    "utf8",
  ));

  assert.deepEqual(payload.governance, source);
  assert.deepEqual(REQUIRED_GOVERNANCE, source);
  assert.equal(source.v, 2);
  assert.equal(source.data.v, 2);
  assert.equal(source.data.required, true);
  assert.deepEqual(source.data.scope, ["global"]);
  assert.deepEqual(source.data.action, EXPECTED_ACTIONS);
  assert.deepEqual(source.data.defaults, EXPECTED_DEFAULTS);
  assert.equal(
    source.data.facts.worktree,
    "Work in progress is valid owner-authorized forward motion and must be "
      + "understood, preserved, and folded forward.",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(source), "utf8") < 6 * 1024,
    "required governance must fit inside the minimum startup budget with room to operate",
  );
});

test("startup carries every Golden Rule intact at the minimum supported budget", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lodestar-golden-rules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = path.join(directory, "state", "lodestar.db");

  const started = await invoke([
    "start",
    "--db",
    database,
    "--cwd",
    directory,
    "--session",
    "golden-rules",
    "--startup-budget",
    String(FLOOR_BUDGET),
  ]);
  const rule = started.value.data.required[0];

  assert.equal(rule.id, "g:lodestar:required-governance");
  assert.deepEqual(rule, REQUIRED_GOVERNANCE);
  assert.deepEqual(rule.data.action, EXPECTED_ACTIONS);
  assert.deepEqual(rule.data.defaults, EXPECTED_DEFAULTS);
  assert.equal(started.value.data.omitted.required ?? 0, 0);
  assert.ok(Buffer.byteLength(started.raw, "utf8") <= FLOOR_BUDGET);
});

test("director-protocol references the global owner instead of copying its covenant", async () => {
  const skill = await readFile(
    path.join(ROOT, "managed-assets", "skills", "director-protocol", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /g:lodestar:required-governance/u);
  assert.match(skill, /sole always-on owner/u);
  assert.doesNotMatch(skill, /Work-in-progress code is forward motion, not contamination/u);
  assert.doesNotMatch(skill, /Treat every dirty, untracked, staged/u);
});
