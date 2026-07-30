import { randomUUID } from "node:crypto";
import {
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "./generation.mjs";
import { verifyIntegrityManifest } from "./integrity.mjs";
import {
  syncDirectoryAfterCommit,
  syncFile,
} from "./durable-fs.mjs";
import { readFileLimited } from "./bounded-io.mjs";
import { LodestarError } from "./errors.mjs";
import { ContextStore } from "./context-store.mjs";
import { buildIndexes } from "./indexes.mjs";
import { isWslRuntime, nativeProjectPath } from "./native-path.mjs";
import {
  pathEntryExists,
  publishDirectoryNoReplace,
} from "./safe-path.mjs";
import { statePaths } from "./store-layout.mjs";
import { validateGraph } from "./validation.mjs";

export function resolveStateHome({
  explicit,
  env = process.env,
  home = os.homedir(),
  cwd = process.cwd(),
  pathApi = path,
  platform,
  release = os.release(),
} = {}) {
  const runtimePlatform = platform
    ?? (pathApi === path.win32 ? "win32" : process.platform);
  const selected = explicit
    || env.LODESTAR_HOME
    || env.AGENT_CONTEXT_HOME
    || pathApi.join(home, ".lodestar");
  if (isWslRuntime({ platform: runtimePlatform, env, release })) {
    return nativeProjectPath(selected, {
      platform: runtimePlatform,
      env,
      release,
      cwd,
      pathApi,
    });
  }
  return pathApi.resolve(cwd, selected);
}

function stateError(message, code) {
  return Object.assign(new Error(message), { code });
}

async function exists(target) {
  return pathEntryExists(target);
}

async function sourceFromPackage(packageRoot) {
  const [catalogText, schemaText, globalText] = await Promise.all([
    readFileLimited(path.join(packageRoot, "templates", "catalog.json"), {
      maximum: 32 * 1024 * 1024,
      encoding: "utf8",
      resource: "template-catalog-bytes",
    }),
    readFileLimited(path.join(packageRoot, "schema", "store.json"), {
      maximum: 1024 * 1024,
      encoding: "utf8",
      resource: "template-schema-bytes",
    }),
    readFileLimited(
      path.join(packageRoot, "templates", "records", "global.jsonl"),
      {
        maximum: 64 * 1024 * 1024,
        encoding: "utf8",
        resource: "template-record-bytes",
      },
    ),
  ]);
  return {
    catalog: JSON.parse(catalogText),
    schema: JSON.parse(schemaText),
    globalRecords: globalText
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line)),
    projectRecords: {},
    indexes: {},
  };
}

async function cleanupInitialization(transaction) {
  try {
    await rm(transaction, { recursive: true, force: true });
    return null;
  } catch (error) {
    return error;
  }
}

export async function initializeStateHome({
  destination,
  packageRoot = path.resolve(import.meta.dirname, ".."),
  source,
  event,
} = {}) {
  if (!destination) {
    throw stateError("A state-home destination is required", "home-required");
  }

  try {
    const current = await readCurrentGeneration(destination);
    await verifyIntegrityManifest({
      root: current.root,
      generation: current.id,
    });
    const existing = await ContextStore.open({ home: destination });
    const existingSource = await existing.sourceSnapshot();
    validateGraph({
      catalog: existingSource.catalog,
      records: [
        ...existingSource.globalRecords,
        ...Object.values(existingSource.projectRecords).flat(),
      ],
    });
    return { home: destination, created: false };
  } catch (error) {
    if (error.code !== "current-generation-missing") throw error;
    if (await exists(destination)) {
      throw stateError(
        `Existing path is not a valid Lodestar home: ${destination}`,
        "invalid-state-home",
      );
    }
  }

  const parent = path.dirname(destination);
  const transaction = path.join(
    parent,
    `.${path.basename(destination)}.init-${randomUUID()}`,
  );
  let generation;

  try {
    await mkdir(parent, { recursive: true });
    await mkdir(statePaths(transaction).generations, { recursive: true });
    await mkdir(statePaths(transaction).backups);
    const initialSource = source ?? await sourceFromPackage(packageRoot);
    generation = await buildGeneration({
      home: transaction,
      source: initialSource,
      indexBuilder: (id, persisted) => buildIndexes({
        generation: id,
        catalog: persisted.catalog,
        globalRecords: persisted.globalRecords,
        projectRecords: persisted.projectRecords,
      }),
    });
    await promoteGeneration({ home: transaction, generation });
    await readCurrentGeneration(transaction);
    if (event) {
      const eventFile = statePaths(transaction).events;
      await writeFile(
        eventFile,
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
      await syncFile(eventFile);
    }
    await publishDirectoryNoReplace({
      stage: transaction,
      destination,
      terminalEntries: ["current.json"],
    });
    const parentSync = await syncDirectoryAfterCommit(parent);
    return {
      home: destination,
      created: true,
      generation: generation.id,
      durability: {
        destination_parent_sync: parentSync,
      },
    };
  } catch (error) {
    const cleanupError = await cleanupInitialization(transaction);
    if (cleanupError) {
      throw new LodestarError(
        "state-init-cleanup-failed",
        "State-home initialization failed and its transaction could not be cleaned up",
        {
          cause: new AggregateError([error, cleanupError]),
          detail: {
            transaction,
            cause_code: error.code ?? null,
            cleanup_code: cleanupError.code ?? null,
          },
        },
      );
    }
    throw error;
  }
}
