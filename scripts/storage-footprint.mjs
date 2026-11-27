import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const suffixes = { main: "", wal: "-wal", shm: "-shm", journal: "-journal" };
const readOnlyFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const same = (a, b) => a === b || (a && b && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs);

function stat(file) {
  try {
    const info = lstatSync(file, { bigint: true });
    if (!info.isFile()) throw new Error("Expected a regular file, not a link or directory.");
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("File size cannot be represented safely.");
    return info;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function storageFootprint(file) {
  const target = resolve(file);
  const observe = () => Object.fromEntries(Object.entries(suffixes)
    .map(([name, suffix]) => [name, stat(target + suffix)]));
  const before = observe();
  if (!before.main) throw new Error("SQLite file was not found.");
  const header = Buffer.alloc(100);
  const fd = openSync(target, readOnlyFlags);
  let count = 0;
  let stable = false;
  try {
    const opened = fstatSync(fd, { bigint: true });
    // Never read from a different file or a non-regular object after opening the path.
    if (opened.isFile() && same(before.main, opened)) {
      count = readSync(fd, header, 0, header.length, 0);
      const after = observe();
      stable = same(opened, fstatSync(fd, { bigint: true }))
        && Object.keys(suffixes).every(name => same(before[name], after[name]));
    }
  } finally {
    closeSync(fd);
  }
  const bytes = Object.fromEntries(Object.entries(before)
    .map(([name, info]) => [name, info ? Number(info.size) : 0]));
  const total = Object.values(bytes).reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(total)) throw new Error("Total file size cannot be represented safely.");
  const magic = count === 100 && header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"));
  const encoded = header.readUInt16BE(16);
  const pageBytes = encoded === 1 ? 65536 : encoded;
  const pageCount = header.readUInt32BE(28);
  const free = header.readUInt32BE(36);
  const pageSizeValid = pageBytes >= 512 && pageBytes <= 65536 && (pageBytes & (pageBytes - 1)) === 0;
  const anySidecar = before.wal || before.shm || before.journal;
  const headerCurrent = header.readUInt32BE(24) === header.readUInt32BE(92);
  let headerState = "consistent_fields";
  if (!stable) headerState = "changed_during_read";
  else if (!magic) headerState = "not_sqlite_header";
  else if (anySidecar) headerState = "sidecars_present";
  else if (!headerCurrent || !pageSizeValid || pageCount < 1 || free >= pageCount
    || pageCount * pageBytes !== bytes.main) headerState = "unverified_fields";
  return {
    v: 1, observation: stable ? "best_effort" : "changed_during_read",
    file_bytes: bytes, sampled_total_bytes: total,
    size_scope: "main_plus_named_sqlite_sidecars_only",
    sqlite_header: {
      state: headerState,
      ...(headerState === "consistent_fields" ? {
        page_bytes: pageBytes, allocated_pages: pageCount, free_pages: free,
        reusable_page_bytes_estimate: free * pageBytes,
      } : {}),
    },
    integrity: "not_checked",
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/storage-footprint.mjs <explicit SQLite file>");
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(storageFootprint(process.argv[2]), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ error: "storage_observation_failed", reason: error.code ?? error.message }));
      process.exitCode = 1;
    }
  }
}
