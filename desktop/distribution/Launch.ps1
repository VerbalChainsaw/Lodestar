<#
.SYNOPSIS
Launches Lodestar Loader or Manager from this configured portable bundle.
.DESCRIPTION
Reads interfaces.json, preserves each process argument as a separate value, and starts the selected app.
Manager uses the configured Node executable and runs in the current console.
.PARAMETER Mode
Loader opens the WPF app; Manager opens the terminal menu.
.PARAMETER LaunchArguments
Additional arguments passed as individual values. For scripted use; the CMD launchers use defaults.
.PARAMETER DescribeOnly
Prints executable and argument values as JSON without starting either app.
.EXAMPLE
pwsh -NoProfile -File .\Launch.ps1 -Mode Loader
.EXAMPLE
pwsh -NoProfile -File .\Launch.ps1 -Mode Manager -DescribeOnly
#>
[CmdletBinding()]
param(
    [ValidateSet('Loader','Manager')][string]$Mode,
    [string[]]$LaunchArguments=@(),
    [switch]$DescribeOnly,
    [switch]$Help
)
if ($Help) { Get-Help $PSCommandPath -Detailed; return }
if (-not $Mode) { [Console]::Error.WriteLine("Launch stage 'mode_selection' failed: Mode is required. Next action: run Loader.cmd or Manager.cmd, or pass -Mode Loader / -Mode Manager to Launch.ps1."); exit 1 }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1') -Force }
catch { [Console]::Error.WriteLine("Launch $Mode stage 'module_loading' failed: $($_.Exception.Message) Next action: use a complete verified extraction containing DistributionTools.psm1; preserve the selected configuration and database."); exit 1 }
try {
    $config = Read-InterfaceConfig $PSScriptRoot
    $arguments = [Collections.Generic.List[string]]::new()
    if ($Mode -eq 'Manager') {
        $exe = Resolve-Node $config.Node
        $arguments.Add($config.Cli)
        $arguments.Add('manager')
        $arguments.Add('--interface-config')
        $arguments.Add($config.Path)
    } else {
        Assert-DesktopRuntime
        $exe = Join-Path $PSScriptRoot 'Lodestar.Loader.exe'
        if (-not [IO.File]::Exists($exe)) { throw 'Loader executable is missing.' }
        $arguments.Add('--interface-config')
        $arguments.Add($config.Path)
    }
    foreach ($argument in $LaunchArguments) { $arguments.Add($argument) }
    if ($DescribeOnly) {
        [pscustomobject]@{ executable=$exe; arguments=@($arguments); mode=$Mode } | ConvertTo-Json -Depth 5
        return
    }
    $start = [Diagnostics.ProcessStartInfo]::new($exe)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $false
    $start.WorkingDirectory = $(if ($Mode -eq 'Manager') { [IO.Path]::GetDirectoryName($config.Cli) } else { $PSScriptRoot })
    foreach ($argument in $arguments) { [void]$start.ArgumentList.Add($argument) }
    foreach ($key in @('CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_SESSION_ID','OPENCODE_SESSION_ID',
        'CODEX_AGENT_NAME','LODESTAR_AGENT','LODESTAR_HARNESS','LODESTAR_DB','NODE_OPTIONS','NODE_PATH')) {
        [void]$start.Environment.Remove($key)
    }
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Application process did not start.' }
    $managerExitCode = $null
    try {
        if ($Mode -eq 'Manager') {
            $process.WaitForExit()
            $managerExitCode = $process.ExitCode
        } elseif ($process.WaitForExit(1500)) {
            $exitCode = $process.ExitCode
            if ($exitCode -ne 0) { throw "Loader exited during startup with code $exitCode." }
            Write-Host 'Loader exited during startup (code 0).'
        } else {
            Write-Host "Loader started (process $($process.Id))."
        }
    } finally {
        $process.Dispose()
    }
    if ($Mode -eq 'Manager') { exit $managerExitCode }
} catch {
    $failure="Launch $Mode failed: $($_.Exception.Message)"
    if ($failure -notmatch 'Next action:') {
        $failure+=" Next action: inspect '$(Join-Path $PSScriptRoot 'interfaces.json')' and the selected runtime; preserve the configuration and database while correcting the named file or runtime."
    }
    [Console]::Error.WriteLine($failure)
    exit 1
}
