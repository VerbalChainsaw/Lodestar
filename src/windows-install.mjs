import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { SCHEMA_VERSION } from "./schema.mjs";
import { LODESTAR_VERSION } from "./version.mjs";

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

export function renderWindowsServiceBootstrap({
  packageVersion = LODESTAR_VERSION,
} = {}) {
  return `param(
  [Parameter(Position = 0)]
  [ValidateSet("ensure")]
  [string]$Command = "ensure",
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Options
)

$ErrorActionPreference = "Stop"
if ($Options.Count -ne 1 -or $Options[0] -ne "--json") {
  throw "Supported syntax: ensure --json"
}
$root = Join-Path $env:LOCALAPPDATA "Lodestar"
$discoveryPath = Join-Path $root "service.json"
$expectedApi = 1
$expectedSchema = ${SCHEMA_VERSION}
$expectedPackage = "${packageVersion}"

function Read-Discovery {
  if (-not [IO.File]::Exists($discoveryPath)) { return $null }
  try { return [IO.File]::ReadAllText($discoveryPath) | ConvertFrom-Json }
  catch { return $null }
}

function Read-Health([object]$discovery) {
  if ($null -eq $discovery -or $discovery.endpoint -notmatch '^http://127\\.0\\.0\\.1:[0-9]+$') {
    return $null
  }
  try {
    $health = Invoke-RestMethod -Method Get -Uri "$($discovery.endpoint)/healthz" -TimeoutSec 2
    if (
      $health.ok -ne $true -or
      $health.apiVersion -ne $expectedApi -or
      $health.schemaVersion -ne $expectedSchema -or
      $health.packageVersion -ne $expectedPackage -or
      $health.databaseInstanceId -notmatch '^[0-9a-f]{64}$' -or
      $health.databaseInstanceId -ne $discovery.databaseInstanceId
    ) { return $null }
    return $health
  } catch { return $null }
}

$prior = Read-Discovery
$priorIdentity = if ($null -ne $prior) { $prior.databaseInstanceId } else { $null }
$health = Read-Health $prior
if ($null -eq $health) {
  $nodePath = $null
  $entryPath = $null
  $candidates = Get-ChildItem -Path (Join-Path $env:USERPROFILE ".local\\opt\\node-*\\node.exe") -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending
  foreach ($candidate in $candidates) {
    $entry = Join-Path $candidate.DirectoryName "node_modules\\lodestar-agent-context\\lodestar.mjs"
    if ([IO.File]::Exists($entry)) {
      $nodePath = $candidate.FullName
      $entryPath = $entry
      break
    }
  }
  if ($null -eq $nodePath) { throw "Pinned Windows Lodestar runtime not found" }
  $process = Start-Process -FilePath $nodePath -ArgumentList @($entryPath, "serve", "--port", "0") -WindowStyle Hidden -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $current = Read-Discovery
    $health = Read-Health $current
  } while ($null -eq $health -and [DateTime]::UtcNow -lt $deadline -and -not $process.HasExited)
  if ($null -eq $health) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    throw "Windows Lodestar service did not become healthy"
  }
  if ($null -ne $priorIdentity -and $health.databaseInstanceId -ne $priorIdentity) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Lodestar database identity changed across service restart"
  }
  $prior = $current
}

$result = [ordered]@{
  endpoint = $prior.endpoint
  pid = $prior.pid
  apiVersion = $health.apiVersion
  schemaVersion = $health.schemaVersion
  packageVersion = $health.packageVersion
  databaseInstanceId = $health.databaseInstanceId
}
$result | ConvertTo-Json -Compress
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

export async function installWindowsServiceBootstrap(target) {
  return await installFileAtomically(
    target,
    renderWindowsServiceBootstrap(),
    0o600,
  );
}
