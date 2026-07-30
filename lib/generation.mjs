import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.mjs";
import { canonicalStringify } from "./canonical-json.mjs";
import {
  generationPaths,
  projectFileStem,
  statePaths,
} from "./store-layout.mjs";
import { ContextError, validateGraph } from "./validation.mjs";

function sortedRecords(records) {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizedSource(source) {
  return {
    catalog: source.catalog,
    schema: source.schema,
    globalRecords: sortedRecords(source.globalRecords ?? []),
    projectRecords: Object.fromEntries(
      Object.entries(source.projectRecords ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([projectId, records]) => [projectId, sortedRecords(records)]),
    ),
  };
}

function generationId(source) {
  return createHash("sha256")
    .update(canonicalStringify(normalizedSource(source)))
    .digest("hex");
}

function jsonLine(records) {
  return records.map((record) => canonicalStringify(record)).join("\n")
    + (records.length > 0 ? "\n" : "");
}

async function pathExists(target, fsApi) {
  try {
    await (fsApi.access ?? fs.access)(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupCreated(files, directories, fsApi) {
  const unlink = fsApi.unlink ?? fs.unlink;
  const rmdir = fsApi.rmdir ?? fs.rmdir;
  for (const file of [...files].reverse()) {
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  for (const directory of [...directories].reverse()) {
    await rmdir(directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function buildGeneration({
  home,
  source,
  indexBuilder,
  fsApi = fs,
} = {}) {
  const normalized = normalizedSource(source);
  validateGraph({
    catalog: normalized.catalog,
    records: [
      ...normalized.globalRecords,
      ...Object.values(normalized.projectRecords).flat(),
    ],
  });
  const id = generationId(normalized);
  const target = generationPaths(home, id);
  if (await pathExists(target.root, fsApi)) return { id, root: target.root };

  const transactionRoot = path.join(
    statePaths(home).generations,
    `.build-${id}-${randomUUID()}`,
  );
  const transaction = {
    root: transactionRoot,
    catalog: path.join(transactionRoot, "catalog.json"),
    schema: path.join(transactionRoot, "schema", "store.json"),
    globalRecords: path.join(transactionRoot, "records", "global.jsonl"),
    projectRecords: path.join(transactionRoot, "records", "projects"),
    indexes: path.join(transactionRoot, "indexes"),
  };
  const createdFiles = [];
  const createdDirectories = [];
  const mkdir = fsApi.mkdir ?? fs.mkdir;
  const writeFile = fsApi.writeFile ?? fs.writeFile;
  const rename = fsApi.rename ?? fs.rename;
  const indexes = indexBuilder
    ? await indexBuilder(id)
    : source.indexes ?? {};

  try {
    for (const directory of [
      statePaths(home).generations,
      transaction.root,
      path.join(transaction.root, "schema"),
      path.join(transaction.root, "records"),
      transaction.projectRecords,
      transaction.indexes,
    ]) {
      await mkdir(directory, { recursive: directory === statePaths(home).generations });
      if (directory !== statePaths(home).generations) {
        createdDirectories.push(directory);
      }
    }
    for (const [file, contents] of [
      [transaction.catalog, `${canonicalStringify(normalized.catalog)}\n`],
      [transaction.schema, `${canonicalStringify(normalized.schema)}\n`],
      [transaction.globalRecords, jsonLine(normalized.globalRecords)],
    ]) {
      await writeFile(file, contents, "utf8");
      createdFiles.push(file);
    }
    for (const [projectId, records] of Object.entries(normalized.projectRecords)) {
      const file = path.join(
        transaction.projectRecords,
        `${projectFileStem(projectId)}.jsonl`,
      );
      await writeFile(file, jsonLine(records), "utf8");
      createdFiles.push(file);
    }
    const knownDirectories = new Set(createdDirectories);
    for (const [relative, value] of Object.entries(indexes)
      .sort(([a], [b]) => a.localeCompare(b))) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new ContextError("invalid-index-path", { path: relative });
      }
      const file = path.join(transaction.indexes, relative);
      const parent = path.dirname(file);
      if (parent !== transaction.indexes) {
        const relativeParent = path.relative(transaction.indexes, parent);
        let directory = transaction.indexes;
        for (const part of relativeParent.split(path.sep)) {
          directory = path.join(directory, part);
          if (knownDirectories.has(directory)) continue;
          await mkdir(directory);
          createdDirectories.push(directory);
          knownDirectories.add(directory);
        }
      }
      await writeFile(
        file,
        `${canonicalStringify({ ...value, generation: id })}\n`,
        "utf8",
      );
      createdFiles.push(file);
    }
    await rename(transaction.root, target.root);
    return { id, root: target.root };
  } catch (error) {
    if (error.code === "EEXIST" && await pathExists(target.root, fsApi)) {
      await cleanupCreated(createdFiles, createdDirectories, fsApi);
      return { id, root: target.root };
    }
    await cleanupCreated(createdFiles, createdDirectories, fsApi);
    throw error;
  }
}

export async function promoteGeneration({
  home,
  generation,
  fsApi = fs,
} = {}) {
  if (!await pathExists(generation.root, fsApi)) {
    throw new ContextError("generation-missing", { generation: generation.id });
  }
  const pointer = statePaths(home).current;
  await atomicWriteFile(
    pointer,
    `${canonicalStringify({ v: 1, generation: generation.id })}\n`,
    { fsApi },
  );
  return { id: generation.id, root: generation.root };
}

export async function readCurrentGeneration(home, { fsApi = fs } = {}) {
  let pointer;
  try {
    pointer = JSON.parse(
      await (fsApi.readFile ?? fs.readFile)(statePaths(home).current, "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ContextError("current-generation-missing", { home });
    }
    if (error instanceof SyntaxError) {
      throw new ContextError("current-generation-invalid", { home });
    }
    throw error;
  }
  if (
    pointer?.v !== 1
    || typeof pointer.generation !== "string"
    || !/^[a-f0-9]{64}$/.test(pointer.generation)
  ) {
    throw new ContextError("current-generation-invalid", { home });
  }
  const generation = generationPaths(home, pointer.generation);
  if (!await pathExists(generation.catalog, fsApi)) {
    throw new ContextError("generation-missing", {
      generation: pointer.generation,
    });
  }
  return { id: pointer.generation, root: generation.root };
}
