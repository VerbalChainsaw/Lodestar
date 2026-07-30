import { BUDGETS_V1 } from "./budgets.mjs";
import { ContextError } from "./validation.mjs";

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function resultObject({ root, depth, records, omitted, warnings }) {
  const omittedIds = [...omitted].sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    root,
    depth,
    records,
    truncated: omittedIds.length > 0 || warnings.length > 0,
    omitted_ids: omittedIds,
    warnings,
  };
}

export async function resolveLinks({
  root,
  depth = BUDGETS_V1.resolve.defaultDepth,
  get,
} = {}) {
  if (!Number.isInteger(depth) || depth < 0) {
    throw new ContextError("invalid-resolve-depth", { depth });
  }
  if (depth > BUDGETS_V1.resolve.maxDepth) {
    throw new ContextError("resolve-depth-exceeded", {
      depth,
      limit: BUDGETS_V1.resolve.maxDepth,
    });
  }

  const rootRecord = await get(root);
  const records = [rootRecord];
  const visited = new Set([root]);
  const omitted = new Set();
  const warnings = [];
  let frontier = [...new Set(rootRecord.links ?? [])]
    .filter((id) => !visited.has(id))
    .sort((a, b) => a.localeCompare(b));

  for (let level = 1; level <= depth; level += 1) {
    const next = [];
    for (let index = 0; index < frontier.length; index += 1) {
      const id = frontier[index];
      if (visited.has(id)) continue;
      if (records.length >= BUDGETS_V1.resolve.maxRecords) {
        for (const remaining of frontier.slice(index)) {
          if (!visited.has(remaining)) omitted.add(remaining);
        }
        break;
      }
      visited.add(id);
      let record;
      try {
        record = await get(id);
      } catch (error) {
        if (error.code === "scope-denied") {
          warnings.push({ code: "scope-denied", id });
          continue;
        }
        throw error;
      }
      records.push(record);
      for (const linked of record.links ?? []) {
        if (!visited.has(linked)) next.push(linked);
      }
    }
    frontier = [...new Set(next)]
      .filter((id) => !visited.has(id))
      .sort((a, b) => a.localeCompare(b));
  }
  for (const id of frontier) omitted.add(id);

  let result = resultObject({ root, depth, records, omitted, warnings });
  while (
    byteLength(result) > BUDGETS_V1.resolve.maxBytes
    && records.length > 1
  ) {
    omitted.add(records.pop().id);
    result = resultObject({ root, depth, records, omitted, warnings });
  }
  if (byteLength(result) > BUDGETS_V1.resolve.maxBytes) {
    throw new ContextError("resolve-budget-exceeded", {
      root,
      limit: BUDGETS_V1.resolve.maxBytes,
    });
  }
  return result;
}
