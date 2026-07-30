import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { wrapError } from "./errors.mjs";

const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  "EACCES",
  "EINVAL",
  "EISDIR",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

async function closeHandle(handle, target, phase) {
  try {
    await handle.close();
  } catch (error) {
    throw wrapError(
      error,
      "durability-close-failed",
      `Unable to close ${target} after a durability barrier`,
      { path: target, phase },
    );
  }
}

export async function syncFile(file, { fsApi = fs } = {}) {
  const open = operation(fsApi, "open");
  if (typeof open !== "function") {
    return { supported: false, reason: "open-unavailable" };
  }
  let handle;
  let result;
  let primaryError = null;
  try {
    // Windows requires a writable handle for FlushFileBuffers. The file is
    // already fully staged; r+ grants flush capability without truncation.
    handle = await open(file, "r+");
    if (typeof handle.sync !== "function") {
      result = { supported: false, reason: "sync-unavailable" };
    } else {
      await handle.sync();
      result = { supported: true };
    }
  } catch (error) {
    primaryError = wrapError(
      error,
      "file-sync-failed",
      `Unable to synchronize ${file}`,
      { path: file },
    );
  }
  let closeError = null;
  if (handle) {
    try {
      await closeHandle(handle, file, "file");
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw wrapError(
      new AggregateError([primaryError, closeError]),
      "file-sync-and-close-failed",
      `Unable to synchronize or close ${file}`,
      {
        path: file,
        sync_code: primaryError.code ?? null,
        close_code: closeError.code ?? null,
      },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result;
}

export async function syncDirectory(directory, { fsApi = fs } = {}) {
  const open = operation(fsApi, "open");
  if (typeof open !== "function") {
    return { supported: false, reason: "open-unavailable" };
  }
  let handle;
  let result;
  let primaryError = null;
  try {
    handle = await open(directory, "r");
    if (typeof handle.sync !== "function") {
      result = { supported: false, reason: "sync-unavailable" };
    } else {
      await handle.sync();
      result = { supported: true };
    }
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(error.code)) {
      result = { supported: false, reason: error.code };
    } else {
      primaryError = wrapError(
        error,
        "directory-sync-failed",
        `Unable to synchronize directory ${directory}`,
        { path: directory },
      );
    }
  }
  let closeError = null;
  if (handle) {
    try {
      await closeHandle(handle, directory, "directory");
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw wrapError(
      new AggregateError([primaryError, closeError]),
      "directory-sync-and-close-failed",
      `Unable to synchronize or close directory ${directory}`,
      {
        path: directory,
        sync_code: primaryError.code ?? null,
        close_code: closeError.code ?? null,
      },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result;
}

export async function durableBarrier({
  files = [],
  directories = [],
  fsApi = fs,
} = {}) {
  let fileSync = true;
  for (const file of [...new Set(files)].sort()) {
    const result = await syncFile(file, { fsApi });
    fileSync &&= result.supported;
  }
  let directorySync = true;
  const orderedDirectories = [...new Set(directories)]
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  for (const directory of orderedDirectories) {
    const result = await syncDirectory(directory, { fsApi });
    directorySync &&= result.supported;
  }
  return {
    level: fileSync
      ? directorySync ? "file-and-directory" : "file"
      : "rename-only",
    file_sync: fileSync,
    directory_sync: directorySync,
  };
}

export async function syncParent(file, options = {}) {
  return syncDirectory(path.dirname(file), options);
}

export async function syncDirectoryAfterCommit(
  directory,
  { fsApi = fs } = {},
) {
  try {
    const result = await syncDirectory(directory, { fsApi });
    return {
      ...result,
      committed: true,
      uncertain: !result.supported,
    };
  } catch (error) {
    return {
      supported: false,
      reason: error.code ?? "directory-sync-failed",
      committed: true,
      uncertain: true,
    };
  }
}

export async function syncParentAfterCommit(file, options = {}) {
  return syncDirectoryAfterCommit(path.dirname(file), options);
}

export async function probeDurability(
  home,
  { fsApi = fs, nonce = randomUUID } = {},
) {
  const file = path.join(home, `.durability-probe-${nonce()}`);
  let cleanupError = null;
  try {
    await operation(fsApi, "writeFile")(file, "lodestar-durability", {
      encoding: "utf8",
      flag: "wx",
    });
    const fileResult = await syncFile(file, { fsApi });
    const directoryResult = await syncDirectory(home, { fsApi });
    return {
      ok: fileResult.supported,
      level: fileResult.supported
        ? directoryResult.supported ? "file-and-directory" : "file"
        : "rename-only",
      file_sync: fileResult.supported,
      directory_sync: directoryResult.supported,
    };
  } catch (error) {
    return {
      ok: false,
      level: "unknown",
      file_sync: false,
      directory_sync: false,
      code: error.code ?? "durability-probe-failed",
    };
  } finally {
    try {
      await operation(fsApi, "unlink")(file);
    } catch (error) {
      if (error.code !== "ENOENT") cleanupError = error;
    }
    if (cleanupError) {
      throw wrapError(
        cleanupError,
        "durability-probe-cleanup-failed",
        "Unable to remove the Lodestar durability probe",
        { path: file },
      );
    }
  }
}
