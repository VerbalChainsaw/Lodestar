import { createHash } from "node:crypto";

import { canonicalStringify } from "../json.mjs";
import {
  identifierIsValid,
  validatePutInput,
} from "../validate.mjs";
import {
  beginLocatorHealthCandidate,
  finishLocatorHealthCandidate,
  selectLocatorHealth,
} from "./locator-health.mjs";
import { locationText, mapCandidate } from "./mapping.mjs";


const CONTROL = /[\u0000-\u001f\u007f]/gu;
const UNPAIRED_SURROGATE = /[\uD800-\uDFFF]/gu;
const REPORT_STATE = Symbol("migrationReportState");

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function generatedId(source, location) {
  return `legacy:${hash(canonicalStringify({
    generation: source.generation,
    location,
  })).slice(0, 32)}`;
}

function reportSection(state, name) {
  const entries = [];
  Object.defineProperty(entries, "push", {
    enumerable: false,
    value(...values) {
      for (const value of values) {
        state[name].total += 1;
        Array.prototype.push.call(entries, value);
      }
      return entries.length;
    },
  });
  return entries;
}

function conversionReport() {
  const state = {
    skipped: { total: 0 },
    unsupported: { total: 0 },
    id_mappings: { total: 0 },
  };
  const report = {
    skipped: reportSection(state, "skipped"),
    unsupported: reportSection(state, "unsupported"),
    id_mappings: reportSection(state, "id_mappings"),
  };
  Object.defineProperty(report, REPORT_STATE, {
    enumerable: false,
    value: state,
  });
  return report;
}

function finalizeReport(report) {
  const state = report[REPORT_STATE];
  report.reporting = {
    truncated: false,
    sections: Object.fromEntries(
      Object.entries(state).map(([name, values]) => [name, {
        entries_total: values.total,
        entries_reported: report[name].length,
        entries_omitted: 0,
      }]),
    ),
  };
  return report;
}

function availableGeneratedId(source, candidate, used, reserved) {
  const base = generatedId(source, candidate.location);
  const location = locationText(candidate.location);
  const maximumAttempts = used.size + reserved.size + 1;
  for (let attempt = 0; attempt <= maximumAttempts; attempt += 1) {
    const id = attempt === 0
      ? base
      : `legacy:${hash(
        attempt === 1
          ? `${base}\0${location}`
          : `${base}\0${location}\0${attempt - 1}`,
      )}`;
    if (!used.has(id) && !reserved.has(id)) return id;
  }
  throw new Error("Deterministic legacy identifier allocation was exhausted.");
}

function assignedId(source, candidate, used, reserved, report) {
  const original = candidate.payload.id;
  let id = original;
  let reason = null;
  if (!identifierIsValid(id)) reason = original ? "invalid_id" : "missing_id";
  else if (used.has(id)) reason = "duplicate_id";
  if (reason) {
    id = availableGeneratedId(source, candidate, used, reserved);
    report.id_mappings.push({
      source_id: original ?? null,
      record_id: id,
      reason,
      source: locationText(candidate.location),
    });
  }
  used.add(id);
  return id;
}

function routeRelationship(route, report, owner) {
  const raw = `route:${route}`;
  const normalized = raw.normalize("NFC")
    .replace(CONTROL, " ")
    .replace(UNPAIRED_SURROGATE, "�")
    .trim();
  const cleaned = normalized || `route:${hash(raw).slice(0, 32)}`;
  if (cleaned !== raw) {
    report.unsupported.push({
      kind: "link",
      identifier: owner,
      reason: "relationship_remapped",
      original: raw,
      disposition: cleaned,
    });
  }
  return cleaned;
}

function targetFor(target, primaryByOriginal) {
  return typeof target === "string" ? primaryByOriginal.get(target) : null;
}

function candidateList(source) {
  const projects = source.catalog.projects.map((project, index) => ({
    payload: project,
    defaultScope: "global",
    project: true,
    location: {
      file: "catalog.json",
      item: `project:${index}`,
    },
  }));
  const records = source.records.map((entry) => ({
    payload: entry.record,
    defaultScope: entry.defaultScope,
    project: false,
    location: entry.location,
  }));
  return [...projects, ...records].sort((left, right) => {
    const leftLocation = locationText(left.location);
    const rightLocation = locationText(right.location);
    return leftLocation < rightLocation ? -1 : leftLocation > rightLocation ? 1 : 0;
  });
}

export function convertV070(source) {
  const report = conversionReport();
  const usedIds = new Set();
  const primaryByOriginal = new Map();
  const converted = [];
  const candidates = candidateList(source);
  const selectedHealth = selectLocatorHealth(source, candidates);
  const reservedIds = new Set(candidates
    .map(({ payload }) => payload?.id)
    .filter((id) => identifierIsValid(id)));

  for (const candidate of candidates) {
    const payload = candidate.payload;
    if (
      payload === null
      || typeof payload !== "object"
      || Array.isArray(payload)
    ) {
      report.skipped.push({
        kind: candidate.project ? "project" : "record",
        identifier: null,
        source: locationText(candidate.location),
        reason: "item_not_object",
        disposition: "skipped",
      });
      continue;
    }
    const id = assignedId(source, candidate, usedIds, reservedIds, report);
    let bundle;
    beginLocatorHealthCandidate(selectedHealth.source);
    try {
      bundle = {
        id,
        ...mapCandidate(selectedHealth.source, candidate, id, report),
        aliases: [],
        links: [],
      };
      validatePutInput(bundle);
    } catch (error) {
      finishLocatorHealthCandidate(selectedHealth.source, false);
      if (error?.name !== "LodestarError") throw error;
      usedIds.delete(id);
      report.skipped.push({
        kind: candidate.project ? "project" : "record",
        identifier: payload.id ?? null,
        source: locationText(candidate.location),
        reason: error.code ?? "invalid_input",
        disposition: "skipped",
      });
      continue;
    }
    finishLocatorHealthCandidate(selectedHealth.source, true);
    if (typeof payload.id === "string" && !primaryByOriginal.has(payload.id)) {
      primaryByOriginal.set(payload.id, id);
    }
    converted.push({
      bundle,
      payload,
      location: candidate.location,
    });
  }

  const allIds = new Set(converted.map(({ bundle }) => bundle.id));
  const aliasOwners = new Map();
  for (const item of converted) {
    if (
      item.payload.aliases !== undefined
      && !Array.isArray(item.payload.aliases)
    ) {
      report.unsupported.push({
        kind: "record",
        identifier: item.bundle.id,
        source: locationText(item.location),
        reason: "aliases_not_array",
        disposition: "aliases_skipped",
      });
    }
    const candidates = Array.isArray(item.payload.aliases)
      ? item.payload.aliases
      : [];
    for (const alias of candidates) {
      if (!identifierIsValid(alias)) {
        report.skipped.push({
          kind: "alias",
          identifier: alias ?? null,
          source: locationText(item.location),
          reason: "invalid_alias",
          disposition: "skipped",
        });
        continue;
      }
      if (allIds.has(alias)) {
        report.skipped.push({
          kind: "alias",
          identifier: alias,
          source: locationText(item.location),
          reason: "alias_conflicts_with_id",
          disposition: "skipped",
        });
        continue;
      }
      const owner = aliasOwners.get(alias);
      if (owner && owner !== item.bundle.id) {
        report.skipped.push({
          kind: "alias",
          identifier: alias,
          source: locationText(item.location),
          reason: "alias_conflict",
          disposition: "skipped",
        });
        continue;
      }
      if (item.bundle.aliases.includes(alias)) {
        report.skipped.push({
          kind: "alias",
          identifier: alias,
          source: locationText(item.location),
          reason: "duplicate_alias",
          disposition: "skipped",
        });
        continue;
      }
      item.bundle.aliases.push(alias);
      aliasOwners.set(alias, item.bundle.id);
    }
  }

  for (const item of converted) {
    const seen = new Set();
    const append = (relationship, originalTarget, origin) => {
      const target = targetFor(originalTarget, primaryByOriginal);
      if (!target) {
        report.skipped.push({
          kind: "link",
          identifier: item.bundle.id,
          source: locationText(item.location),
          reason: "missing_target",
          target: originalTarget ?? null,
          origin,
          disposition: "skipped",
        });
        return;
      }
      const key = `${relationship}\0${target}`;
      if (seen.has(key)) {
        report.skipped.push({
          kind: "link",
          identifier: item.bundle.id,
          source: locationText(item.location),
          reason: "duplicate_link",
          target: originalTarget,
          origin,
          disposition: "skipped",
        });
        return;
      }
      seen.add(key);
      item.bundle.links.push({ relationship, to_id: target });
    };

    if (item.payload.links !== undefined && !Array.isArray(item.payload.links)) {
      report.unsupported.push({
        kind: "record",
        identifier: item.bundle.id,
        source: locationText(item.location),
        reason: "links_not_array",
        disposition: "links_skipped",
      });
    }
    for (const target of Array.isArray(item.payload.links)
      ? item.payload.links
      : []) {
      append("related", target, "links");
    }

    if (
      item.payload.routes !== undefined
      && (
        !item.payload.routes
        || typeof item.payload.routes !== "object"
        || Array.isArray(item.payload.routes)
      )
    ) {
      report.unsupported.push({
        kind: "record",
        identifier: item.bundle.id,
        source: locationText(item.location),
        reason: "routes_not_object",
        disposition: "routes_skipped",
      });
    } else {
      const routes = Object.keys(item.payload.routes ?? {}).sort();
      for (const route of routes) {
        append(
          routeRelationship(route, report, item.bundle.id),
          item.payload.routes[route],
          `routes.${route}`,
        );
      }
    }
    item.bundle.aliases.sort();
    item.bundle.links.sort((left, right) =>
      left.relationship < right.relationship
        ? -1
        : left.relationship > right.relationship
          ? 1
          : left.to_id < right.to_id
            ? -1
            : left.to_id > right.to_id
              ? 1
              : 0
    );
    validatePutInput(item.bundle);
  }

  converted.sort((left, right) =>
    left.bundle.id < right.bundle.id ? -1 : left.bundle.id > right.bundle.id ? 1 : 0
  );
  for (const entry of selectedHealth.unsupported) {
    report.unsupported.push(entry);
  }
  return {
    records: converted.map(({ bundle }) => bundle),
    report: finalizeReport(report),
    counts: {
      records: converted.length,
      aliases: converted.reduce(
        (total, { bundle }) => total + bundle.aliases.length,
        0,
      ),
      links: converted.reduce(
        (total, { bundle }) => total + bundle.links.length,
        0,
      ),
      sources: converted.reduce(
        (total, { bundle }) => total + bundle.sources.length,
        0,
      ),
    },
  };
}
