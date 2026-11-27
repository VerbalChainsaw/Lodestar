<#
.SYNOPSIS
Validates and stages a new extracted Lodestar release over an existing portable bundle.
.DESCRIPTION
Run this script from the new extracted release with -Destination pointing to the existing app folder.
The transaction retains the previous bundle and preserves interfaces.json. Recover checks or restores
an interrupted transaction through the packaged BundleTools module.
.PARAMETER Destination
Absolute path to the existing configured portable bundle. Defaults to this script's directory.
.PARAMETER Payload
Absolute path to the new extracted release. Defaults to this script's directory.
.PARAMETER Mode
Update stages and swaps; Recover examines an interrupted or completed transaction.
.EXAMPLE
pwsh -NoProfile -File .\Update.ps1 -Destination 'C:\Apps\Lodestar'
.EXAMPLE
pwsh -NoProfile -File .\Update.ps1 -Mode Recover -Destination 'C:\Apps\Lodestar'
#>
[CmdletBinding()]
param([string]$Payload,[string]$Destination,
    [ValidateSet('Update','Recover')][string]$Mode='Update',[switch]$Help)
if ($Help) { Get-Help $PSCommandPath -Detailed; return }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1') -Force }
catch { [Console]::Error.WriteLine("Update stage 'module_loading' failed: $($_.Exception.Message) Next action: use a complete verified extraction containing DistributionTools.psm1; preserve target, stage, previous, journal, configuration and database."); exit 1 }
$paths = $null

function Assert-UpdateIdle([string]$Target) {
    Assert-BundleProcessesIdle @($Target)
}

try {
    if (-not $Payload) { $Payload = $PSScriptRoot }
    if (-not $Destination) { $Destination = $PSScriptRoot }
    if (-not [IO.Path]::IsPathFullyQualified($Payload)) { throw 'Payload must be an absolute extracted release directory.' }
    if (-not [IO.Path]::IsPathFullyQualified($Destination)) { throw 'Destination must be an absolute portable bundle directory.' }
    $source = [IO.Path]::GetFullPath($Payload).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    Import-Module (Join-Path $PSScriptRoot 'InstallTools.psm1') -Force -DisableNameChecking
    $owned = Read-InstallReceipt $target
    if ($owned -and $owned.phase -ne 'uninstalled') {
        $installMode = if($Mode -eq 'Recover'){' -Mode Recover'}else{''}
        throw "owned_installation: '$target' has a per-user installation receipt. Next action: run pwsh -NoProfile -File `"$(Join-Path $PSScriptRoot 'Install.ps1')`"$installMode -Destination `"$target`" to reconcile application and owned registration together; use its selected database and configuration."
    }
    if ($Mode -eq 'Recover') {
        Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
        $paths = Get-BundlePaths $target
        Invoke-BundleRecover $paths | ConvertTo-Json -Depth 5
        return
    }
    if ($source -ieq $target -or $source.StartsWith($target + '\',[StringComparison]::OrdinalIgnoreCase) -or
        $target.StartsWith($source + '\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Payload and portable bundle must be separate directories.'
    }
    # Read only the configured selection before inspecting the database or
    # creating transaction state; a hand-edited payload selection is unsafe too.
    $selection = Read-InterfaceConfig $target
    Assert-ExternalDatabase $selection.Database @($target,"$target.lodestar-stage","$target.lodestar-previous",$source)
    $validated = Test-DistributionPayload $source
    Import-Module (Join-Path $source 'InstallTools.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $source 'BundleTools.psm1') -Force -DisableNameChecking
    $paths = Get-BundlePaths $target
    Test-Bundle $paths.Target | Out-Null
    $selection = Read-InterfaceConfig $target
    Assert-ExternalDatabase $selection.Database @($target,"$target.lodestar-stage","$target.lodestar-previous",$source)
    $installedVersion = (Read-StrictJsonFile (Join-Path $target 'core/package.json') -Contract package).version
    if ([version]$validated.version -lt [version]$installedVersion) {
        throw "install_downgrade_refused: candidate $($validated.version), installed $installedVersion. Next action: select the same or newer compatible release; preserve the selected database."
    }
    Invoke-InstallDatabase $source $selection.Node $selection.Database $false $false '' '' | Out-Null
    Assert-UpdateIdle $target
    $manifest = Read-StrictJsonFile (Join-Path $source 'distribution-manifest.json') -Contract distribution
    New-BundleTransaction $paths | Out-Null
    Copy-BundlePreserved $paths
    foreach ($entry in @($manifest.files)) {
        $from = Assert-Child $source (Join-Path $source ([string]$entry.path).Replace('/','\'))
        $to = Assert-Child $paths.Stage (Join-Path $paths.Stage ([string]$entry.path).Replace('/','\'))
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        [IO.File]::Copy($from,$to,$true)
        if ((Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash -ine [string]$entry.sha256) {
            throw "Staged distribution file differs from payload: $($entry.path)"
        }
    }
    [IO.File]::Copy((Join-Path $source 'distribution-manifest.json'),
        (Join-Path $paths.Stage 'distribution-manifest.json'),$true)
    if ((Get-FileHash -LiteralPath (Join-Path $paths.Stage 'distribution-manifest.json') -Algorithm SHA256).Hash -ine
        $validated.manifest_sha256) { throw 'Staged distribution manifest changed.' }
    Assert-UpdateIdle $target
    Invoke-InstallDatabase $paths.Stage $selection.Node $selection.Database $false $false '' '' | Out-Null
    Seal-BundleStage $paths | Out-Null
    $result = Invoke-BundleSwap $paths
    Write-Host "Updated Lodestar bundle. Previous version retained at $($paths.Previous)."
    $result | ConvertTo-Json -Depth 5
} catch {
    $failure = "Update failed: $($_.Exception.Message)."
    if ($_.Exception.Message.StartsWith('owned_installation:')) {
        # The per-user owner gives the complete recovery route. A completed
        # application journal does not authorize this portable entry point.
    } elseif ($paths -and [IO.File]::Exists($paths.Journal)) {
        $failure += " Transaction state is retained at $($paths.Journal). Run: pwsh -NoProfile -File `"$($PSCommandPath)`" -Mode Recover -Destination `"$($paths.Target)`". Review its reported target/stage/previous state before retrying."
    } else {
        $failure += ' No transaction was started; check the extracted release and destination, then retry.'
    }
    Write-Error $failure
    exit 1
}
