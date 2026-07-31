import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import path from "node:path";

import { lodestarError } from "../errors.mjs";
import { canonicalStringify } from "../json.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/u;
const MAX_FILES = 20_000;
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES = 40_000;
const MAX_DEPTH = 128;

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listGenerationFiles(
  root,
  directory = root,
  depth = 0,
  files = [],
  state = { directories: 0, entries: 0 },
) {
  state.directories += 1;
  if (state.directories > MAX_DIRECTORIES) {
    throw lodestarError(
      "resource_limit",
      "The v0.7 generation exceeds the directory-count limit.",
      {
        identifiers: {
          count: state.directories,
          maximum: MAX_DIRECTORIES,
        },
      },
    );
  }
  if (depth > MAX_DEPTH) {
    throw lodestarError(
      "resource_limit",
      "The v0.7 generation exceeds the directory-depth limit.",
      { identifiers: { depth, maximum: MAX_DEPTH } },
    );
  }
  const entries = [];
  const handle = await opendir(directory);
  for await (const entry of handle) {
    state.entries += 1;
    if (state.entries > MAX_ENTRIES) {
      throw lodestarError(
        "resource_limit",
        "The v0.7 generation exceeds the directory-entry limit.",
        {
          identifiers: {
            count: state.entries,
            maximum: MAX_ENTRIES,
          },
        },
      );
    }
    entries.push(entry);
  }
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      throw lodestarError(
        "legacy_integrity",
        "The sealed v0.7 generation contains a symbolic link.",
        { identifiers: { path: relative } },
      );
    }
    if (entry.isDirectory()) {
      await listGenerationFiles(root, absolute, depth + 1, files, state);
    } else if (entry.isFile()) {
      if (relative !== "integrity.json") files.push(relative);
    } else {
      throw lodestarError(
        "legacy_integrity",
        "The sealed v0.7 generation contains an unsupported file type.",
        { identifiers: { path: relative } },
      );
    }
    if (files.length > MAX_FILES) {
      throw lodestarError(
        "resource_limit",
        "The v0.7 generation exceeds the file-count limit.",
        { identifiers: { count: files.length, maximum: MAX_FILES } },
      );
    }
  }
  return files;
}

function safeManifestPath(relative) {
  return typeof relative === "string"
    && relative.length > 0
    && !relative.includes("\\")
    && !UNPAIRED_SURROGATE.test(relative)
    && !path.posix.isAbsolute(relative)
    && path.posix.normalize(relative) === relative
    && !relative.split("/").includes("..");
}

export async function verifyV070Integrity({
  generationRoot,
  generation,
  manifest,
  readFile,
}) {
  if (
    manifest?.v !== 1
    || manifest.algorithm !== "sha256"
    || manifest.generation !== generation
    || !manifest.files
    || typeof manifest.files !== "object"
    || Array.isArray(manifest.files)
  ) {
    throw lodestarError(
      "legacy_integrity",
      "The v0.7 integrity manifest has an invalid header.",
      { identifiers: { generation } },
    );
  }
  const expectedPaths = Object.keys(manifest.files).sort();
  if (expectedPaths.length > MAX_FILES) {
    throw lodestarError(
      "resource_limit",
      "The v0.7 integrity manifest exceeds the file-count limit.",
      { identifiers: { count: expectedPaths.length, maximum: MAX_FILES } },
    );
  }
  const actualPaths = (await listGenerationFiles(generationRoot)).sort();
  if (canonicalStringify(expectedPaths) !== canonicalStringify(actualPaths)) {
    throw lodestarError(
      "legacy_integrity",
      "The v0.7 generation file set does not match its manifest.",
      { identifiers: { generation } },
    );
  }
  for (const relative of expectedPaths) {
    const expected = manifest.files[relative];
    if (
      !safeManifestPath(relative)
      || !expected
      || !Number.isSafeInteger(expected.bytes)
      || expected.bytes < 0
      || !SHA256.test(expected.sha256 ?? "")
    ) {
      throw lodestarError(
        "legacy_integrity",
        "The v0.7 integrity manifest contains an invalid entry.",
        { identifiers: { generation, path: relative } },
      );
    }
    const buffer = await readFile(relative);
    if (buffer.length !== expected.bytes || digest(buffer) !== expected.sha256) {
      throw lodestarError(
        "legacy_integrity",
        "A v0.7 generation file failed checksum verification.",
        { identifiers: { generation, path: relative } },
      );
    }
  }
}
