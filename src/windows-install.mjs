import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { COMMANDS } from "./cli-commands.mjs";

const execFileAsync = promisify(execFile);
const PACKAGE_ENTRY = fileURLToPath(new URL("../lodestar.mjs", import.meta.url));
const bashLiteral = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

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

export function renderWindowsPosixShim({ node = process.execPath, entry = PACKAGE_ENTRY } = {}) {
  return `#!/usr/bin/env bash
set -euo pipefail

if ! command -v cygpath >/dev/null 2>&1; then
  echo "LODESTAR ERROR: cygpath is required by the Windows POSIX shim" >&2
  exit 1
fi

NODE_BIN_WIN=${bashLiteral(node)}
LODESTAR_ENTRY_WIN=${bashLiteral(entry)}
NODE_BIN="$(cygpath -u "$NODE_BIN_WIN")"
LODESTAR_ENTRY="$(cygpath -u "$LODESTAR_ENTRY_WIN")"
if [ ! -x "$NODE_BIN" ] || [ ! -f "$LODESTAR_ENTRY" ]; then
  echo "LODESTAR ERROR: selected Windows Lodestar installation is unavailable; reinstall its launcher." >&2
  exit 1
fi
MSYS2_ARG_CONV_EXCL='*' exec "$NODE_BIN_WIN" "$LODESTAR_ENTRY_WIN" "$@"
`;
}

export function renderWslShim({ node = process.execPath, entry = PACKAGE_ENTRY } = {}) {
  const cwdCommands = Object.entries(COMMANDS).filter(([, command]) => command.values.includes("--cwd"))
    .map(([name]) => name).join("|");
  const valueOptions = [...new Set(Object.values(COMMANDS).flatMap(({ values }) => values))].join("|");
  return `#!/usr/bin/env bash
set -euo pipefail

if [ ! -x /init ] || ! command -v cmd.exe >/dev/null 2>&1 || ! command -v wslpath >/dev/null 2>&1; then
  echo "LODESTAR ERROR: WSL /init, cmd.exe, and wslpath are required by the WSL shim" >&2
  exit 1
fi

NODE_BIN=${bashLiteral(node)}
LODESTAR_ENTRY_WIN=${bashLiteral(entry)}
if [ ! -f "$(wslpath -u "$NODE_BIN")" ] || [ ! -f "$(wslpath -u "$LODESTAR_ENTRY_WIN")" ]; then
  echo "LODESTAR ERROR: selected Windows Lodestar installation is unavailable; reinstall its launcher." >&2
  exit 1
fi
arguments=("$@")
command_name=""
saw_cwd=false
saw_home=false
saw_hermes_home=false
saw_codex_home=false
saw_claude_home=false
saw_opencode_root=false
saw_xdg_config_home=false
saw_database=false
option_end=\${#arguments[@]}
windows_path() {
  # Keep already-qualified Windows paths; resolve every Linux path, including
  # relative and not-yet-created files, against the actual WSL working directory.
  case "$1" in
    [a-zA-Z]:[\\\\/]*|\\\\\\\\*) printf '%s' "$1" ;;
    /*) wslpath -w "$1" ;;
    *) wslpath -w "$PWD/$1" ;;
  esac
}
check_database_path() {
  case "\${1,,}" in
    \\\\\\\\wsl.localhost\\\\*|\\\\\\\\wsl\$\\\\*|//wsl.localhost/*|//wsl\$/*)
      echo "LODESTAR ERROR: SQLite must remain on a Windows filesystem; use a Windows drive or /mnt/<drive> path." >&2
      exit 1 ;;
  esac
}
for ((index=0; index<\${#arguments[@]}; index++)); do
  option="\${arguments[$index]}"
  case "$option" in
    --) option_end=$index; break ;;
    --cwd|--home|--codex-home|--claude-home|--hermes-home|--opencode-root|--xdg-config-home|--file|--db|--source|--wsl-shim|--posix-shim)
      if ((index + 1 >= \${#arguments[@]})) || [[ "\${arguments[$((index + 1))]}" = --* ]]; then
        echo "LODESTAR ERROR: $option requires a path" >&2
        exit 1
      fi
      arguments[$((index + 1))]="$(windows_path "\${arguments[$((index + 1))]}")"
      case "$option" in
        --db) check_database_path "\${arguments[$((index + 1))]}"; saw_database=true ;;
        --source) check_database_path "\${arguments[$((index + 1))]}" ;;
        --cwd) saw_cwd=true ;;
        --home) saw_home=true; selected_home="\${arguments[$((index + 1))]}" ;;
        --hermes-home) saw_hermes_home=true ;;
        --codex-home) saw_codex_home=true ;;
        --claude-home) saw_claude_home=true ;;
        --opencode-root) saw_opencode_root=true ;;
        --xdg-config-home) saw_xdg_config_home=true ;;
      esac
      ((index += 1)) ;;
    ${valueOptions}) ((index += 1)) ;;
    -*) ;;
    *) [ -n "$command_name" ] || command_name="$option" ;;
  esac
done
defaults=()
case "$command_name" in
  ${cwdCommands}) [ "$saw_cwd" = true ] || defaults+=(--cwd "$(windows_path "$PWD")") ;;
esac
case "$command_name" in
  skills|setup)
    [ "$saw_home" = true ] || defaults+=(--home "$(windows_path "$HOME")")
    if [ "$saw_hermes_home" = false ]; then
      if [ "$saw_home" = true ]; then
        defaults+=(--hermes-home "$selected_home\\\\.hermes")
      else
        defaults+=(--hermes-home "$(windows_path "\${HERMES_HOME:-$HOME/.hermes}")")
      fi
    fi
    # An explicit home selects an isolated host layout. Only explicit per-host
    # options may override it; the caller's custom homes belong to another layout.
    if [ "$saw_home" = false ] && [ "$saw_codex_home" = false ] && [ -n "\${CODEX_HOME:-}" ]; then
      defaults+=(--codex-home "$(windows_path "$CODEX_HOME")")
    fi
    if [ "$saw_home" = false ] && [ "$saw_claude_home" = false ] && [ -n "\${CLAUDE_CONFIG_DIR:-}" ]; then
      defaults+=(--claude-home "$(windows_path "$CLAUDE_CONFIG_DIR")")
    fi
    if [ "$saw_home" = false ] && [ "$saw_xdg_config_home" = false ] && [ -n "\${XDG_CONFIG_HOME:-}" ]; then
      defaults+=(--xdg-config-home "$(windows_path "$XDG_CONFIG_HOME")")
    fi
    if [ "$saw_home" = false ] && [ "$saw_opencode_root" = false ] && [ -n "\${OPENCODE_CONFIG_DIR:-}" ]; then
      defaults+=(--opencode-root "$(windows_path "$OPENCODE_CONFIG_DIR/skills")")
    fi ;;
esac
# Put synthesized options before -- so positional data stays byte-for-byte intact.
arguments=("\${arguments[@]:0:$option_end}" "\${defaults[@]}" "\${arguments[@]:$option_end}")
if [ "$saw_database" = false ] && [ -n "\${LODESTAR_DB:-}" ]; then
  LODESTAR_DB="$(windows_path "$LODESTAR_DB")"
  check_database_path "$LODESTAR_DB"
  export LODESTAR_DB
  export WSLENV="\${WSLENV:+$WSLENV:}LODESTAR_DB/w"
fi
exec /init "$(wslpath -u "$NODE_BIN")" -- "$LODESTAR_ENTRY_WIN" "\${arguments[@]}"
`;
}

const installations = new Map();
async function installFileAtomically(target, text, mode, { expectedContent } = {}) {
  const key = path.resolve(target);
  const previous = installations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const directory = path.dirname(target);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    const existing = await readFile(target).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.equals(Buffer.from(text))) { await chmod(target, mode); return target; }
    if (existing !== null && (expectedContent === undefined || !existing.equals(Buffer.from(expectedContent)))) {
      throw Object.assign(new Error("Launcher differs from the accepted installation baseline; preserve and review it before replacement."),
        { code: "launcher_conflict", path: target });
    }
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode });
      await chmod(temporary, mode);
      await ensureWslExecutable(temporary);
      const stagedHandle = await open(temporary, "r+");
      try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }
      // The distribution owner supplies the exact inspected bytes. Keep a recovery
      // copy before publishing a replacement; an upgrade never discards local bytes.
      if (existing !== null) {
        const backup = `${target}.${randomUUID()}.bak`;
        await writeFile(backup, existing, { flag: "wx", mode });
        const backupHandle = await open(backup, "r+");
        try { await backupHandle.sync(); } finally { await backupHandle.close(); }
        if (!(await readFile(backup)).equals(existing)) {
          throw Object.assign(new Error("The launcher recovery copy does not match the accepted bytes; the launcher was not replaced."),
            { code: "launcher_backup_failed", path: target, backup });
        }
      }
      const current = await readFile(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing === null ? current !== null : !current?.equals(existing)) {
        throw Object.assign(new Error("The launcher changed while its replacement was being staged; the newer state was preserved."),
          { code: "launcher_conflict", path: target });
      }
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return target;
  });
  installations.set(key, operation);
  try { return await operation; }
  finally { if (installations.get(key) === operation) installations.delete(key); }
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
  const common = ["-d", wslTarget.distribution, "--exec"];
  await execFileAsync("wsl.exe", [...common, "chmod", "755", wslTarget.linuxPath], {
    windowsHide: true,
  });
  await execFileAsync("wsl.exe", [...common, "test", "-x", wslTarget.linuxPath], {
    windowsHide: true,
  });
}

export async function installWindowsPosixShim(target, options = {}) {
  return await installFileAtomically(target, renderWindowsPosixShim(options), 0o755, options);
}

export async function installWslShim(target, options = {}) {
  const installed = await installFileAtomically(target, renderWslShim(options), 0o755, options);
  await ensureWslExecutable(installed);
  return installed;
}
