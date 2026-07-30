import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "./generation.mjs";
import { buildIndexes } from "./indexes.mjs";
import { isWslRuntime, nativeProjectPath } from "./native-path.mjs";
import { generationPaths, statePaths } from "./store-layout.mjs";

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
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sourceFromPackage(packageRoot) {
  const [catalogText, schemaText, globalText] = await Promise.all([
    readFile(path.join(packageRoot, "templates", "catalog.json"), "utf8"),
    readFile(path.join(packageRoot, "schema", "store.json"), "utf8"),
    readFile(
      path.join(packageRoot, "templates", "records", "global.jsonl"),
      "utf8",
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

async function cleanupInitialization(transaction, generation) {
  await unlink(statePaths(transaction).events).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (generation) {
    const paths = generationPaths(transaction, generation.id);
    for (const file of [
      paths.catalog,
      paths.schema,
      paths.globalRecords,
      path.join(paths.indexes, "routes.json"),
      path.join(paths.indexes, "locator-health.json"),
      path.join(paths.indexes, "search", "global.json"),
    ]) {
      await unlink(file).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    for (const directory of [
      paths.projectRecords,
      path.join(paths.indexes, "search"),
      paths.indexes,
      paths.records,
      path.dirname(paths.schema),
      paths.root,
    ]) {
      await rmdir(directory).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  await unlink(statePaths(transaction).current).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  for (const directory of [
    statePaths(transaction).backups,
    statePaths(transaction).generations,
    transaction,
  ]) {
    await rmdir(directory).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
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
    await readCurrentGeneration(destination);
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
  await mkdir(parent, { recursive: true });
  await mkdir(statePaths(transaction).generations, { recursive: true });
  await mkdir(statePaths(transaction).backups);

  try {
    const initialSource = source ?? await sourceFromPackage(packageRoot);
    generation = await buildGeneration({
      home: transaction,
      source: initialSource,
      indexBuilder: (id) => buildIndexes({
        generation: id,
        catalog: initialSource.catalog,
        globalRecords: initialSource.globalRecords,
        projectRecords: initialSource.projectRecords,
      }),
    });
    await promoteGeneration({ home: transaction, generation });
    await readCurrentGeneration(transaction);
    if (event) {
      await writeFile(
        statePaths(transaction).events,
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
    }
    await rename(transaction, destination);
    return { home: destination, created: true, generation: generation.id };
  } catch (error) {
    await cleanupInitialization(transaction, generation);
    throw error;
  }
}
