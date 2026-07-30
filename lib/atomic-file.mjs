import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import {
  syncFile,
  syncParentAfterCommit,
} from "./durable-fs.mjs";
import { LodestarError, wrapError } from "./errors.mjs";

function operation(fsApi, name) {
  return fsApi[name] ?? fs[name];
}

async function removeIfPresent(file, fsApi) {
  await operation(fsApi, "unlink")(file).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function atomicError(error, code, message, file, phase) {
  return wrapError(error, code, message, {
    path: file,
    phase,
  });
}

export async function atomicWriteFile(
  file,
  content,
  {
    encoding = "utf8",
    fsApi = fs,
    nonce = randomUUID,
  } = {},
) {
  const token = nonce();
  const temporary = `${file}.tmp-${token}`;
  const displaced = `${file}.previous-${token}`;
  const writeFile = operation(fsApi, "writeFile");
  const rename = operation(fsApi, "rename");
  try {
    await writeFile(temporary, content, encoding);
    await syncFile(temporary, { fsApi });
  } catch (error) {
    let cleanupError = null;
    try {
      await removeIfPresent(temporary, fsApi);
    } catch (failure) {
      cleanupError = failure;
    }
    if (cleanupError) {
      throw new LodestarError(
        "atomic-cleanup-failed",
        `Unable to stage or clean up the replacement for ${file}`,
        {
          cause: new AggregateError([error, cleanupError]),
          detail: {
            path: file,
            phase: "stage-cleanup",
            cause_code: error.code ?? null,
            cleanup_code: cleanupError.code ?? null,
          },
        },
      );
    }
    throw atomicError(
      error,
      "atomic-write-temp-failed",
      `Unable to stage replacement for ${file}`,
      file,
      "stage",
    );
  }

  let directError = null;
  try {
    await rename(temporary, file);
    const directorySync = await syncParentAfterCommit(file, { fsApi });
    return {
      committed: true,
      file_sync: true,
      directory_sync: directorySync,
      cleanup: null,
    };
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) {
      try {
        await removeIfPresent(temporary, fsApi);
      } catch (cleanupError) {
        throw new LodestarError(
          "atomic-cleanup-failed",
          `Unable to replace ${file} or remove its staged replacement`,
          {
            cause: new AggregateError([error, cleanupError]),
            detail: {
              path: file,
              phase: "direct-replace-cleanup",
              cause_code: error.code ?? null,
              cleanup_code: cleanupError.code ?? null,
            },
          },
        );
      }
      throw atomicError(
        error,
        "atomic-replace-failed",
        `Unable to replace ${file}`,
        file,
        "direct-replace",
      );
    }
    directError = error;
  }

  let movedPrior = false;
  let committed = false;
  try {
    try {
      await rename(file, displaced);
      movedPrior = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(temporary, file);
    committed = true;
  } catch (error) {
    let restoreError = null;
    if (movedPrior) {
      try {
        await rename(displaced, file);
      } catch (failure) {
        restoreError = failure;
      }
    }
    let cleanupError = null;
    try {
      await removeIfPresent(temporary, fsApi);
    } catch (failure) {
      cleanupError = failure;
    }
    if (restoreError) {
      throw new LodestarError(
        "atomic-restore-failed",
        `Failed to replace ${file} and restore its prior contents`,
        {
          cause: new AggregateError(
            [error, restoreError, ...(cleanupError ? [cleanupError] : [])],
          ),
          detail: {
            path: file,
            phase: "restore-prior",
            cause_code: error.code ?? null,
            restore_code: restoreError.code ?? null,
            cleanup_code: cleanupError?.code ?? null,
          },
        },
      );
    }
    if (cleanupError) {
      throw new LodestarError(
        "atomic-cleanup-failed",
        `Unable to clean up after a failed replacement of ${file}`,
        {
          cause: new AggregateError([error, cleanupError]),
          detail: {
            path: file,
            phase: "fallback-cleanup",
            cause_code: error.code ?? null,
            cleanup_code: cleanupError.code ?? null,
          },
        },
      );
    }
    throw atomicError(
      error,
      "atomic-replace-failed",
      `Unable to replace ${file}; its prior contents were restored`,
      file,
      "fallback-replace",
    );
  }
  const directorySync = await syncParentAfterCommit(file, { fsApi });
  let cleanup = null;
  let cleanupDirectorySync = null;
  if (movedPrior) {
    try {
      await removeIfPresent(displaced, fsApi);
      cleanupDirectorySync = await syncParentAfterCommit(file, { fsApi });
    } catch (error) {
      cleanup = {
        ok: false,
        code: error.code ?? "atomic-displaced-cleanup-failed",
        path: displaced,
      };
    }
  }
  return {
    committed,
    file_sync: true,
    directory_sync: directorySync,
    cleanup,
    cleanup_directory_sync: cleanupDirectorySync,
    fallback_reason: directError?.code ?? null,
  };
}
