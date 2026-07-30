import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import { LodestarError, wrapError } from "../lib/errors.mjs";
import { canonicalStringify } from "../lib/canonical-json.mjs";
import {
  buildGeneration,
  promoteGeneration,
  readCurrentGeneration,
} from "../lib/generation.mjs";
import { buildIndexes } from "../lib/indexes.mjs";
import { projectShardPath } from "../lib/store-layout.mjs";
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
    await readFile(path.join(generation.root, "catalog.json"), "utf8"),
  );
  const schema = JSON.parse(
    await readFile(path.join(generation.root, "schema", "store.json"), "utf8"),
  );
  const globalRecords = parseJsonLines(
    await readFile(
      path.join(generation.root, "records", "global.jsonl"),
      "utf8",
    ),
  );
  const locatorHealth = JSON.parse(
    await readFile(
      path.join(generation.root, "indexes", "locator-health.json"),
      "utf8",
    ),
  );
  const projectRecords = {};
  for (const project of catalog.projects) {
    projectRecords[project.id] = parseJsonLines(
      await readFile(
        path.join(generation.root, projectShardPath(project.id)),
        "utf8",
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
      : { status: "unchecked" };
  };
}

export async function updateStore({
  home,
  op,
  detail = {},
  transform,
  probeLocator,
  now = () => new Date(),
  appendEvent = appendFile,
} = {}) {
  return withWriteLock({ home }, async () => {
    const previousGeneration = await readCurrentGeneration(home);
    const source = await readStoreSource(home);
    const preserveLocatorHealth = preservingLocatorProbe(source);
    const result = await transform(source);
    const generation = await buildGeneration({
      home,
      source,
      indexBuilder: (id) => buildIndexes({
        generation: id,
        catalog: source.catalog,
        globalRecords: source.globalRecords,
        projectRecords: source.projectRecords,
        probeLocator: probeLocator ?? preserveLocatorHealth,
      }),
    });
    await promoteGeneration({ home, generation });
    try {
      await appendEvent(
        path.join(home, "events.jsonl"),
        `${JSON.stringify({
          at: now().toISOString(),
          op,
          generation: generation.id,
          ...(typeof detail === "function" ? detail(result) : detail),
        })}\n`,
        "utf8",
      );
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
    return { generation: generation.id, result };
  });
}
