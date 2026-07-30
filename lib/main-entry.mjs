import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let executable = path.resolve(argv1);
  try {
    executable = realpathSync(executable);
  } catch {
    // Preserve direct execution behavior when the path cannot be canonicalized.
  }
  return importMetaUrl === pathToFileURL(executable).href;
}
