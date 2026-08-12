import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function renderWindowsPosixShim() {
  return `#!/usr/bin/env bash
set -euo pipefail

if ! command -v cygpath >/dev/null 2>&1; then
  echo "LODESTAR ERROR: cygpath is required by the Windows POSIX shim" >&2
  exit 1
fi

if [ -z "\${LODESTAR_HOME:-}" ]; then
  for directory in "$HOME"/.local/opt/node-*/node_modules/lodestar-agent-context; do
    if [ -f "$directory/lodestar.mjs" ]; then
      LODESTAR_HOME="$directory"
      break
    fi
  done
fi

if [ -z "\${LODESTAR_HOME:-}" ] || [ ! -f "$LODESTAR_HOME/lodestar.mjs" ]; then
  echo "LODESTAR ERROR: lodestar.mjs not found. Set LODESTAR_HOME or reinstall Lodestar." >&2
  exit 1
fi

NODE_BIN=""
for executable in "$HOME"/.local/opt/node-*/node.exe; do
  if [ -x "$executable" ]; then
    NODE_BIN="$executable"
    break
  fi
done
if [ -z "$NODE_BIN" ]; then
  echo "LODESTAR ERROR: pinned Windows node.exe not found" >&2
  exit 1
fi

NODE_BIN_WIN="$(cygpath -aw "$NODE_BIN")"
LODESTAR_ENTRY_WIN="$(cygpath -aw "$LODESTAR_HOME/lodestar.mjs")"
MSYS2_ARG_CONV_EXCL='*' exec "$NODE_BIN_WIN" "$LODESTAR_ENTRY_WIN" "$@"
`;
}

export async function installWindowsPosixShim(target) {
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, renderWindowsPosixShim(), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o755,
  });
  await rename(temporary, target);
  await chmod(target, 0o755);
  return target;
}
