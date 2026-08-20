import { execFile } from "node:child_process";
import { chmod, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function pathExists(candidate) {
  try { await stat(candidate); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function resolveClientStateHome(home) {
  // A WSL UNC home is recognized before resolution. path.resolve only treats a
  // backslash as a separator on Windows, so resolving first turns the UNC string into a
  // relative path on Linux and macOS and silently loses the match. Joining through the
  // win32 API keeps the separator correct on every host.
  if (parseWslUncTarget(home)) return path.win32.join(home, ".local", "state");
  const resolved = path.resolve(home);
  if (parseWslUncTarget(resolved)) return path.join(resolved, ".local", "state");
  try {
    const linked = await realpath(path.join(resolved, ".lodestar"));
    const relative = path.relative(resolved, linked);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return path.join(resolved, ".local", "state");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return resolved;
}

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
arguments=("$@")
if [ "\${1:-}" = "skills" ] || [ "\${1:-}" = "agents" ]; then
  command_name="\${1:-}"
  saw_home=false
  saw_hermes_home=false
  for ((index=0; index<\${#arguments[@]}; index++)); do
    case "\${arguments[$index]}" in
      --cwd|--home|--hermes-home|--opencode-root)
        if ((index + 1 >= \${#arguments[@]})); then
          echo "LODESTAR ERROR: \${arguments[$index]} requires a path" >&2
          exit 1
        fi
        if [[ "\${arguments[$((index + 1))]}" = /* ]]; then
          arguments[$((index + 1))]="$(wslpath -w "\${arguments[$((index + 1))]}")"
        fi
        [ "\${arguments[$index]}" = "--home" ] && saw_home=true
        [ "\${arguments[$index]}" = "--hermes-home" ] && saw_hermes_home=true
        ((index += 1))
        ;;
    esac
  done
  if [ "$command_name" = "skills" ]; then
    [ "$saw_home" = true ] || arguments+=(--home "$(wslpath -w "$HOME")")
    [ "$saw_hermes_home" = true ] || arguments+=(--hermes-home "$(wslpath -w "$HOME/.hermes")")
  fi
fi
exec /init "$NODE_BIN" -- "$LODESTAR_ENTRY_WIN" "\${arguments[@]}"
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

export function parseWslUncTarget(target) {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\(.+)$/iu.exec(target);
  if (!match) return null;
  return {
    distribution: match[1],
    linuxPath: `/${match[2].replaceAll("\\", "/")}`,
  };
}

async function ensureWslExecutable(target) {
  const wslTarget = parseWslUncTarget(target);
  if (!wslTarget) return;
  const common = ["-d", wslTarget.distribution, "--"];
  await execFileAsync("wsl.exe", [...common, "chmod", "755", wslTarget.linuxPath], {
    windowsHide: true,
  });
  await execFileAsync("wsl.exe", [...common, "test", "-x", wslTarget.linuxPath], {
    windowsHide: true,
  });
}

export async function installWindowsPosixShim(target) {
  return await installFileAtomically(target, renderWindowsPosixShim(), 0o755);
}

export async function installWslShim(target) {
  const installed = await installFileAtomically(target, renderWslShim(), 0o755);
  await ensureWslExecutable(installed);
  return installed;
}
