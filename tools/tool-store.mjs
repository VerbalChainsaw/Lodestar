import path from "node:path";

import { atomicWriteFile } from "../lib/atomic-file.mjs";
import { readFileLimited } from "../lib/bounded-io.mjs";
import { LodestarError, wrapError } from "../lib/errors.mjs";
import { canonicalStringify } from "../lib/canonical-json.mjs";
import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "../lib/generation.mjs";
import { buildIndexes } from "../lib/indexes.mjs";
import { probeLocatorHealth } from "../lib/locator-health.mjs";
import { projectShardPath } from "../lib/store-layout.mjs";
import { STORE_LIMITS_V1 } from "../lib/resource-limits.mjs";
import { withWriteLock } from "../lib/write-lock.mjs";

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export async function readStoreSource(home) {
  const generation = await readCurrentGeneration(home);
  const catalog = JSON.parse(
    await readFileLimited(path.join(generation.root, "catalog.json"), {
      maximum: STORE_LIMITS_V1.maxCatalogBytes,
      encoding: "utf8",
      resource: "catalog-bytes",
    }),
  );
  const schema = JSON.parse(
    await readFileLimited(path.join(generation.root, "schema", "store.json"), {
      maximum: 1024 * 1024,
      encoding: "utf8",
      resource: "schema-bytes",
    }),
  );
  const globalRecords = parseJsonLines(
    await readFileLimited(
      path.join(generation.root, "records", "global.jsonl"),
      {
        maximum: STORE_LIMITS_V1.maxShardBytes,
        encoding: "utf8",
        resource: "store-shard-bytes",
      },
    ),
  );
  const locatorHealth = JSON.parse(
    await readFileLimited(
      path.join(generation.root, "indexes", "locator-health.json"),
      {
        maximum: STORE_LIMITS_V1.maxIndexBytes,
        encoding: "utf8",
        resource: "generated-index-bytes",
      },
    ),
  );
  const projectRecords = {};
  for (const project of catalog.projects) {
    projectRecords[project.id] = parseJsonLines(
      await readFileLimited(
        path.join(generation.root, projectShardPath(project.id)),
        {
          maximum: STORE_LIMITS_V1.maxShardBytes,
          encoding: "utf8",
          resource: "store-shard-bytes",
        },
      ).catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      }),
    );
  }
  return {
    generation,
    catalog,
    schema,
    globalRecords,
    projectRecords,
    locatorHealth,
  };
}

function preservingLocatorProbe(source) {
  const previous = new Map();
  const records = [
    ...source.globalRecords,
    ...Object.values(source.projectRecords).flat(),
  ];
  for (const record of records) {
    for (const [index, locator] of (record.locators ?? []).entries()) {
      const key = `${record.id}#${index}`;
      previous.set(key, {
        locator: canonicalStringify(locator),
        health: source.locatorHealth?.locators?.[key] ?? {
          status: "unchecked",
        },
      });
    }
  }
  return async ({ record, locator }) => {
    const index = (record.locators ?? []).indexOf(locator);
    const prior = previous.get(`${record.id}#${index}`);
    return prior?.locator === canonicalStringify(locator)
      ? prior.health
      : probeLocatorHealth({
        project: source.catalog.projects.find(({ id }) =>
          record.scope.includes(`project:${id}`)) ?? null,
        record,
        locator,
      });
  };
}

async function writeAuditEvent(file, line) {
  const maximum = 64 * 1024 * 1024;
  let existing = "";
  try {
    existing = await readFileLimited(file, {
      maximum,
      encoding: "utf8",
      resource: "audit-log-bytes",
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const prefix = existing.length === 0 || existing.endsWith("\n")
    ? existing
    : `${existing}\n`;
  if (Buffer.byteLength(prefix) + Buffer.byteLength(line) > maximum) {
    throw new LodestarError(
      "audit-maintenance-required",
      "Audit log reached its write-side safety limit; run agentctx maintain --apply",
      { detail: { path: file, maximum } },
    );
  }
  return atomicWriteFile(file, `${prefix}${line}`);
}

export async function updateStore({
  home,
  op,
  detail = {},
  transform,
  probeLocator,
  now = () => new Date(),
  appendEvent = null,
} = {}) {
  return withWriteLock({ home }, async () => {
    const previousGeneration = await readCurrentGeneration(home);
    const source = await readStoreSource(home);
    const preserveLocatorHealth = preservingLocatorProbe(source);
    const result = await transform(source);
    const generation = await buildGeneration({
      home,
      source,
      indexBuilder: (id, persisted) => buildIndexes({
        generation: id,
        catalog: persisted.catalog,
        globalRecords: persisted.globalRecords,
        projectRecords: persisted.projectRecords,
        probeLocator: probeLocator ?? preserveLocatorHealth,
      }),
    });
    const pointerPromotion = await promoteGeneration({ home, generation });
    let auditWrite = null;
    try {
      const auditFile = path.join(home, "events.jsonl");
      const line = `${JSON.stringify({
          at: now().toISOString(),
          op,
          generation: generation.id,
          ...(typeof detail === "function" ? detail(result) : detail),
        })}\n`;
      auditWrite = appendEvent
        ? await appendEvent(auditFile, line, "utf8")
        : await writeAuditEvent(auditFile, line);
    } catch (error) {
      try {
        await promoteGeneration({
          home,
          generation: previousGeneration,
        });
      } catch (restoreError) {
        throw new LodestarError(
          "store-audit-rollback-failed",
          "The store changed, its audit event failed, and the prior generation could not be restored",
          {
            cause: new AggregateError([error, restoreError]),
            detail: {
              operation: op,
              attempted_generation: generation.id,
              previous_generation: previousGeneration.id,
              audit_code: error.code ?? null,
              restore_code: restoreError.code ?? null,
            },
          },
        );
      }
      throw wrapError(
        error,
        "store-audit-write-failed",
        "The audit event could not be written; the prior store generation was restored",
        {
          operation: op,
          attempted_generation: generation.id,
          restored_generation: previousGeneration.id,
        },
      );
    }
    return {
      generation: generation.id,
      result,
      durability: {
        generation: generation.durability ?? null,
        pointer: pointerPromotion.durability ?? null,
        audit: auditWrite ?? null,
      },
    };
  });
}
