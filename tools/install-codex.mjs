#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { atomicWriteFile } from "../lib/atomic-file.mjs";
import { optionValue, optionValues } from "../lib/cli-options.mjs";
import { errorResult, LodestarError, wrapError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";

export const CODEX_BOOTSTRAP = [
  "BOOT=agentctx start --cwd <cwd>",
  "APPLY=required[]",
  "LOOKUP=agentctx.find>agentctx.get>repo.targeted>repo.broad",
  "FAIL=repo.targeted+report.context_error",
].join("\n");

export const MANAGED_START = "<!-- lodestar:start v1 -->";
export const MANAGED_END = "<!-- lodestar:end -->";

function hash(text) {
  return createHash("sha256").update(text).digest("hex");
}

function managedBlock(eol = "\n") {
  return [
    MANAGED_START,
    "<INSTRUCTIONS>",
    ...CODEX_BOOTSTRAP.split("\n"),
    "</INSTRUCTIONS>",
    MANAGED_END,
  ].join(eol);
}

export function updateManagedBlock(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text.trim() === CODEX_BOOTSTRAP) {
    return `${managedBlock(eol)}${eol}`;
  }
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  const secondStart = start < 0
    ? -1
    : text.indexOf(MANAGED_START, start + MANAGED_START.length);
  const secondEnd = end < 0
    ? -1
    : text.indexOf(MANAGED_END, end + MANAGED_END.length);
  if (
    (start < 0) !== (end < 0)
    || (start >= 0 && end < start)
    || secondStart >= 0
    || secondEnd >= 0
  ) {
    throw new Error("invalid Lodestar managed block");
  }
  if (start >= 0) {
    return text.slice(0, start)
      + managedBlock(eol)
      + text.slice(end + MANAGED_END.length);
  }
  const separator = text.length === 0
    ? ""
    : text.endsWith(eol + eol)
      ? ""
      : text.endsWith(eol)
        ? eol
        : eol + eol;
  return `${text}${separator}${managedBlock(eol)}${eol}`;
}

function safeTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function defaultCodexHomes({
  env = process.env,
  home = os.homedir(),
} = {}) {
  return [
    nativeProjectPath(env.CODEX_HOME || path.join(home, ".codex"), { env }),
  ];
}

async function readManagedTarget(home) {
  const override = path.join(home, "AGENTS.override.md");
  let agents = path.join(home, "AGENTS.md");
  try {
    const info = await lstat(override);
    if (info.isSymbolicLink()) {
      throw new LodestarError(
        "codex-managed-file-symlink",
        `Refusing to replace symbolic link ${override}`,
        { detail: { path: override } },
      );
    }
    agents = override;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let before = "";
  let existed = true;
  try {
    const info = await lstat(agents);
    if (info.isSymbolicLink()) {
      throw new LodestarError(
        "codex-managed-file-symlink",
        `Refusing to replace symbolic link ${agents}`,
        { detail: { path: agents } },
      );
    }
    before = await readFile(agents, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existed = false;
  }
  return {
    home,
    agents,
    before,
    existed,
    after: updateManagedBlock(before),
  };
}

export async function installCodex({
  homes = defaultCodexHomes(),
  stateHome,
  now = () => new Date(),
  nonce = randomUUID,
} = {}) {
  if (!stateHome) {
    throw new LodestarError(
      "state-home-required",
      "stateHome is required for Codex installation",
    );
  }

  const prepared = [];
  const targets = new Set();
  for (const rawHome of homes) {
    const home = path.resolve(nativeProjectPath(rawHome));
    try {
      await mkdir(home, { recursive: true });
      const item = await readManagedTarget(home);
      if (targets.has(item.agents)) continue;
      targets.add(item.agents);
      prepared.push(item);
    } catch (error) {
      throw wrapError(
        error,
        "codex-install-preflight-failed",
        `Unable to prepare Codex home ${home}: ${error.message}`,
        { home },
      );
    }
  }

  const createdAt = now();
  const backupRoot = path.join(
    stateHome,
    "backups",
    `codex-install-${safeTimestamp(createdAt)}-${nonce()}`,
  );
  const installed = [];
  const files = [];
  const changed = [];
  try {
    await mkdir(path.dirname(backupRoot), { recursive: true });
    await mkdir(backupRoot);
    for (const [index, item] of prepared.entries()) {
      const backup = path.join(backupRoot, `${index}-AGENTS.md`);
      if (item.existed) await copyFile(item.agents, backup);
      files.push({
        home: item.home,
        path: item.agents,
        existed: item.existed,
        backup: item.existed ? backup : null,
        before_sha256: item.existed ? hash(item.before) : null,
        after_sha256: hash(item.after),
      });
      installed.push({ home: item.home, agents: item.agents });
    }
    const manifest = path.join(backupRoot, "manifest.json");
    await atomicWriteFile(
      manifest,
      `${JSON.stringify({
        v: 2,
        created_at: createdAt.toISOString(),
        files,
      }, null, 2)}\n`,
    );
    for (const item of prepared) {
      await atomicWriteFile(item.agents, item.after);
      changed.push(item);
    }
    return { installed, manifest };
  } catch (error) {
    const restoreErrors = [];
    for (const item of [...changed].reverse()) {
      try {
        if (item.existed) {
          await atomicWriteFile(item.agents, item.before);
        } else {
          await unlink(item.agents).catch((failure) => {
            if (failure.code !== "ENOENT") throw failure;
          });
        }
      } catch (failure) {
        restoreErrors.push(failure);
      }
    }
    await rm(backupRoot, { recursive: true, force: true }).catch(
      (failure) => restoreErrors.push(failure),
    );
    if (restoreErrors.length > 0) {
      throw new LodestarError(
        "codex-install-restore-failed",
        "Codex installation failed and prior files could not be fully restored",
        {
          cause: new AggregateError([error, ...restoreErrors]),
          detail: {
            changed: changed.map(({ agents }) => agents),
            restore_error_count: restoreErrors.length,
            cause_code: error.code ?? null,
          },
        },
      );
    }
    throw wrapError(
      error,
      "codex-install-failed",
      `Codex installation failed: ${error.message}`,
      { changed: changed.map(({ agents }) => agents) },
    );
  }
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const explicitHome = optionValue(args, "--home");
    const homes = optionValues(args, "--codex-home");
    const result = await installCodex({
      homes: homes.length > 0 ? homes : defaultCodexHomes(),
      stateHome: resolveStateHome({ explicit: explicitHome }),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const failure = errorResult(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: failure })}\n`,
    );
    process.exitCode = 2;
  }
}
