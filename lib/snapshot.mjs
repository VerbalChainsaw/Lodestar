import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { canonicalStringify } from "./canonical-json.mjs";
import { readFileLimited } from "./bounded-io.mjs";
import {
  durableBarrier,
  syncDirectoryAfterCommit,
} from "./durable-fs.mjs";
import { inspectGeneration } from "./doctor.mjs";
import { LodestarError, wrapError } from "./errors.mjs";
import { createIntegrityManifest } from "./integrity.mjs";
import { readCurrentGeneration } from "./generation.mjs";
import {
  assertPhysicallySeparatePaths,
  pathEntryExists,
  publishDirectoryNoReplace,
} from "./safe-path.mjs";
import { statePaths } from "./store-layout.mjs";
import { withWriteLock } from "./write-lock.mjs";

const SNAPSHOT_MANIFEST = "snapshot.json";
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const MAX_AUDIT_CHAIN_FILES = 1_024;
const MAX_SNAPSHOT_DIRECTORIES = 20_000;
const MAX_SNAPSHOT_DEPTH = 128;
const MAX_SNAPSHOT_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_FILE_BYTES = 64 * 1024 * 1024;

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

async function exists(target, fsApi) {
  return pathEntryExists(target, { fsApi });
}

async function listFiles(root, fsApi) {
  const files = [];
  let bytes = 0;
  let directories = 0;
  async function walk(directory, depth = 0) {
    directories += 1;
    if (
      directories > MAX_SNAPSHOT_DIRECTORIES
      || depth > MAX_SNAPSHOT_DEPTH
    ) {
      throw new LodestarError(
        "snapshot-resource-limit-exceeded",
        "Snapshot exceeds its directory-count or depth budget",
        {
          detail: {
            directories,
            depth,
            max_directories: MAX_SNAPSHOT_DIRECTORIES,
            max_depth: MAX_SNAPSHOT_DEPTH,
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
        "snapshot-read-failed",
        `Unable to enumerate snapshot source ${directory}`,
        { path: directory },
      );
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new LodestarError(
          "snapshot-symlink-refused",
          "Snapshots do not copy symbolic links",
          { detail: { path: target } },
        );
      }
      if (entry.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new LodestarError(
          "snapshot-file-type-unsupported",
          "Snapshot source contains an unsupported filesystem entry",
          { detail: { path: target } },
        );
      }
      const info = await operation(fsApi, "stat")(target);
      bytes += info.size;
      files.push(target);
      if (files.length > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
        throw new LodestarError(
          "snapshot-resource-limit-exceeded",
          "Snapshot exceeds its file-count or byte budget",
          {
            detail: {
              files: files.length,
              bytes,
              max_files: MAX_SNAPSHOT_FILES,
              max_bytes: MAX_SNAPSHOT_BYTES,
            },
          },
        );
      }
    }
  }
  await walk(root);
  return { files, bytes };
}

async function copyTree(source, destination, fsApi) {
  const { files } = await listFiles(source, fsApi);
  await operation(fsApi, "mkdir")(destination, { recursive: true });
  for (const sourceFile of files) {
    const relative = path.relative(source, sourceFile);
    const destinationFile = path.join(destination, relative);
    await operation(fsApi, "mkdir")(path.dirname(destinationFile), {
      recursive: true,
    });
    try {
      await operation(fsApi, "copyFile")(sourceFile, destinationFile);
    } catch (error) {
      throw wrapError(
        error,
        "snapshot-copy-failed",
        `Unable to copy snapshot file ${relative}`,
        { source: sourceFile, destination: destinationFile },
      );
    }
  }
}

function auditEvents(text, file) {
  return text.split(/\r?\n/).filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new LodestarError(
          "snapshot-audit-invalid",
          "Snapshot audit chain contains malformed JSON",
          { cause: error, detail: { file, line: index + 1 } },
        );
      }
    });
}

function checkpointName(event, file) {
  if (event?.op !== "audit-rotate") return null;
  const name = event.previous_file;
  if (
    typeof name !== "string"
    || path.basename(name) !== name
    || !/^events\..+\.jsonl$/.test(name)
    || !Number.isSafeInteger(event.previous_events)
    || event.previous_events < 0
    || !Number.isSafeInteger(event.previous_bytes)
    || event.previous_bytes < 0
    || !/^[a-f0-9]{64}$/.test(event.previous_sha256 ?? "")
  ) {
    throw new LodestarError(
      "snapshot-audit-checkpoint-invalid",
      "Snapshot audit rotation checkpoint is invalid",
      { detail: { file, previous_file: name ?? null } },
    );
  }
  return name;
}

async function collectAuditChain(root, fsApi) {
  const queue = ["events.jsonl"];
  const seen = new Set();
  const files = [];
  let bytes = 0;
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(root, name);
    let text;
    try {
      const info = await operation(fsApi, "lstat")(file);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new LodestarError(
          "snapshot-audit-file-invalid",
          "Snapshot audit chain contains a non-regular file",
          { detail: { file } },
        );
      }
      text = await readFileLimited(file, {
        maximum: MAX_AUDIT_FILE_BYTES,
        encoding: "utf8",
        resource: "snapshot-audit-file-bytes",
        fsApi,
      });
    } catch (error) {
      if (name === "events.jsonl" && error.code === "ENOENT") return [];
      if (error instanceof LodestarError) throw error;
      throw wrapError(
        error,
        "snapshot-audit-chain-missing",
        `Snapshot audit checkpoint references missing file ${name}`,
        { file },
      );
    }
    const events = auditEvents(text, name);
    bytes += Buffer.byteLength(text);
    files.push({ name, file, text, events });
    if (
      files.length > MAX_AUDIT_CHAIN_FILES
      || bytes > MAX_SNAPSHOT_BYTES
    ) {
      throw new LodestarError(
        "snapshot-audit-resource-limit-exceeded",
        "Snapshot audit chain exceeds its file-count or byte budget",
        {
          detail: {
            files: files.length,
            bytes,
            max_files: MAX_AUDIT_CHAIN_FILES,
            max_bytes: MAX_SNAPSHOT_BYTES,
          },
        },
      );
    }
    for (const event of events) {
      const previous = checkpointName(event, name);
      if (!previous) continue;
      const previousFile = path.join(root, previous);
      let previousText;
      try {
        previousText = await readFileLimited(
          previousFile,
          {
            maximum: MAX_AUDIT_FILE_BYTES,
            encoding: "utf8",
            resource: "snapshot-audit-file-bytes",
            fsApi,
          },
        );
      } catch (error) {
        throw wrapError(
          error,
          "snapshot-audit-chain-missing",
          `Snapshot audit checkpoint references missing file ${previous}`,
          { file: previousFile },
        );
      }
      const previousEvents = auditEvents(previousText, previous);
      const digest = createHash("sha256").update(previousText).digest("hex");
      if (
        Buffer.byteLength(previousText) !== event.previous_bytes
        || previousEvents.length !== event.previous_events
        || digest !== event.previous_sha256
      ) {
        throw new LodestarError(
          "snapshot-audit-checkpoint-mismatch",
          "Snapshot audit checkpoint does not match its referenced file",
          { detail: { file: name, previous_file: previous } },
        );
      }
      queue.push(previous);
    }
  }
  return files;
}

async function copyAuditChain(source, destination, fsApi) {
  const chain = await collectAuditChain(source, fsApi);
  for (const item of chain) {
    await operation(fsApi, "copyFile")(
      item.file,
      path.join(destination, item.name),
    );
  }
  return chain;
}

async function writeSnapshotManifest({
  root,
  generation,
  createdAt,
  fsApi,
}) {
  const listed = await listFiles(root, fsApi);
  const integrity = await createIntegrityManifest({
    root,
    generation,
    files: listed.files.filter((file) =>
      path.basename(file) !== SNAPSHOT_MANIFEST
    ),
    fsApi,
  });
  const manifest = {
    v: 1,
    kind: "lodestar-snapshot",
    created_at: createdAt,
    generation,
    files: integrity.files,
  };
  await operation(fsApi, "writeFile")(
    path.join(root, SNAPSHOT_MANIFEST),
    `${canonicalStringify(manifest)}\n`,
    "utf8",
  );
  return manifest;
}

async function cleanup(target, fsApi) {
  try {
    await operation(fsApi, "rm")(target, {
      recursive: true,
      force: true,
    });
    return null;
  } catch (error) {
    return error;
  }
}

function snapshotFailure(error, cleanupError, code, message, detail) {
  return new LodestarError(code, message, {
    cause: cleanupError
      ? new AggregateError([error, cleanupError])
      : error,
    detail: {
      ...detail,
      cause_code: error.code ?? null,
      cleanup_code: cleanupError?.code ?? null,
    },
  });
}

export async function verifySnapshot({
  snapshot,
  fsApi = fs,
} = {}) {
  const root = path.resolve(snapshot);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFileLimited(
        path.join(root, SNAPSHOT_MANIFEST),
        {
          maximum: MAX_SNAPSHOT_MANIFEST_BYTES,
          encoding: "utf8",
          resource: "snapshot-manifest-bytes",
          fsApi,
        },
      ),
    );
  } catch (error) {
    throw wrapError(
      error,
      error instanceof SyntaxError
        ? "snapshot-manifest-invalid"
        : "snapshot-manifest-read-failed",
      "Unable to read the Lodestar snapshot manifest",
      { snapshot: root },
    );
  }
  if (
    manifest?.v !== 1
    || manifest.kind !== "lodestar-snapshot"
    || typeof manifest.created_at !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.generation ?? "")
    || !manifest.files
    || Array.isArray(manifest.files)
    || typeof manifest.files !== "object"
  ) {
    throw new LodestarError(
      "snapshot-manifest-invalid",
      "Snapshot manifest has an unsupported shape",
      { detail: { snapshot: root } },
    );
  }
  const expectedPaths = Object.keys(manifest.files).sort();
  const actual = await listFiles(root, fsApi);
  const actualPaths = actual.files
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .filter((relative) => relative !== SNAPSHOT_MANIFEST)
    .sort();
  if (canonicalStringify(actualPaths) !== canonicalStringify(expectedPaths)) {
    throw new LodestarError(
      "snapshot-file-set-mismatch",
      "Snapshot files do not match its manifest",
      { detail: { expected: expectedPaths, actual: actualPaths } },
    );
  }
  const recomputed = await createIntegrityManifest({
    root,
    generation: manifest.generation,
    files: actual.files.filter((file) =>
      path.basename(file) !== SNAPSHOT_MANIFEST
    ),
    fsApi,
  });
  if (
    canonicalStringify(recomputed.files)
    !== canonicalStringify(manifest.files)
  ) {
    throw new LodestarError(
      "snapshot-checksum-mismatch",
      "Snapshot content does not match its manifest",
      { detail: { snapshot: root } },
    );
  }
  const pointer = JSON.parse(
    await readFileLimited(statePaths(root).current, {
      maximum: 64 * 1024,
      encoding: "utf8",
      resource: "snapshot-current-pointer-bytes",
      fsApi,
    }),
  );
  if (pointer?.generation !== manifest.generation) {
    throw new LodestarError(
      "snapshot-generation-mismatch",
      "Snapshot pointer and manifest identify different generations",
      {
        detail: {
          pointer: pointer?.generation ?? null,
          manifest: manifest.generation,
        },
      },
    );
  }
  await collectAuditChain(root, fsApi);
  await inspectGeneration(root, manifest.generation, fsApi, { deep: true });
  return {
    ok: true,
    snapshot: root,
    generation: manifest.generation,
    created_at: manifest.created_at,
    files: expectedPaths.length,
    bytes: actual.bytes,
  };
}

export async function createSnapshot({
  home,
  destination,
  now = () => new Date(),
  fsApi = fs,
} = {}) {
  if (!home || !destination) {
    throw new LodestarError(
      "snapshot-argument-required",
      "Snapshot source home and destination are required",
    );
  }
  const source = path.resolve(home);
  const target = path.resolve(destination);
  if (await exists(target, fsApi)) {
    throw new LodestarError(
      "snapshot-destination-exists",
      "Snapshot destination must not already exist",
      { detail: { destination: target } },
    );
  }
  await assertPhysicallySeparatePaths({
    source,
    destination: target,
    fsApi,
    code: "snapshot-path-overlap",
    message: "Snapshot source and destination must not contain one another",
  });
  const stage = path.join(
    path.dirname(target),
    `.${path.basename(target)}.snapshot-${randomUUID()}`,
  );
  let published = false;
  try {
    const generation = await withWriteLock({ home: source, fsApi }, async () => {
      const selected = await readCurrentGeneration(source, { fsApi });
      await inspectGeneration(source, selected.id, fsApi, { deep: true });
      await operation(fsApi, "mkdir")(stage);
      await copyTree(
        selected.root,
        path.join(stage, "generations", selected.id),
        fsApi,
      );
      await operation(fsApi, "copyFile")(
        statePaths(source).current,
        statePaths(stage).current,
      );
      await copyAuditChain(source, stage, fsApi);
      return selected;
    });
    await collectAuditChain(stage, fsApi);
    await writeSnapshotManifest({
      root: stage,
      generation: generation.id,
      createdAt: now().toISOString(),
      fsApi,
    });
    await verifySnapshot({ snapshot: stage, fsApi });
    const stagedFiles = await listFiles(stage, fsApi);
    await durableBarrier({
      files: stagedFiles.files,
      directories: [
        stage,
        path.join(stage, "generations"),
        path.join(stage, "generations", generation.id),
      ],
      fsApi,
    });
    await publishDirectoryNoReplace({
      stage,
      destination: target,
      terminalEntries: [SNAPSHOT_MANIFEST],
      fsApi,
    });
    published = true;
    const parentSync = await syncDirectoryAfterCommit(path.dirname(target), {
      fsApi,
    });
    return {
      ...await verifySnapshot({ snapshot: target, fsApi }),
      durability: {
        destination_parent_sync: parentSync,
      },
    };
  } catch (error) {
    const cleanupError = await cleanup(published ? target : stage, fsApi);
    throw snapshotFailure(
      error,
      cleanupError,
      "snapshot-create-failed",
      "Unable to create a verified Lodestar snapshot",
      { home: source, destination: target },
    );
  }
}

export async function restoreSnapshot({
  snapshot,
  destination,
  dryRun = false,
  fsApi = fs,
} = {}) {
  if (!snapshot || !destination) {
    throw new LodestarError(
      "snapshot-argument-required",
      "Snapshot source and restore destination are required",
    );
  }
  const source = path.resolve(snapshot);
  const target = path.resolve(destination);
  const verified = await verifySnapshot({ snapshot: source, fsApi });
  if (await exists(target, fsApi)) {
    throw new LodestarError(
      "restore-destination-exists",
      "Restore requires a new destination so existing state is never overwritten",
      { detail: { destination: target } },
    );
  }
  await assertPhysicallySeparatePaths({
    source,
    destination: target,
    fsApi,
    code: "snapshot-path-overlap",
    message: "Snapshot source and destination must not contain one another",
  });
  if (dryRun) {
    return {
      ...verified,
      restored: false,
      dry_run: true,
      destination: target,
    };
  }
  const stage = path.join(
    path.dirname(target),
    `.${path.basename(target)}.restore-${randomUUID()}`,
  );
  let published = false;
  try {
    await operation(fsApi, "mkdir")(stage);
    await copyTree(
      path.join(source, "generations"),
      path.join(stage, "generations"),
      fsApi,
    );
    await operation(fsApi, "copyFile")(
      statePaths(source).current,
      statePaths(stage).current,
    );
    await copyAuditChain(source, stage, fsApi);
    await operation(fsApi, "mkdir")(statePaths(stage).backups);
    await operation(fsApi, "mkdir")(statePaths(stage).snapshots);
    await readCurrentGeneration(stage, { fsApi });
    await inspectGeneration(stage, verified.generation, fsApi, { deep: true });
    const stagedFiles = await listFiles(stage, fsApi);
    await durableBarrier({
      files: stagedFiles.files,
      directories: [
        stage,
        statePaths(stage).generations,
        path.join(statePaths(stage).generations, verified.generation),
      ],
      fsApi,
    });
    await publishDirectoryNoReplace({
      stage,
      destination: target,
      terminalEntries: ["current.json"],
      fsApi,
    });
    published = true;
    const parentSync = await syncDirectoryAfterCommit(path.dirname(target), {
      fsApi,
    });
    return {
      ok: true,
      restored: true,
      dry_run: false,
      destination: target,
      generation: verified.generation,
      durability: {
        destination_parent_sync: parentSync,
      },
    };
  } catch (error) {
    const cleanupError = await cleanup(published ? target : stage, fsApi);
    throw snapshotFailure(
      error,
      cleanupError,
      "snapshot-restore-failed",
      "Unable to restore the Lodestar snapshot",
      { snapshot: source, destination: target },
    );
  }
}
