import { createHash } from "node:crypto";
import {
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import { lodestarError, wrapError } from "../errors.mjs";
import {
  canonicalStringify,
} from "../json.mjs";
import { verifyV070Integrity } from "./integrity.mjs";
import { parseJson, parseJsonLines } from "./parse.mjs";

const GENERATION_ID = /^[a-f0-9]{64}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const LOCATOR_HEALTH_STATES = new Set([
  "ok",
  "missing",
  "unreadable",
  "unchecked",
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRelative(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || UNPAIRED_SURROGATE.test(value)
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split("/").includes("..")
  ) {
    throw lodestarError(
      "legacy_path_invalid",
      "The v0.7 store contains an unsafe relative path.",
      { identifiers: { path: value ?? null } },
    );
  }
  return value;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

async function assertComponents(base, relative, { optional = false } = {}) {
  let current = base;
  const parts = safeRelative(relative).split("/");
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (optional && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw lodestarError(
        "legacy_path_invalid",
        "The v0.7 source contains a symbolic link.",
        { identifiers: { path: relative } },
      );
    }
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw lodestarError(
        "legacy_path_invalid",
        "A v0.7 source path crosses a non-directory entry.",
        { identifiers: { path: relative } },
      );
    }
  }
  return current;
}

function tracker() {
  return {
    files: new Map(),
  };
}

async function readConfinedBuffer(
  base,
  relative,
  state,
  {
    label = relative,
    optional = false,
  } = {},
) {
  const cached = state.files.get(label);
  if (cached) return cached.buffer;
  let candidate;
  try {
    candidate = await assertComponents(base, relative, { optional });
    if (candidate === null) return null;
    const physical = await realpath(candidate);
    if (!inside(base, physical)) {
      throw lodestarError(
        "legacy_path_invalid",
        "A v0.7 source path escapes its store.",
        { identifiers: { path: relative } },
      );
    }
    const handle = await open(physical, "r");
    let buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw lodestarError(
          "legacy_path_invalid",
          "A v0.7 source path is not a regular file.",
          { identifiers: { path: relative } },
        );
      }
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
    state.files.set(label, {
      absolute: physical,
      bytes: buffer.length,
      sha256: digest(buffer),
      buffer,
    });
    return buffer;
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw wrapError(
      error,
      "legacy_source_unreadable",
      "Lodestar could not read the v0.7 source.",
      {
        identifiers: { path: relative },
        action: "Check the source store and run its v0.7 doctor command.",
      },
    );
  }
}

function legacyProjectStem(projectId) {
  // Match v0.7's UTF-16 code-unit replacement exactly for shard compatibility.
  return String(projectId).replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function verifyLegacySourceUnchanged(snapshot) {
  for (const expected of snapshot.files) {
    let handle;
    try {
      const info = await lstat(expected.absolute);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("file type changed");
      handle = await open(expected.absolute, "r");
      const buffer = await handle.readFile();
      if (
        buffer.length !== expected.bytes
        || digest(buffer) !== expected.sha256
      ) {
        throw new Error("content changed");
      }
    } catch (error) {
      throw lodestarError(
        "source_changed",
        "The v0.7 source changed during import.",
        {
          identifiers: { path: expected.label },
          action: "Stop v0.7 writers and retry the import.",
          cause: error,
        },
      );
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return true;
}

export async function readV070Store(sourcePath) {
  const source = await realpath(sourcePath).catch((error) => {
    throw wrapError(
      error,
      "legacy_source_unreadable",
      "The v0.7 source directory cannot be resolved.",
      { identifiers: { source: sourcePath } },
    );
  });
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory()) {
    throw lodestarError(
      "legacy_source_invalid",
      "The v0.7 source must be a directory.",
      { identifiers: { source } },
    );
  }
  const state = tracker();
  const current = parseJson(
    await readConfinedBuffer(source, "current.json", state),
    "current.json",
  );
  if (current?.v !== 1 || !GENERATION_ID.test(current?.generation ?? "")) {
    throw lodestarError(
      "legacy_source_invalid",
      "The v0.7 current generation pointer is invalid.",
      { identifiers: { source } },
    );
  }
  const generation = current.generation;
  const generationRelative = `generations/${generation}`;
  const generationCandidate = await assertComponents(source, generationRelative);
  const generationInfo = await lstat(generationCandidate);
  if (!generationInfo.isDirectory()) {
    throw lodestarError(
      "legacy_source_invalid",
      "The active v0.7 generation is not a directory.",
      { identifiers: { generation } },
    );
  }
  const generationRoot = await realpath(generationCandidate);
  if (!inside(source, generationRoot)) {
    throw lodestarError(
      "legacy_path_invalid",
      "The active v0.7 generation escapes its source store.",
      { identifiers: { generation } },
    );
  }

  const manifestBuffer = await readConfinedBuffer(
    generationRoot,
    "integrity.json",
    state,
    { label: `${generationRelative}/integrity.json`, optional: true },
  );
  let integrity = "unsealed";
  if (manifestBuffer) {
    await verifyV070Integrity({
      generationRoot,
      generation,
      manifest: parseJson(manifestBuffer, "integrity.json"),
      readFile: async (relative) => await readConfinedBuffer(
        generationRoot,
        relative,
        state,
        { label: `${generationRelative}/${relative}` },
      ),
    });
    integrity = "verified";
  }

  const catalog = parseJson(
    await readConfinedBuffer(generationRoot, "catalog.json", state, {
      label: `${generationRelative}/catalog.json`,
    }),
    "catalog.json",
  );
  const schema = parseJson(
    await readConfinedBuffer(generationRoot, "schema/store.json", state, {
      label: `${generationRelative}/schema/store.json`,
    }),
    "schema/store.json",
  );
  if (catalog?.v !== 1 || !Array.isArray(catalog.projects) || schema?.v !== 1) {
    throw lodestarError(
      "legacy_source_invalid",
      "The active generation is not a compatible v0.7 layout.",
      { identifiers: { generation } },
    );
  }
  const locatorHealthBuffer = await readConfinedBuffer(
    generationRoot,
    "indexes/locator-health.json",
    state,
    {
      label: `${generationRelative}/indexes/locator-health.json`,
      optional: true,
    },
  );
  const locatorHealth = locatorHealthBuffer
    ? parseJson(locatorHealthBuffer, "indexes/locator-health.json")
    : null;
  if (
    locatorHealth
    && (
      locatorHealth.v !== 1
      || locatorHealth.generation !== generation
      || !locatorHealth.locators
      || typeof locatorHealth.locators !== "object"
      || Array.isArray(locatorHealth.locators)
    )
  ) {
    throw lodestarError(
      "legacy_source_invalid",
      "The v0.7 locator-health index has an invalid header.",
      { identifiers: { generation } },
    );
  }
  const healthKeys = Object.keys(locatorHealth?.locators ?? {}).sort();
  for (const key of healthKeys) {
    const health = locatorHealth.locators[key];
    if (
      !health
      || typeof health !== "object"
      || Array.isArray(health)
      || !LOCATOR_HEALTH_STATES.has(health.status)
    ) {
      throw lodestarError(
        "legacy_source_invalid",
        "The v0.7 locator-health index contains an invalid observation.",
        { identifiers: { locator: key } },
      );
    }
  }
  const records = parseJsonLines(
    await readConfinedBuffer(generationRoot, "records/global.jsonl", state, {
      label: `${generationRelative}/records/global.jsonl`,
    }),
    "records/global.jsonl",
    "global",
  );
  const stems = new Map();
  for (const [projectIndex, project] of catalog.projects.entries()) {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw lodestarError(
        "legacy_source_invalid",
        "The v0.7 catalog contains an invalid project.",
        { identifiers: { project_index: projectIndex } },
      );
    }
    const stem = legacyProjectStem(project.id);
    if (!stem || stems.has(stem.toLowerCase())) {
      throw lodestarError(
        "legacy_source_invalid",
        "The v0.7 catalog has colliding project shard names.",
        { identifiers: { project: project.id ?? null } },
      );
    }
    stems.set(stem.toLowerCase(), project.id);
    const relative = `records/projects/${stem}.jsonl`;
    records.push(...parseJsonLines(
      await readConfinedBuffer(generationRoot, relative, state, {
        label: `${generationRelative}/${relative}`,
      }),
      relative,
      `project:${project.id}`,
    ));
  }

  const files = [...state.files.entries()]
    .map(([label, value]) => ({
      label,
      absolute: value.absolute,
      bytes: value.bytes,
      sha256: value.sha256,
    }))
    .sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
  return {
    source,
    generation,
    integrity,
    versionEvidence: "compatible_layout",
    catalog,
    schema,
    locatorHealth,
    records,
    snapshot: {
      fingerprint: digest(canonicalStringify(
        files.map(({ label, bytes, sha256 }) => ({ label, bytes, sha256 })),
      )),
      files,
    },
  };
}
