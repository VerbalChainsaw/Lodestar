import { Buffer } from "node:buffer";

import { LodestarError } from "./errors.mjs";

export const STORE_LIMITS_V1 = Object.freeze({
  // The deterministic release benchmark exercises this exact project scale.
  // Raise it only with matching boundary and performance evidence.
  maxProjects: 500,
  maxRecords: 250_000,
  maxStoreBytes: 512 * 1024 * 1024,
  maxCatalogBytes: 32 * 1024 * 1024,
  maxShardBytes: 64 * 1024 * 1024,
  maxRecordBytes: 128 * 1024,
  maxStringBytes: 32 * 1024,
  maxDepth: 12,
  maxNodes: 20_000,
  maxArrayItems: 512,
  maxObjectKeys: 512,
  maxLinks: 128,
  maxLocators: 64,
  maxScopes: 8,
  maxRoots: 16,
  maxProjectAliases: 32,
  maxSearchTerms: 1_000_000,
  maxSearchPostings: 5_000_000,
  maxIndexBytes: 256 * 1024 * 1024,
});

function limitError(resource, actual, maximum, detail = {}) {
  throw new LodestarError(
    "resource-limit-exceeded",
    `Lodestar ${resource} exceeds its supported limit`,
    {
      detail: {
        resource,
        actual,
        maximum,
        ...detail,
      },
    },
  );
}

function serializedBytes(value, resource, maximum) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new LodestarError(
      "invalid-json-value",
      `Lodestar ${resource} is not JSON serializable`,
      { cause: error, detail: { resource } },
    );
  }
  if (encoded === undefined) {
    throw new LodestarError(
      "invalid-json-value",
      `Lodestar ${resource} is not JSON serializable`,
      { detail: { resource } },
    );
  }
  const bytes = Buffer.byteLength(encoded);
  if (bytes > maximum) limitError(resource, bytes, maximum);
  return bytes;
}

function inspectShape(value, {
  resource,
  limits,
  depth = 0,
  state = { nodes: 0 },
} = {}) {
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    limitError(`${resource}.nodes`, state.nodes, limits.maxNodes);
  }
  if (depth > limits.maxDepth) {
    limitError(`${resource}.depth`, depth, limits.maxDepth);
  }
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value);
    if (bytes > limits.maxStringBytes) {
      limitError(`${resource}.string-bytes`, bytes, limits.maxStringBytes);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayItems) {
      limitError(`${resource}.array-items`, value.length, limits.maxArrayItems);
    }
    for (const item of value) {
      inspectShape(item, {
        resource,
        limits,
        depth: depth + 1,
        state,
      });
    }
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > limits.maxObjectKeys) {
    limitError(`${resource}.object-keys`, keys.length, limits.maxObjectKeys);
  }
  for (const key of keys) {
    inspectShape(key, { resource, limits, depth: depth + 1, state });
    inspectShape(value[key], {
      resource,
      limits,
      depth: depth + 1,
      state,
    });
  }
}

export function assertRecordLimits(record, limits = STORE_LIMITS_V1) {
  const id = typeof record?.id === "string" ? record.id : null;
  inspectShape(record, { resource: "record", limits });
  serializedBytes(record, "record-bytes", limits.maxRecordBytes);
  for (const [field, maximum] of [
    ["links", limits.maxLinks],
    ["locators", limits.maxLocators],
    ["scope", limits.maxScopes],
  ]) {
    if (Array.isArray(record?.[field]) && record[field].length > maximum) {
      limitError(`record.${field}`, record[field].length, maximum, { id });
    }
  }
  return record;
}

export function assertCatalogLimits(catalog, limits = STORE_LIMITS_V1) {
  if (
    Array.isArray(catalog?.projects)
    && catalog.projects.length > limits.maxProjects
  ) {
    limitError(
      "catalog.projects",
      catalog.projects.length,
      limits.maxProjects,
    );
  }
  inspectShape(catalog, { resource: "catalog", limits });
  serializedBytes(catalog, "catalog-bytes", limits.maxCatalogBytes);
  for (const project of catalog?.projects ?? []) {
    if (
      Array.isArray(project.roots)
      && project.roots.length > limits.maxRoots
    ) {
      limitError("project.roots", project.roots.length, limits.maxRoots, {
        project: project.id ?? null,
      });
    }
    if (
      Array.isArray(project.aliases)
      && project.aliases.length > limits.maxProjectAliases
    ) {
      limitError(
        "project.aliases",
        project.aliases.length,
        limits.maxProjectAliases,
        { project: project.id ?? null },
      );
    }
  }
  return catalog;
}

export function assertStoreLimits({
  catalog,
  globalRecords = [],
  projectRecords = {},
  limits = STORE_LIMITS_V1,
} = {}) {
  assertCatalogLimits(catalog, limits);
  const shards = new Map([["global", globalRecords]]);
  for (const [project, records] of Object.entries(projectRecords)) {
    shards.set(project, records);
  }
  let records = 0;
  let bytes = 0;
  for (const [shard, values] of shards) {
    let shardBytes = 0;
    for (const record of values) {
      assertRecordLimits(record, limits);
      const recordBytes = Buffer.byteLength(JSON.stringify(record));
      records += 1;
      bytes += recordBytes;
      shardBytes += recordBytes;
      if (records > limits.maxRecords) {
        limitError("store.records", records, limits.maxRecords);
      }
      if (bytes > limits.maxStoreBytes) {
        limitError("store.bytes", bytes, limits.maxStoreBytes);
      }
      if (shardBytes > limits.maxShardBytes) {
        limitError("store.shard-bytes", shardBytes, limits.maxShardBytes, {
          shard,
        });
      }
    }
  }
  return { projects: catalog.projects.length, records, bytes };
}

export function assertGraphLimits({
  catalog,
  records = [],
  limits = STORE_LIMITS_V1,
} = {}) {
  assertCatalogLimits(catalog, limits);
  if (records.length > limits.maxRecords) {
    limitError("store.records", records.length, limits.maxRecords);
  }
  let bytes = 0;
  for (const record of records) {
    assertRecordLimits(record, limits);
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (bytes > limits.maxStoreBytes) {
      limitError("store.bytes", bytes, limits.maxStoreBytes);
    }
  }
  return { projects: catalog.projects.length, records: records.length, bytes };
}
