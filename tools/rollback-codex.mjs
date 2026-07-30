#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  realpath,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { atomicWriteFile } from "../lib/atomic-file.mjs";
import { optionValue } from "../lib/cli-options.mjs";
import { errorResult, LodestarError, wrapError } from "../lib/errors.mjs";
import { isMainModule } from "../lib/main-entry.mjs";
import { nativeProjectPath } from "../lib/native-path.mjs";
import { resolveStateHome } from "../lib/state-home.mjs";

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function latestManifest(stateHome) {
  const backups = path.join(stateHome, "backups");
  const entries = await readdir(backups, { withFileTypes: true });
  const candidates = entries
    .filter((entry) =>
      entry.isDirectory() && entry.name.startsWith("codex-install-")
    )
    .map((entry) => path.join(backups, entry.name, "manifest.json"))
    .sort((a, b) => b.localeCompare(a));
  if (candidates.length === 0) {
    throw new Error("no Codex installation backup found");
  }
  return candidates[0];
}

async function currentState(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) {
      throw new LodestarError(
        "codex-managed-file-symlink",
        `Refusing to restore over symbolic link ${file}`,
        { detail: { path: file } },
      );
    }
    const content = await readFile(file);
    return { exists: true, content, sha256: hash(content) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, content: null, sha256: null };
    }
    throw error;
  }
}

async function atomicRestore(file, content) {
  await atomicWriteFile(file, content);
}

async function atomicRemove(file) {
  const temporary = `${file}.rollback-${randomUUID()}.tmp`;
  try {
    await rename(file, temporary);
    await unlink(temporary);
  } catch (error) {
    let restoreError = null;
    try {
      await rename(temporary, file);
    } catch (failure) {
      if (failure.code !== "ENOENT") restoreError = failure;
    }
    if (restoreError) {
      throw new LodestarError(
        "codex-remove-restore-failed",
        `Unable to remove ${file} or restore it after failure`,
        {
          cause: new AggregateError([error, restoreError]),
          detail: {
            path: file,
            cause_code: error.code ?? null,
            restore_code: restoreError.code ?? null,
          },
        },
      );
    }
    throw wrapError(
      error,
      "codex-remove-failed",
      `Unable to remove installed file ${file}`,
      { path: file },
    );
  }
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function confinedManifest(stateHome, manifestPath) {
  const requested = manifestPath
    ? path.resolve(nativeProjectPath(manifestPath))
    : await latestManifest(stateHome);
  let backupTree;
  let selected;
  try {
    [backupTree, selected] = await Promise.all([
      realpath(path.join(stateHome, "backups")),
      realpath(requested),
    ]);
  } catch (error) {
    throw wrapError(
      error,
      "codex-manifest-unreadable",
      `Unable to open Codex rollback manifest ${requested}`,
      { manifest: requested },
    );
  }
  if (
    !pathIsInside(backupTree, selected)
    || path.basename(selected) !== "manifest.json"
    || !path.basename(path.dirname(selected)).startsWith("codex-install-")
  ) {
    throw new LodestarError(
      "codex-manifest-outside-backups",
      "manifest must be inside the Lodestar backup tree",
      {
        detail: {
          manifest: selected,
          backup_tree: backupTree,
        },
      },
    );
  }
  return selected;
}

async function prepareEntry(rawEntry, manifest, manifestPath) {
  if (
    !rawEntry
    || typeof rawEntry !== "object"
    || Array.isArray(rawEntry)
    || typeof rawEntry.path !== "string"
    || typeof rawEntry.existed !== "boolean"
    || !validHash(rawEntry.after_sha256)
    || (
      rawEntry.existed
      && (
        typeof rawEntry.backup !== "string"
        || !validHash(rawEntry.before_sha256)
      )
    )
    || (
      !rawEntry.existed
      && (
        rawEntry.backup !== null
        || rawEntry.before_sha256 !== null
      )
    )
  ) {
    throw new LodestarError(
      "codex-manifest-entry-invalid",
      "invalid Codex installation manifest entry",
    );
  }

  const target = nativeProjectPath(rawEntry.path);
  if (!["AGENTS.md", "AGENTS.override.md"].includes(path.basename(target))) {
    throw new LodestarError(
      "codex-manifest-target-invalid",
      `Invalid Codex rollback target ${target}`,
      { detail: { path: target } },
    );
  }
  let home = null;
  if (manifest.v === 2) {
    if (typeof rawEntry.home !== "string") {
      throw new LodestarError(
        "codex-manifest-target-invalid",
        "Version 2 Codex rollback entries require a home",
      );
    }
    home = nativeProjectPath(rawEntry.home);
    if (path.dirname(target) !== home) {
      throw new LodestarError(
        "codex-manifest-target-invalid",
        `Codex rollback target is outside its declared home: ${target}`,
        { detail: { home, path: target } },
      );
    }
  }

  let backup = null;
  let backupContent = null;
  if (rawEntry.existed) {
    try {
      backup = await realpath(nativeProjectPath(rawEntry.backup));
      if (path.dirname(backup) !== path.dirname(manifestPath)) {
        throw new LodestarError(
          "codex-backup-outside-manifest",
          "backup must be beside its installation manifest",
          { detail: { backup, manifest: manifestPath } },
        );
      }
      backupContent = await readFile(backup);
    } catch (error) {
      if (error instanceof LodestarError) throw error;
      throw wrapError(
        error,
        "codex-backup-unreadable",
        `Unable to read Codex backup ${rawEntry.backup}`,
        { backup: rawEntry.backup },
      );
    }
    if (hash(backupContent) !== rawEntry.before_sha256) {
      throw new LodestarError(
        "codex-backup-hash-mismatch",
        `backup hash mismatch: ${backup}`,
        { detail: { backup } },
      );
    }
  }

  const entry = {
    ...rawEntry,
    ...(home ? { home } : {}),
    path: target,
    backup,
  };
  const state = await currentState(target);
  const alreadyRestored = entry.existed
    ? state.sha256 === entry.before_sha256
    : !state.exists;
  return { entry, state, alreadyRestored, backupContent };
}

export async function rollbackCodex({
  stateHome,
  manifestPath,
  force = false,
} = {}) {
  if (!stateHome) {
    throw new LodestarError(
      "state-home-required",
      "stateHome is required for Codex rollback",
    );
  }
  const selectedManifest = await confinedManifest(stateHome, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(selectedManifest, "utf8"));
  } catch (error) {
    throw wrapError(
      error,
      "codex-manifest-invalid-json",
      `Unable to parse Codex rollback manifest ${selectedManifest}`,
      { manifest: selectedManifest },
    );
  }
  if (![1, 2].includes(manifest?.v) || !Array.isArray(manifest.files)) {
    throw new LodestarError(
      "codex-manifest-invalid",
      "invalid Codex installation manifest",
      { detail: { manifest: selectedManifest } },
    );
  }

  const states = [];
  for (const rawEntry of manifest.files) {
    const prepared = await prepareEntry(
      rawEntry,
      manifest,
      selectedManifest,
    );
    if (
      !prepared.alreadyRestored
      && !force
      && prepared.state.sha256 !== prepared.entry.after_sha256
    ) {
      throw new LodestarError(
        "codex-active-file-drift",
        `active file changed after installation: ${prepared.entry.path}`,
        { detail: { path: prepared.entry.path } },
      );
    }
    states.push(prepared);
  }

  let restored = 0;
  let unchanged = 0;
  const changed = [];
  try {
    for (const prepared of states) {
      const { entry, state, alreadyRestored, backupContent } = prepared;
      if (alreadyRestored) {
        unchanged += 1;
        continue;
      }
      if (entry.existed) {
        await atomicRestore(entry.path, backupContent);
      } else if (state.exists) {
        await atomicRemove(entry.path);
      }
      changed.push(prepared);
      restored += 1;
    }
  } catch (error) {
    const restoreErrors = [];
    for (const { entry, state } of [...changed].reverse()) {
      try {
        if (state.exists) {
          await atomicWriteFile(entry.path, state.content);
        } else {
          await unlink(entry.path).catch((failure) => {
            if (failure.code !== "ENOENT") throw failure;
          });
        }
      } catch (failure) {
        restoreErrors.push(failure);
      }
    }
    if (restoreErrors.length > 0) {
      throw new LodestarError(
        "codex-rollback-restore-failed",
        "Codex rollback failed and the installed state could not be fully restored",
        {
          cause: new AggregateError([error, ...restoreErrors]),
          detail: {
            changed: changed.map(({ entry }) => entry.path),
            restore_error_count: restoreErrors.length,
            cause_code: error.code ?? null,
          },
        },
      );
    }
    throw wrapError(
      error,
      "codex-rollback-failed",
      `Codex rollback failed: ${error.message}`,
      { changed: changed.map(({ entry }) => entry.path) },
    );
  }
  return {
    ok: true,
    manifest: selectedManifest,
    restored,
    unchanged,
  };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const result = await rollbackCodex({
      stateHome: resolveStateHome({
        explicit: optionValue(args, "--home"),
      }),
      manifestPath: optionValue(args, "--manifest"),
      force: args.includes("--force"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = errorResult(error);
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: failure })}\n`,
    );
    process.exitCode = 2;
  }
}
