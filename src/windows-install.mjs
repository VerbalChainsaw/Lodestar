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

export function renderWslShim() {
  return `#!/usr/bin/env bash
set -euo pipefail

if [ ! -x /init ] || ! command -v cmd.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
  echo "LODESTAR ERROR: WSL /init, cmd.exe, and wslpath are required by the WSL shim" >&2
  exit 1
fi

WINDOWS_PROFILE_WIN="$(/init "$(command -v cmd.exe)" -- /d /c echo %USERPROFILE% 2>/dev/null | tr -d '\r')"
WINDOWS_PROFILE="$(wslpath -u "$WINDOWS_PROFILE_WIN")"
LODESTAR_HOME=""
NODE_BIN=""
for directory in "$WINDOWS_PROFILE"/.local/opt/node-*/node_modules/lodestar-agent-context; do
  if [ -f "$directory/lodestar.mjs" ]; then
    LODESTAR_HOME="$directory"
    break
  fi
done
for executable in "$WINDOWS_PROFILE"/.local/opt/node-*/node.exe; do
  if [ -f "$executable" ]; then
    NODE_BIN="$executable"
    break
  fi
done
if [ -z "$LODESTAR_HOME" ] || [ -z "$NODE_BIN" ]; then
  echo "LODESTAR ERROR: installed Windows Lodestar runtime not found" >&2
  exit 1
fi

LODESTAR_ENTRY_WIN="$(wslpath -w "$LODESTAR_HOME/lodestar.mjs")"
exec /init "$NODE_BIN" -- "$LODESTAR_ENTRY_WIN" "$@"
`;
}

async function installFileAtomically(target, text, mode) {
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, text, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
  await rename(temporary, target);
  await chmod(target, mode);
  return target;
}

export async function installWindowsPosixShim(target) {
  return await installFileAtomically(target, renderWindowsPosixShim(), 0o755);
}

export async function installWslShim(target) {
  return await installFileAtomically(target, renderWslShim(), 0o755);
}
