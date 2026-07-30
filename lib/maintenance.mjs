import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile } from "./atomic-file.mjs";
import { readFileLimited } from "./bounded-io.mjs";
import { diagnoseStore, inspectGeneration } from "./doctor.mjs";
import { syncDirectoryAfterCommit } from "./durable-fs.mjs";
import { LodestarError, wrapError } from "./errors.mjs";
import {
  promoteGeneration,
  readCurrentGeneration,
} from "./generation.mjs";
import { generationPaths, statePaths } from "./store-layout.mjs";
import { withWriteLock } from "./write-lock.mjs";
import {
  inspectProjectFingerprint,
} from "../tools/profile-projects.mjs";
import { readStoreSource } from "../tools/tool-store.mjs";

const GENERATION_ID = /^[a-f0-9]{64}$/;
const DEFAULT_RETAIN = 10;
const DEFAULT_AUDIT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_BYTES = 64 * 1024 * 1024;

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

function positiveInteger(value, name, { minimum = 1, maximum } = {}) {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || (maximum !== undefined && value > maximum)
  ) {
    throw new LodestarError(
      "maintenance-option-invalid",
      `Maintenance option ${name} is outside its supported range`,
      { detail: { option: name, value, minimum, maximum: maximum ?? null } },
    );
  }
  return value;
}

async function exists(target, fsApi) {
  try {
    await operation(fsApi, "access")(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryBytes(root, fsApi) {
  let bytes = 0;
  const entries = await operation(fsApi, "readdir")(root, {
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) bytes += await directoryBytes(target, fsApi);
    if (entry.isFile()) bytes += (await operation(fsApi, "stat")(target)).size;
  }
  return bytes;
}

async function generationInventory(home, active, fsApi) {
  const root = statePaths(home).generations;
  const entries = await operation(fsApi, "readdir")(root, {
    withFileTypes: true,
  });
  const generations = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !GENERATION_ID.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    const info = await operation(fsApi, "stat")(target);
    generations.push({
      id: entry.name,
      active: entry.name === active,
      modified_at: new Date(info.mtimeMs).toISOString(),
      modified_ms: info.mtimeMs,
      bytes: await directoryBytes(target, fsApi),
    });
  }
  return generations.sort((a, b) =>
    b.modified_ms - a.modified_ms || a.id.localeCompare(b.id)
  );
}

function retentionPlan(generations, retain, validGenerationIds = null) {
  const ordered = validGenerationIds
    ? [...generations].sort((a, b) => {
      const aValid = validGenerationIds.has(a.id) ? 1 : 0;
      const bValid = validGenerationIds.has(b.id) ? 1 : 0;
      return bValid - aValid
        || b.modified_ms - a.modified_ms
        || a.id.localeCompare(b.id);
    })
    : generations;
  const keep = new Set(ordered.slice(0, retain).map(({ id }) => id));
  const active = generations.find(({ active }) => active);
  if (active) keep.add(active.id);
  return {
    keep: generations.filter(({ id }) => keep.has(id)),
    quarantine: generations.filter(({ id }) => !keep.has(id)),
  };
}

function storedFingerprint(records) {
  const fingerprints = records
    .filter(({ ownership, verified }) =>
      ownership === "generated"
      && typeof verified?.sha256 === "string"
    )
    .map(({ verified }) => verified.sha256);
  return fingerprints[0] ?? null;
}

async function sourceDrift(source) {
  const rows = [];
  for (const project of source.catalog.projects) {
    try {
      const current = await inspectProjectFingerprint(project);
      const stored = storedFingerprint(source.projectRecords[project.id] ?? []);
      rows.push({
        project: project.id,
        status: current.status === "missing-root"
          ? "blocked"
          : stored === null
            ? "unverified"
            : stored === current.sha256
              ? "current"
              : "drifted",
        stored_sha256: stored,
        current_sha256: current.sha256,
      });
    } catch (error) {
      rows.push({
        project: project.id,
        status: "check-failed",
        error: error.code ?? "unknown",
      });
    }
  }
  return {
    checked: rows.length,
    current: rows.filter(({ status }) => status === "current").length,
    drifted: rows.filter(({ status }) => status === "drifted").length,
    unverified: rows.filter(({ status }) => status === "unverified").length,
    blocked: rows.filter(({ status }) => status === "blocked").length,
    failed: rows.filter(({ status }) => status === "check-failed").length,
    projects: rows,
  };
}

function parseAuditEvents(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    try {
      JSON.parse(line);
    } catch (error) {
      throw new LodestarError(
        "audit-log-invalid",
        "Audit log contains malformed JSON and will not be rotated",
        { cause: error, detail: { line: index + 1 } },
      );
    }
  }
  return lines;
}

async function auditStatus(home, maxBytes, fsApi) {
  const file = statePaths(home).events;
  try {
    const info = await operation(fsApi, "stat")(file);
    return {
      path: file,
      bytes: info.size,
      rotation_required: info.size > maxBytes,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { path: file, bytes: 0, rotation_required: false };
    }
    throw error;
  }
}

async function rotateAudit(home, now, fsApi) {
  const current = statePaths(home).events;
  if (!await exists(current, fsApi)) return null;
  const text = await readFileLimited(current, {
    maximum: MAX_AUDIT_BYTES,
    encoding: "utf8",
    resource: "audit-log-bytes",
    fsApi,
  });
  const lines = parseAuditEvents(text);
  const digest = createHash("sha256").update(text).digest("hex");
  const stamp = now().toISOString().replaceAll(":", "-");
  const rotated = path.join(home, `events.${stamp}.${digest.slice(0, 12)}.jsonl`);
  try {
    await operation(fsApi, "rename")(current, rotated);
    await atomicWriteFile(
      current,
      `${JSON.stringify({
        at: now().toISOString(),
        op: "audit-rotate",
        previous_file: path.basename(rotated),
        previous_events: lines.length,
        previous_bytes: Buffer.byteLength(text),
        previous_sha256: digest,
      })}\n`,
      { fsApi },
    );
    return {
      rotated: path.basename(rotated),
      events: lines.length,
      bytes: Buffer.byteLength(text),
      sha256: digest,
    };
  } catch (error) {
    if (await exists(rotated, fsApi) && !await exists(current, fsApi)) {
      try {
        await operation(fsApi, "rename")(rotated, current);
      } catch (restoreError) {
        throw new LodestarError(
          "audit-rotation-rollback-failed",
          "Audit rotation failed and the prior audit log could not be restored",
          {
            cause: new AggregateError([error, restoreError]),
            detail: {
              path: current,
              rotated,
              cause_code: error.code ?? null,
              restore_code: restoreError.code ?? null,
            },
          },
        );
      }
    }
    throw wrapError(
      error,
      "audit-rotation-failed",
      "Unable to rotate the Lodestar audit log",
      { path: current },
    );
  }
}

async function writeMaintenanceAudit({
  home,
  active,
  moved,
  now,
  fsApi,
}) {
  const file = statePaths(home).events;
  let existing = "";
  try {
    existing = await readFileLimited(file, {
      maximum: MAX_AUDIT_BYTES,
      encoding: "utf8",
      resource: "audit-log-bytes",
      fsApi,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  parseAuditEvents(existing);
  const prefix = existing.length === 0 || existing.endsWith("\n")
    ? existing
    : `${existing}\n`;
  await atomicWriteFile(
    file,
    `${prefix}${JSON.stringify({
      at: now().toISOString(),
      op: "maintain",
      generation: active,
      quarantined: moved.map(({ generation }) => generation),
    })}\n`,
    { fsApi },
  );
}

async function appendRecoveryAudit({
  home,
  generation,
  previousGeneration,
  promoted,
  now,
  fsApi,
}) {
  const file = statePaths(home).events;
  let existing = "";
  try {
    existing = await readFileLimited(file, {
      maximum: MAX_AUDIT_BYTES,
      encoding: "utf8",
      resource: "audit-log-bytes",
      fsApi,
    });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  parseAuditEvents(existing);
  const prefix = existing.length === 0 || existing.endsWith("\n")
    ? existing
    : `${existing}\n`;
  await atomicWriteFile(
    file,
    `${prefix}${JSON.stringify({
      at: now().toISOString(),
      op: "recover-quarantine",
      generation,
      previous_generation: previousGeneration,
      promoted,
    })}\n`,
    { fsApi },
  );
}

async function restoreMovedGenerations(moved, fsApi) {
  const errors = [];
  for (const item of [...moved].reverse()) {
    try {
      await operation(fsApi, "rename")(item.quarantine, item.source);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function restoreRotatedAudit(home, rotation, fsApi) {
  if (!rotation) return [];
  const errors = [];
  const current = statePaths(home).events;
  const rotated = path.join(home, rotation.rotated);
  try {
    await operation(fsApi, "unlink")(current);
  } catch (error) {
    if (error.code !== "ENOENT") errors.push(error);
  }
  if (errors.length === 0) {
    try {
      await operation(fsApi, "rename")(rotated, current);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function applyRetention({
  home,
  retain,
  validGenerationIds,
  expectedActive,
  expectedQuarantine,
  now,
  fsApi,
}) {
  const active = await readCurrentGeneration(home, { fsApi });
  const inventory = await generationInventory(home, active.id, fsApi);
  const plan = retentionPlan(inventory, retain, validGenerationIds);
  const actualQuarantine = plan.quarantine.map(({ id }) => id);
  if (
    active.id !== expectedActive
    || JSON.stringify(actualQuarantine) !== JSON.stringify(expectedQuarantine)
  ) {
    throw new LodestarError(
      "maintenance-store-changed",
      "The store changed after maintenance was planned; run preview again",
      {
        detail: {
          expected_generation: expectedActive,
          actual_generation: active.id,
          expected_quarantine: expectedQuarantine,
          actual_quarantine: actualQuarantine,
        },
      },
    );
  }
  const quarantineRoot = path.join(
    statePaths(home).quarantine,
    "generations",
  );
  const moved = [];
  if (plan.quarantine.length > 0) {
    await operation(fsApi, "mkdir")(quarantineRoot, { recursive: true });
  }
  try {
    for (const generation of plan.quarantine) {
      if (generation.id === active.id) {
        throw new LodestarError(
          "maintenance-active-generation-refused",
          "Maintenance refused to quarantine the active generation",
          { detail: { generation: generation.id } },
        );
      }
      const source = path.join(statePaths(home).generations, generation.id);
      const destination = path.join(
        quarantineRoot,
        `${generation.id}.${now().getTime()}.${randomUUID()}`,
      );
      await operation(fsApi, "rename")(source, destination);
      moved.push({
        generation: generation.id,
        source,
        quarantine: destination,
      });
    }
  } catch (error) {
    const restoreErrors = await restoreMovedGenerations(moved, fsApi);
    throw new LodestarError(
      restoreErrors.length > 0
        ? "generation-retention-rollback-failed"
        : "generation-retention-failed",
      restoreErrors.length > 0
        ? "Generation retention failed and could not restore every moved generation"
        : "Generation retention failed; all moved generations were restored",
      {
        cause: restoreErrors.length > 0
          ? new AggregateError([error, ...restoreErrors])
          : error,
        detail: {
          moved: moved.map(({ generation }) => generation),
          cause_code: error.code ?? null,
          restore_errors: restoreErrors.map(
            (restoreError) => restoreError.code ?? null,
          ),
        },
      },
    );
  }
  const directorySync = moved.length > 0
    ? {
      generations: await syncDirectoryAfterCommit(
        statePaths(home).generations,
        { fsApi },
      ),
      quarantine: await syncDirectoryAfterCommit(quarantineRoot, { fsApi }),
    }
    : null;
  return { active: active.id, moved, durability: directorySync };
}

export async function maintainStore({
  home,
  apply = false,
  retain = DEFAULT_RETAIN,
  auditMaxBytes = DEFAULT_AUDIT_MAX_BYTES,
  checkDrift = true,
  now = () => new Date(),
  fsApi = fs,
} = {}) {
  positiveInteger(retain, "retain", { maximum: 1_000 });
  positiveInteger(auditMaxBytes, "audit-max-bytes", {
    maximum: MAX_AUDIT_BYTES,
  });
  const active = await readCurrentGeneration(home, { fsApi });
  const generations = await generationInventory(home, active.id, fsApi);
  const audit = await auditStatus(home, auditMaxBytes, fsApi);
  const source = checkDrift ? await readStoreSource(home) : null;
  const drift = source ? await sourceDrift(source) : null;
  const diagnosis = await diagnoseStore({ home, fsApi, deep: true });
  if (!diagnosis.ok) {
    throw new LodestarError(
      "maintenance-store-unhealthy",
      "Maintenance refuses to plan or mutate an unhealthy store",
      {
        detail: {
          errors: diagnosis.errors,
          blockers: diagnosis.blockers,
        },
      },
    );
  }
  const validGenerationIds = new Set(diagnosis.valid_generations);
  const retention = retentionPlan(
    generations,
    retain,
    validGenerationIds,
  );
  const plan = {
    retain,
    keep: retention.keep.map(({ id }) => id),
    quarantine: retention.quarantine.map(({ id }) => id),
    rotate_audit: audit.rotation_required,
  };
  if (!apply) {
    return {
      ok: true,
      applied: false,
      home,
      generation: active.id,
      storage: {
        bytes: generations.reduce((sum, item) => sum + item.bytes, 0)
          + audit.bytes,
        generations: generations.length,
        generation_bytes: generations.reduce(
          (sum, item) => sum + item.bytes,
          0,
        ),
        audit_bytes: audit.bytes,
      },
      drift,
      plan,
    };
  }
  const appliedAt = now();
  const applied = await withWriteLock({ home, fsApi }, async () => {
    let rotatedAudit = null;
    let appliedRetention = null;
    try {
      const currentAudit = await auditStatus(home, auditMaxBytes, fsApi);
      if (currentAudit.rotation_required !== audit.rotation_required) {
        throw new LodestarError(
          "maintenance-store-changed",
          "The audit log changed after maintenance was planned; run preview again",
          {
            detail: {
              expected_rotation: audit.rotation_required,
              actual_rotation: currentAudit.rotation_required,
            },
          },
        );
      }
      rotatedAudit = audit.rotation_required
        ? await rotateAudit(home, () => appliedAt, fsApi)
        : null;
      appliedRetention = await applyRetention({
        home,
        retain,
        validGenerationIds,
        expectedActive: active.id,
        expectedQuarantine: plan.quarantine,
        now: () => appliedAt,
        fsApi,
      });
      if (appliedRetention.moved.length > 0) {
        await writeMaintenanceAudit({
          home,
          active: appliedRetention.active,
          moved: appliedRetention.moved,
          now: () => appliedAt,
          fsApi,
        });
      }
      return { appliedRetention, rotatedAudit };
    } catch (error) {
      const rollbackErrors = [
        ...await restoreMovedGenerations(
          appliedRetention?.moved ?? [],
          fsApi,
        ),
        ...await restoreRotatedAudit(home, rotatedAudit, fsApi),
      ];
      if (rollbackErrors.length > 0) {
        throw new LodestarError(
          "maintenance-transaction-rollback-failed",
          "Maintenance failed and could not fully restore its prior state",
          {
            cause: new AggregateError([error, ...rollbackErrors]),
            detail: {
              cause_code: error.code ?? null,
              rollback_codes: rollbackErrors.map(
                (failure) => failure.code ?? null,
              ),
            },
          },
        );
      }
      throw error;
    }
  });
  return {
    ok: true,
    applied: true,
    home,
    generation: active.id,
    drift,
    plan,
    changes: {
      quarantined: applied.appliedRetention.moved,
      audit: applied.rotatedAudit,
      durability: applied.appliedRetention.durability,
    },
  };
}

export async function recoverQuarantinedGeneration({
  home,
  generation,
  promote = false,
  now = () => new Date(),
  fsApi = fs,
} = {}) {
  if (!home || !GENERATION_ID.test(generation ?? "")) {
    throw new LodestarError(
      "recovery-generation-invalid",
      "Recovery requires a full 64-character generation identifier",
      { detail: { generation: generation ?? null } },
    );
  }
  return withWriteLock({ home, fsApi }, async () => {
    const active = await readCurrentGeneration(home, { fsApi });
    const quarantineRoot = path.join(
      statePaths(home).quarantine,
      "generations",
    );
    const entries = await operation(fsApi, "readdir")(quarantineRoot, {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const matches = entries.filter((entry) =>
      entry.isDirectory() && entry.name.startsWith(`${generation}.`));
    if (matches.length !== 1) {
      throw new LodestarError(
        matches.length === 0
          ? "quarantined-generation-not-found"
          : "quarantined-generation-ambiguous",
        matches.length === 0
          ? "The requested generation is not present in quarantine"
          : "Multiple quarantined copies match the requested generation",
        {
          detail: {
            generation,
            matches: matches.map(({ name }) => name),
          },
        },
      );
    }
    const source = path.join(quarantineRoot, matches[0].name);
    const target = generationPaths(home, generation).root;
    if (await exists(target, fsApi)) {
      throw new LodestarError(
        "recovery-generation-exists",
        "The requested generation already exists in active history",
        { detail: { generation, target } },
      );
    }
    let moved = false;
    let promoted = false;
    try {
      await operation(fsApi, "rename")(source, target);
      moved = true;
      await inspectGeneration(home, generation, fsApi, { deep: true });
      if (promote) {
        await promoteGeneration({
          home,
          generation: { id: generation, root: target },
          fsApi,
        });
        promoted = true;
      }
      await appendRecoveryAudit({
        home,
        generation,
        previousGeneration: active.id,
        promoted: promote,
        now,
        fsApi,
      });
    } catch (error) {
      const rollbackErrors = [];
      if (promoted) {
        try {
          await promoteGeneration({ home, generation: active, fsApi });
        } catch (failure) {
          rollbackErrors.push(failure);
        }
      }
      if (moved) {
        try {
          await operation(fsApi, "rename")(target, source);
        } catch (failure) {
          rollbackErrors.push(failure);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new LodestarError(
          "quarantine-recovery-rollback-failed",
          "Quarantine recovery failed and prior state could not be restored",
          { cause: new AggregateError([error, ...rollbackErrors]) },
        );
      }
      throw wrapError(
        error,
        "quarantine-recovery-failed",
        "Unable to recover the quarantined generation",
        { generation },
      );
    }
    return {
      ok: true,
      recovered: true,
      generation,
      promoted: promote,
      previous_generation: active.id,
      source,
      destination: target,
      durability: {
        generations: await syncDirectoryAfterCommit(
          statePaths(home).generations,
          { fsApi },
        ),
        quarantine: await syncDirectoryAfterCommit(quarantineRoot, { fsApi }),
      },
    };
  });
}
