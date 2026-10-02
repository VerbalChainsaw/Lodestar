<#
.SYNOPSIS
Configures a clean extracted Lodestar Loader and Manager bundle.
.DESCRIPTION
Validates the release and installed runtimes, then selects an existing Lodestar database read-only.
An absent database is created only with -InitializeDatabase. Existing interfaces.json is never replaced.
.PARAMETER NodePath
Absolute path to node.exe, version 24.15.0 or newer. Defaults to node on PATH.
.PARAMETER DatabasePath
Absolute path to a database outside the app folder. Defaults to an existing LOCALAPPDATA Lodestar store, or prompts.
.PARAMETER InitializeDatabase
Explicitly creates a new store at an absent DatabasePath.
.EXAMPLE
pwsh -NoProfile -File .\Setup.ps1 -DatabasePath 'C:\Data\lodestar.db'
.EXAMPLE
pwsh -NoProfile -File .\Setup.ps1 -DatabasePath 'C:\Data\new-lodestar.db' -InitializeDatabase
#>
[CmdletBinding()]
param(
    [string]$NodePath,
    [string]$DatabasePath,
    [switch]$InitializeDatabase,
    [switch]$Help
)
if ($Help) { Get-Help $PSCommandPath -Detailed; return }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1') -Force }
catch { [Console]::Error.WriteLine("Setup stage 'module_loading' failed: $($_.Exception.Message) Next action: use a complete verified extraction containing DistributionTools.psm1; preserve the current configuration and database."); exit 1 }
$database = $null
$initAttempted = $false
$initConfirmed = $false
$initRejected = $false
$stage = 'payload_validation'

function Format-SetupError($CoreError,[string]$DefaultAction) {
    # Invoke-CleanNode has already bounded the complete response. Retain the
    # accepted core guidance; additional substring limits erase recovery steps.
    $jsonOptions=[System.Text.Json.JsonSerializerOptions]::new()
    $jsonOptions.MaxDepth=1024
    $action=if ($CoreError['action'] -is [string] -and $CoreError.action) { $CoreError.action }
        elseif ($null -ne $CoreError['action'] -and $CoreError['action'] -isnot [string]) { [System.Text.Json.JsonSerializer]::Serialize[object]($CoreError['action'],$jsonOptions) }
        else { $DefaultAction }
    $identifiers=if ($CoreError.Contains('identifiers')) {
        ' Identifiers: '+[System.Text.Json.JsonSerializer]::Serialize[object]($CoreError['identifiers'],$jsonOptions)
    } else { '' }
    "$($CoreError.code): $($CoreError.message)$identifiers Next action: $action"
}

function Read-SetupResult($Result,[string]$Operation,[string[]]$Arguments,[bool]$IsWrite) {
    $parsed = Read-CliEnvelope $Result $Operation $Arguments $IsWrite
    if ($parsed.Diagnostics) { Write-Warning "Lodestar $Operation diagnostics: $($parsed.Diagnostics)." }
    if ($parsed.Kind -eq 'transport_error') {
        if ($parsed.MayHaveCommitted -and $parsed.Envelope -and $parsed.Envelope['error']) {
            throw (Format-SetupError $parsed.Envelope.error 'Inspect the original request, receipt and current database state before repeating initialization.')
        }
        throw "$($parsed.Code): $Operation response could not be confirmed. Next action: inspect the selected runtime and read current database state before repeating initialization."
    }
    if ($parsed.Kind -eq 'error') {
        if ($Operation -eq 'init') { $script:initRejected=$true }
        throw (Format-SetupError $parsed.Envelope.error 'Inspect the named error using Lodestar doctor with the configured executable and database; preserve current files.')
    }
    return $parsed.Envelope
}

try {
    $configPath = Join-Path $PSScriptRoot 'interfaces.json'
    if ([IO.File]::Exists($configPath)) { throw "config_exists: '$configPath'. Setup never overwrites configuration. Next action: launch the configured bundle, correct its selected paths, or configure a fresh verified extraction using the existing database." }
    Test-DistributionPayload $PSScriptRoot | Out-Null
    $stage = 'runtime_validation'
    Assert-DesktopRuntime
    $node = Resolve-Node $NodePath
    $stage = 'database_selection'
    if (-not $DatabasePath) {
        $standard = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Lodestar\lodestar.db' } else { $null })
        if ($standard -and [IO.File]::Exists($standard) -and -not $InitializeDatabase) {
            $DatabasePath = $standard
        } else {
            $DatabasePath = Read-Host 'Absolute path to an existing Lodestar database (or a new path with -InitializeDatabase)'
        }
    }
    if (-not [IO.Path]::IsPathFullyQualified($DatabasePath)) { throw 'DatabasePath must be absolute.' }
    $database = [IO.Path]::GetFullPath($DatabasePath)
    Assert-PlainPath $database
    $appRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
    Assert-ExternalDatabase $database @($appRoot,"$appRoot.lodestar-stage","$appRoot.lodestar-previous") 'Place the database outside the app folder and its update folders; select an external absolute DatabasePath.'
    if ([IO.Directory]::Exists($database)) { throw 'DatabasePath names a directory.' }
    $cli = Join-Path $PSScriptRoot 'core\lodestar.mjs'
    if ($InitializeDatabase) {
        if ([IO.File]::Exists($database)) { throw '-InitializeDatabase requires a new, absent database path.' }
        if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($database))) {
            throw 'The parent directory for a new database must already exist.'
        }
        $initAttempted = $true
        $stage = 'database_initialization'
        try { $initResult = Invoke-CleanNode $node @($cli,'init','--db',$database) }
        catch { if ($_.Exception.Data['Dispatched'] -eq $false) { $initAttempted=$false }; throw }
        $null=Read-SetupResult $initResult 'init' @('init','--db',$database) $true
        $initConfirmed = $true
    } elseif (-not [IO.File]::Exists($database)) {
        throw 'Database does not exist. Use -InitializeDatabase explicitly to create a new store.'
    }
    # Doctor opens the existing SQLite file read-only and checks its schema and integrity.
    $stage = 'database_validation'
    $doctorResult = Invoke-CleanNode $node @($cli,'doctor','--db',$database)
    $doctor = Read-SetupResult $doctorResult 'doctor' @('doctor','--db',$database) $false
    if ($doctor.data['healthy'] -ne $true) {
        $issues=$doctor.data['issues']
        $guidance=($issues | ConvertTo-Json -Depth 32 -Compress)
        throw "database_unhealthy: existing database failed read-only doctor validation. Identifiers and core guidance: $guidance Next action: preserve the database and follow the named doctor action; use Install -MigrateDatabase only for an inspected schema4 conversion with a verified independent backup."
    }
    $stage = 'configuration_write'
    $config = [ordered]@{ v=1; generation=[guid]::NewGuid().ToString('D');
        runtime=[ordered]@{ node=$node; cli='core/lodestar.mjs'; database=$database };
        loader='Lodestar.Loader.exe' }
    $temp = Join-Path $PSScriptRoot ('.interfaces-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($config | ConvertTo-Json -Depth 8))
        $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
        [IO.File]::Move($temp,$configPath,$false)
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
    Write-Host "Configured Loader and Manager. Database: $database"
} catch {
    $failure = "Setup stage '$stage' failed: $($_.Exception.Message)"
    if ($initAttempted) {
        $outcome = if ($initConfirmed) { 'Initialization was confirmed; a later setup step failed.' }
            elseif ($initRejected) { 'Initialization was rejected; creation was not confirmed. Correct the reported error before a new attempt.' }
            else { 'Initialization was dispatched; its outcome is unconfirmed.' }
        $readArgs = @($cli,'doctor','--db',$database) | ConvertTo-Json -Compress
        if ($initRejected) {
            $failure += " $outcome Preserve '$database' if it exists; inspect it with '$node' and literal arguments $readArgs before any further initialization. If it is absent, correct the rejection above before explicitly choosing to create a new store."
        } else {
            $failure += " $outcome Preserve '$database'. Next action: invoke '$node' with literal argument array $readArgs. After successful read-only validation, run Setup without -InitializeDatabase in a fresh verified extraction if needed."
        }
    } elseif ($failure -notmatch 'Next action:') {
        $failure += ' Next action: correct the named path or runtime and rerun Setup with the existing database; preserve configuration and database files.'
    }
    [Console]::Error.WriteLine($failure)
    exit 1
}
