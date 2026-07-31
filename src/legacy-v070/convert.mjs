import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { boundedDiagnosticValue } from "../diagnostics.mjs";
import { canonicalStringify } from "../json.mjs";
import {
  identifierIsValid,
  LIMITS,
  validatePutInput,
} from "../validate.mjs";
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
        if (entries.length < LIMITS.migrationReportItemsPerSection) {
          Array.prototype.push.call(entries, boundedDiagnosticValue(value, {
            maximumBytes: LIMITS.migrationReportItemBytes,
          }));
        } else {
          state[name].omitted += 1;
        }
      }
      return entries.length;
    },
  });
  return entries;
}

function conversionReport() {
  const state = {
    skipped: { total: 0, omitted: 0 },
    unsupported: { total: 0, omitted: 0 },
    id_mappings: { total: 0, omitted: 0 },
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
    items_per_section_maximum: LIMITS.migrationReportItemsPerSection,
    item_bytes_maximum: LIMITS.migrationReportItemBytes,
    truncated: Object.values(state).some(({ omitted }) => omitted > 0),
    sections: Object.fromEntries(
      Object.entries(state).map(([name, values]) => [name, {
        entries_total: values.total,
        entries_reported: report[name].length,
        entries_omitted: values.omitted,
      }]),
    ),
  };
  return report;
}

function boundedLegacyItems(values, field, report, item) {
  if (values.length <= LIMITS.legacyFieldItems) return values;
  report.skipped.push({
    kind: field,
    identifier: item.bundle.id,
    source: locationText(item.location),
    reason: "field_processing_limit",
    field,
    items: values.length,
    processed: LIMITS.legacyFieldItems,
    omitted_items: values.length - LIMITS.legacyFieldItems,
    disposition: "remaining_items_skipped",
  });
  return values.slice(0, LIMITS.legacyFieldItems);
}

function assignedId(source, candidate, used, report) {
  const original = candidate.payload.id;
  let id = original;
  let reason = null;
  if (!identifierIsValid(id)) reason = original ? "invalid_id" : "missing_id";
  else if (used.has(id)) reason = "duplicate_id";
  if (reason) {
    id = generatedId(source, candidate.location);
    if (used.has(id)) {
      id = `legacy:${hash(`${id}\0${locationText(candidate.location)}`)}`;
    }
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
  const cleaned = normalized
    && Buffer.byteLength(normalized, "utf8") <= LIMITS.relationshipBytes
    ? normalized
    : `route:${hash(raw).slice(0, 32)}`;
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

  for (const candidate of candidateList(source)) {
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
    const id = assignedId(source, candidate, usedIds, report);
    let bundle;
    try {
      bundle = {
        id,
        ...mapCandidate(source, candidate, id, report),
        aliases: [],
        links: [],
      };
      validatePutInput(bundle);
    } catch (error) {
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
      ? boundedLegacyItems(
        item.payload.aliases,
        "alias",
        report,
        item,
      )
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
      if (item.bundle.aliases.length < LIMITS.aliasesPerRecord) {
        item.bundle.aliases.push(alias);
        aliasOwners.set(alias, item.bundle.id);
      } else {
        report.skipped.push({
          kind: "alias",
          identifier: alias,
          source: locationText(item.location),
          reason: "alias_limit",
          disposition: "skipped",
        });
      }
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
      if (item.bundle.links.length >= LIMITS.linksPerRecord) {
        report.skipped.push({
          kind: "link",
          identifier: item.bundle.id,
          source: locationText(item.location),
          reason: "link_limit",
          target: originalTarget,
          origin,
          disposition: "skipped",
        });
        return;
      }
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
      ? boundedLegacyItems(
        item.payload.links,
        "link",
        report,
        item,
      )
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
      for (const route of boundedLegacyItems(
        routes,
        "route",
        report,
        item,
      )) {
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
