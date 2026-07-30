import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { canonicalStringify } from "./canonical-json.mjs";
import { hashFileLimited, readFileLimited } from "./bounded-io.mjs";
import { LodestarError, wrapError } from "./errors.mjs";

export const INTEGRITY_MANIFEST = "integrity.json";
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_FILES = 20_000;
const MAX_MANIFEST_DIRECTORIES = 20_000;
const MAX_MANIFEST_DEPTH = 128;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_PROTECTED_FILE_BYTES = 256 * 1024 * 1024;

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

function confinedRelative(root, file) {
  const relative = path.relative(root, file);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new LodestarError(
      "integrity-path-invalid",
      "Integrity manifests may reference only files inside their root",
      { detail: { root, path: file } },
    );
  }
  return relative.split(path.sep).join("/");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileDigest(file, fsApi) {
  try {
    return await hashFileLimited(file, {
      maximum: MAX_PROTECTED_FILE_BYTES,
      resource: "integrity-file-bytes",
      fsApi,
    });
  } catch (error) {
    throw wrapError(
      error,
      "integrity-file-read-failed",
      `Unable to read integrity-protected file ${file}`,
      { path: file },
    );
  }
}

async function generationFiles(root, fsApi) {
  const relativeFiles = [];
  let directories = 0;
  async function walk(directory, depth = 0) {
    directories += 1;
    if (
      directories > MAX_MANIFEST_DIRECTORIES
      || depth > MAX_MANIFEST_DEPTH
    ) {
      throw new LodestarError(
        "integrity-directory-limit-exceeded",
        "Generation contains too many or too deeply nested directories",
        {
          detail: {
            directories,
            depth,
            max_directories: MAX_MANIFEST_DIRECTORIES,
            max_depth: MAX_MANIFEST_DEPTH,
          },
        },
      );
    }
    let entries;
    try {
      entries = await operation(fsApi, "readdir")(directory, {
        withFileTypes: true,
      });
    } catch (error) {
      throw wrapError(
        error,
        "integrity-file-list-failed",
        `Unable to enumerate integrity-protected directory ${directory}`,
        { path: directory },
      );
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = confinedRelative(root, absolute);
      if (entry.isSymbolicLink()) {
        throw new LodestarError(
          "integrity-file-type-invalid",
          "Generation integrity does not permit symbolic links",
          { detail: { path: relative } },
        );
      }
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new LodestarError(
          "integrity-file-type-invalid",
          "Generation integrity encountered an unsupported filesystem entry",
          { detail: { path: relative } },
        );
      }
      if (relative !== INTEGRITY_MANIFEST) relativeFiles.push(relative);
      if (relativeFiles.length > MAX_MANIFEST_FILES) {
        throw new LodestarError(
          "integrity-file-limit-exceeded",
          "Generation contains too many files for integrity verification",
          {
            detail: {
              actual: relativeFiles.length,
              maximum: MAX_MANIFEST_FILES,
            },
          },
        );
      }
    }
  }
  await walk(root);
  return relativeFiles.sort((a, b) => a.localeCompare(b));
}

export async function createIntegrityManifest({
  root,
  generation,
  files,
  fsApi = fs,
} = {}) {
  const unique = [...new Set(files)]
    .map((file) => ({
      absolute: file,
      relative: confinedRelative(root, file),
    }))
    .filter(({ relative }) => relative !== INTEGRITY_MANIFEST)
    .sort((a, b) => a.relative.localeCompare(b.relative));
  if (unique.length > MAX_MANIFEST_FILES) {
    throw new LodestarError(
      "integrity-file-limit-exceeded",
      "Generation contains too many files for an integrity manifest",
      {
        detail: {
          actual: unique.length,
          maximum: MAX_MANIFEST_FILES,
        },
      },
    );
  }
  const entryPairs = [];
  for (const { absolute, relative } of unique) {
    entryPairs.push([relative, await fileDigest(absolute, fsApi)]);
  }
  return {
    v: 1,
    algorithm: "sha256",
    generation,
    files: Object.fromEntries(entryPairs),
  };
}

export async function writeIntegrityManifest({
  root,
  generation,
  files,
  fsApi = fs,
} = {}) {
  const manifest = await createIntegrityManifest({
    root,
    generation,
    files,
    fsApi,
  });
  const destination = path.join(root, INTEGRITY_MANIFEST);
  try {
    await operation(fsApi, "writeFile")(
      destination,
      `${canonicalStringify(manifest)}\n`,
      "utf8",
    );
  } catch (error) {
    throw wrapError(
      error,
      "integrity-manifest-write-failed",
      `Unable to write integrity manifest ${destination}`,
      { path: destination },
    );
  }
  return { manifest, path: destination };
}

function validateManifest(manifest, expectedGeneration) {
  if (
    !manifest
    || manifest.v !== 1
    || manifest.algorithm !== "sha256"
    || manifest.generation !== expectedGeneration
    || !manifest.files
    || Array.isArray(manifest.files)
    || typeof manifest.files !== "object"
  ) {
    throw new LodestarError(
      "integrity-manifest-invalid",
      "Generation integrity manifest is invalid",
      { detail: { expected_generation: expectedGeneration } },
    );
  }
  const entries = Object.entries(manifest.files);
  if (entries.length > MAX_MANIFEST_FILES) {
    throw new LodestarError(
      "integrity-file-limit-exceeded",
      "Generation integrity manifest contains too many files",
      { detail: { actual: entries.length, maximum: MAX_MANIFEST_FILES } },
    );
  }
  for (const [relative, digest] of entries) {
    const slashNormalized = relative.replaceAll("\\", "/");
    if (
      !relative
      || relative === INTEGRITY_MANIFEST
      || relative !== slashNormalized
      || path.isAbsolute(relative)
      || relative.split(/[\\/]/).includes("..")
      || path.posix.normalize(relative) !== relative
      || !digest
      || !Number.isSafeInteger(digest.bytes)
      || digest.bytes < 0
      || !SHA256.test(digest.sha256)
    ) {
      throw new LodestarError(
        "integrity-manifest-invalid",
        "Generation integrity manifest contains an invalid entry",
        { detail: { path: relative } },
      );
    }
  }
  return manifest;
}

export async function verifyIntegrityManifest({
  root,
  generation,
  requireManifest = false,
  fsApi = fs,
} = {}) {
  const manifestPath = path.join(root, INTEGRITY_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFileLimited(manifestPath, {
        maximum: MAX_MANIFEST_BYTES,
        encoding: "utf8",
        resource: "integrity-manifest-bytes",
        fsApi,
      }),
    );
  } catch (error) {
    if (error.code === "ENOENT" && !requireManifest) {
      return {
        ok: true,
        sealed: false,
        generation,
        files: 0,
      };
    }
    if (error instanceof SyntaxError) {
      throw new LodestarError(
        "integrity-manifest-invalid",
        "Generation integrity manifest is not valid JSON",
        { cause: error, detail: { path: manifestPath } },
      );
    }
    throw wrapError(
      error,
      error.code === "ENOENT"
        ? "integrity-manifest-missing"
        : "integrity-manifest-read-failed",
      `Unable to read integrity manifest ${manifestPath}`,
      { path: manifestPath },
    );
  }
  validateManifest(manifest, generation);
  const expectedPaths = Object.keys(manifest.files).sort((a, b) =>
    a.localeCompare(b)
  );
  const actualPaths = await generationFiles(root, fsApi);
  if (
    canonicalStringify(expectedPaths)
    !== canonicalStringify(actualPaths)
  ) {
    throw new LodestarError(
      "integrity-file-set-mismatch",
      "Generation files do not exactly match its integrity manifest",
      {
        detail: {
          expected: expectedPaths,
          actual: actualPaths,
        },
      },
    );
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const absolute = path.resolve(root, relative);
    confinedRelative(root, absolute);
    const actual = await fileDigest(absolute, fsApi);
    if (
      actual.bytes !== expected.bytes
      || actual.sha256 !== expected.sha256
    ) {
      throw new LodestarError(
        "integrity-checksum-mismatch",
        `Integrity verification failed for ${relative}`,
        {
          detail: {
            path: relative,
            expected,
            actual,
          },
        },
      );
    }
  }
  return {
    ok: true,
    sealed: true,
    generation,
    files: Object.keys(manifest.files).length,
  };
}
