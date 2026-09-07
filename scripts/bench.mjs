// Benchmark probe: time start/find/links/get on a synthetic DB.
// Usage: node scripts/bench.mjs [recordCount]
// Note: find and links measure the full CLI envelope shape (normalized records,
// single pass). Earlier runs measured a lighter summary-only intermediate that
// the CLI then re-fetched, which understated the real find cost.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const load = (file) => import(pathToFileURL(path.join(ROOT, file)).href);
const { startProjection } = await load("src/agent-state.mjs");
const { openOrMigrateReadDatabase, openOrInitializeWriteDatabase } = await load(
  "src/database.mjs");
const { putRecord } = await load("src/records.mjs");
const { findRecords, linkedRecords } = await load("src/queries.mjs");

const count = Number(process.argv[2] ?? 300);
const directory = mkdtempSync(path.join(os.tmpdir(), "lodestar-bench-"));
const file = path.join(directory, "lodestar.db");
let json = null;
try {
  const db = await openOrInitializeWriteDatabase(file);
  for (let index = 0; index < count; index += 1) {
    putRecord(db, {
      id: `b:rec:${String(index).padStart(4, "0")}`,
      type: index % 3 === 0 ? "note" : "rule",
      name: `Bench record ${index}`,
      scope: "global",
      content: { state: "known", value: { text: `payload ${index} `.repeat(10) } },
      aliases: index % 2 === 0 ? [`bench-alias-${index}`] : [],
      links: index > 0 ? [{ relationship: "references", to_id: `b:rec:${String(index - 1).padStart(4, "0")}` }] : [],
      sources: index % 5 === 0 ? [{ origin: "bench", freshness: "current", metadata: { inspection: "not_inspected", via: "probe" } }] : [],
    }, {});
  }
  db.close();

  const identity = { session: "bench", agent: "probe", harness: "probe", actor: "bench" };
  const project = { id: "b:project", scope: "bench", name: "Bench", root: directory,
    cwd: directory, identity_source: "explicit", git_common_directory: null };
  const db2 = await openOrInitializeWriteDatabase(file);
  try {
    const times = {};
    for (const [name, fn] of [
      ["start", () => startProjection(db2, project, identity, { database: file })],
      ["find", () => findRecords(db2, "payload")],
      ["find-limited", () => findRecords(db2, "payload", { limit: 20 })],
      ["links", () => linkedRecords(db2, "b:rec:0000")],
    ]) {
      const startTime = process.hrtime.bigint();
      fn();
      times[name] = Number(process.hrtime.bigint() - startTime) / 1e6;
    }
    json = JSON.stringify({ count, ...times }, null, 2);
  } finally {
    db2.close();
  }
} finally {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {
    // Windows can hold the SQLite file briefly; cleanup is best-effort.
  }
}
if (json) console.log(json);
