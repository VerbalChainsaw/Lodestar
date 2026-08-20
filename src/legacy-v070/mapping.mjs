import {
  FRESHNESS_STATES,
  KNOWLEDGE_STATES,
} from "../validate.mjs";
import { retainLocatorHealth, selectedLocatorHealth } from "./locator-health.mjs";

const CONTROL = /[\u0000-\u001f\u007f]/gu;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/gu;

export function locationText(location) {
  return location.line
    ? `${location.file}#L${location.line}`
    : `${location.file}#${location.item}`;
}

function cleanText(value, fallback) {
  const candidate = typeof value === "string" ? value : fallback;
  const cleaned = candidate.normalize("NFC")
    .replace(CONTROL, " ")
    .replace(UNPAIRED_SURROGATE, "�")
    .trim();
  return cleaned || fallback;
}

function reportFieldRemap(
  report,
  location,
  identifier,
  field,
  original,
  disposition,
  kind = "record",
) {
  if (typeof original !== "string" || original === disposition) return;
  report.unsupported.push({
    kind,
    source: locationText(location),
    identifier: identifier ?? null,
    reason: "field_remapped",
    field,
    original,
    disposition,
  });
}

function recordName(payload, id, report, location) {
  const original =
    payload.name
      ?? payload.summary
      ?? (Array.isArray(payload.aliases) ? payload.aliases[0] : null)
      ?? id;
  const name = cleanText(original, id);
  if (typeof original !== "string") {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "name_defaulted",
      disposition: name,
    });
  } else {
    reportFieldRemap(
      report,
      location,
      payload.id,
      "name",
      original,
      name,
    );
  }
  return name;
}

function projectName(payload, id, report, location) {
  const name = cleanText(payload.name, id);
  if (typeof payload.name !== "string") {
    report.unsupported.push({
      kind: "project",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "name_defaulted",
      disposition: name,
    });
  } else {
    reportFieldRemap(
      report,
      location,
      payload.id,
      "name",
      payload.name,
      name,
      "project",
    );
  }
  return name;
}

function recordType(payload, report, location) {
  const type = cleanText(payload.kind ?? "legacy", "legacy");
  if (typeof payload.kind !== "string") {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "type_defaulted",
      disposition: type,
    });
  } else {
    reportFieldRemap(
      report,
      location,
      payload.id,
      "type",
      payload.kind,
      type,
    );
  }
  return type;
}

function knowledgeState(payload, report, location) {
  if (payload.none_verified === true) return "known_empty";
  if (KNOWLEDGE_STATES.includes(payload.state)) return payload.state;
  const disposition = payload.stale === true
    ? "stale"
    : payload.unavailable === true
      ? "unavailable"
      : "known";
  if (payload.state !== undefined) {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "knowledge_state_defaulted",
      original: payload.state,
      disposition,
    });
  }
  return disposition;
}

function scopeFor(payload, defaultScope, report, location) {
  const rawScopes = Array.isArray(payload.scope) ? payload.scope : [];
  const scopes = [...new Set(rawScopes.filter((value) =>
    typeof value === "string" && value.length > 0
  ))].sort();
  if (
    Array.isArray(payload.scope)
    && rawScopes.length !== rawScopes.filter((value) =>
      typeof value === "string" && value.length > 0
    ).length
  ) {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "invalid_scope_entries",
      disposition: "invalid_entries_ignored",
    });
  }
  if (scopes.length === 0) {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "scope_defaulted",
      disposition: defaultScope,
    });
    return defaultScope;
  }
  if (scopes.length === 1) {
    const scope = cleanText(scopes[0], defaultScope);
    reportFieldRemap(
      report,
      location,
      payload.id,
      "scope",
      scopes[0],
      scope,
    );
    return scope;
  }
  const selected = scopes.includes("global") ? "global" : scopes[0];
  const scope = cleanText(selected, defaultScope);
  report.unsupported.push({
    kind: "record",
    source: locationText(location),
    identifier: payload.id ?? null,
    reason: "multi_scope_collapsed",
    disposition: scope,
    original: scopes,
  });
  return scope;
}

function inspectionFor(payload) {
  if (payload.none_verified === true) return "inspected_no_value";
  if (payload.verified && typeof payload.verified === "object") {
    return "inspected";
  }
  if (
    payload.source_inspected === false
    || payload.inspected === false
  ) {
    return "not_inspected";
  }
  return "unknown";
}

function freshnessFor(payload, report, location) {
  if (FRESHNESS_STATES.includes(payload.freshness)) {
    return payload.freshness;
  }
  const disposition = payload.stale === true ? "stale" : "unknown";
  if (payload.freshness !== undefined) {
    report.unsupported.push({
      kind: "source",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "freshness_defaulted",
      original: payload.freshness,
      disposition,
    });
  }
  return disposition;
}

function sourceMetadata(source, payload, location, report) {
  const legacy = {
    generation: source.generation,
    location: locationText(location),
  };
  for (const field of [
    "ownership",
    "generated_by",
    "source_key",
    "verified",
  ]) {
    if (payload[field] !== undefined) legacy[field] = payload[field];
  }
  const metadata = {
    inspection: inspectionFor(payload),
    legacy,
  };
  return metadata;
}

function locatorOrigin(locator, payload, location, report) {
  if (
    !locator
    || typeof locator !== "object"
    || Array.isArray(locator)
    || typeof locator.path !== "string"
    || locator.path.length === 0
  ) {
    report.skipped.push({
      kind: "source",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "invalid_locator",
      disposition: "source_skipped",
    });
    return null;
  }
  const original = locator.path;
  const normalized = original.normalize("NFC")
    .replace(CONTROL, " ")
    .replace(UNPAIRED_SURROGATE, "�")
    .trim();
  if (!normalized) {
    report.skipped.push({
      kind: "source",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "empty_locator_path",
      disposition: "source_skipped",
    });
    return null;
  }
  const origin = normalized;
  reportFieldRemap(
    report,
    location,
    payload.id,
    "locator.path",
    original,
    origin,
    "source",
  );
  return origin;
}

function locatorMetadata({
  source,
  payload,
  location,
  locator,
  index,
  health,
  report,
}) {
  const metadata = {
    inspection: health?.status === "unchecked"
      ? "not_inspected"
      : "unknown",
    legacy: {
      generation: source.generation,
      location: locationText(location),
      locator_index: index,
      locator,
      ...(health ? { health } : {}),
    },
  };
  if (health) retainLocatorHealth(source, `${payload.id}#${index}`);
  return metadata;
}

function mappedSources(source, payload, location, report) {
  const freshness = freshnessFor(payload, report, location);
  const sources = [{
    origin:
      `lodestar-v0.7:${source.generation}/${locationText(location)}`,
    freshness,
    metadata: sourceMetadata(source, payload, location, report),
  }];
  if (payload.locators !== undefined && !Array.isArray(payload.locators)) {
    report.unsupported.push({
      kind: "record",
      source: locationText(location),
      identifier: payload.id ?? null,
      reason: "locators_not_array",
      disposition: "locator_sources_skipped",
    });
    return sources;
  }
  const locators = Array.isArray(payload.locators) ? payload.locators : [];
  const origins = new Set(sources.map(({ origin }) => origin));
  for (const [index, locator] of locators.entries()) {
    const origin = locatorOrigin(locator, payload, location, report);
    if (!origin) continue;
    if (origins.has(origin)) {
      report.skipped.push({
        kind: "source",
        source: locationText(location),
        identifier: payload.id ?? null,
        reason: "duplicate_source_origin",
        origin,
        locator_index: index,
        disposition: "source_skipped",
      });
      continue;
    }
    origins.add(origin);
    const healthKey = `${payload.id}#${index}`;
    const health = selectedLocatorHealth(source, healthKey);
    sources.push({
      origin,
      freshness,
      metadata: locatorMetadata({
        source,
        payload,
        location,
        locator,
        index,
        health,
        report,
      }),
    });
  }
  return sources;
}

export function mapCandidate(source, candidate, id, report) {
  const { payload, location } = candidate;
  return {
    type: candidate.project
      ? "project"
      : recordType(payload, report, location),
    name: candidate.project
      ? projectName(payload, id, report, location)
      : recordName(payload, id, report, location),
    scope: candidate.project
      ? "global"
      : scopeFor(payload, candidate.defaultScope, report, location),
    content: {
      state: candidate.project
        ? "known"
        : knowledgeState(payload, report, location),
      value: payload,
    },
    sources: mappedSources(source, payload, location, report),
  };
}
