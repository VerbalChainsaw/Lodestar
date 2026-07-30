import path from "node:path";

function locatorWithHealth(record, locator, index, locatorHealth) {
  return {
    ...locator,
    health: locatorHealth.locators?.[`${record.id}#${index}`]
      ?? { status: "unchecked" },
  };
}

export function decorateRecord(record, locatorHealth) {
  if (!record.locators) return { ...record };
  return {
    ...record,
    locators: record.locators.map((locator, index) =>
      locatorWithHealth(record, locator, index, locatorHealth)),
  };
}

export function recordCard(record, locatorHealth) {
  const decorated = decorateRecord(record, locatorHealth);
  return Object.fromEntries(
    [
      ["id", decorated.id],
      ["kind", decorated.kind],
      ["priority", decorated.priority],
      ["required", decorated.required],
      ["summary", decorated.summary],
      ["aliases", decorated.aliases],
      ["topics", decorated.topics],
      ["links", decorated.links],
      ["locators", decorated.locators],
    ].filter(([, value]) =>
      value !== undefined
      && (!Array.isArray(value) || value.length > 0)),
  );
}

export function startupCard(record) {
  return Object.fromEntries(
    [
      ["id", record.id],
      ["kind", record.kind],
      ["priority", record.priority],
      ["summary", record.summary],
      ["links", record.links],
    ].filter(([, value]) =>
      value !== undefined
      && (!Array.isArray(value) || value.length > 0)),
  );
}

export function locatorWarnings(records, locatorHealth) {
  const warnings = [];
  for (const record of records) {
    for (const [index, locator] of (record.locators ?? []).entries()) {
      const health = locatorHealth.locators?.[`${record.id}#${index}`]
        ?? { status: "unchecked" };
      if (!["missing", "unreadable"].includes(health.status)) continue;
      const fileTopic = path.basename(locator.path, path.extname(locator.path));
      const topics = [fileTopic, locator.anchor].filter(Boolean);
      warnings.push({
        code: `locator-${health.status}`,
        id: record.id,
        locator: index,
        next: `agentctx find ${topics.join(" ")}`,
      });
    }
  }
  return warnings.sort(
    (a, b) => a.id.localeCompare(b.id) || a.locator - b.locator,
  );
}
