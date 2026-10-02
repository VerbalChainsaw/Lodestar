#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [string]$SourceRoot = ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))),
    [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') {
    throw 'Build the Windows x64 distribution on Windows x64.'
}
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'OutputDirectory must be new; release artifacts are never overwritten.' }
$version = (Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable semantic package version.' }
Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
$work = Join-Path ([IO.Path]::GetTempPath()) ('lodestar-release-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
$database = Join-Path $work 'build-only.db'
& $NodePath (Join-Path $source 'lodestar.mjs') --db $database init | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Disposable build store initialization failed.' }
$bundle = Join-Path $work "Lodestar-$version-win-x64"
& (Join-Path $PSScriptRoot 'Build-Portable.ps1') -Destination $bundle -SourceRoot $source -NodePath $NodePath -DatabasePath $database
if (-not (Test-Path -LiteralPath (Join-Path $bundle 'Lodestar.Loader.exe'))) { throw 'Portable build did not produce an application.' }
Test-Bundle $bundle | Out-Null
# These are generated files in this invocation's new bundle, never a user installation.
[IO.File]::Delete((Assert-Child $bundle (Join-Path $bundle 'interfaces.json')))
[IO.File]::Delete((Assert-Child $bundle (Join-Path $bundle 'Lodestar.Loader.pdb')))
foreach ($file in @(Get-PlainFiles (Join-Path $source 'desktop/distribution'))) {
    $relative = [IO.Path]::GetRelativePath((Join-Path $source 'desktop/distribution'), $file)
    $destination = Assert-Child $bundle (Join-Path $bundle $relative)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy($file, $destination, $false)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'BundleTools.psm1') -Destination $bundle
Copy-Item -LiteralPath (Join-Path $source 'LICENSE') -Destination $bundle
Write-BundleReleaseNotes $bundle $version
$sourceBase = (& git -C $source rev-parse HEAD 2>$null | Select-Object -First 1)
if ($LASTEXITCODE -ne 0) { $sourceBase = 'source-export' }
elseif (& git -C $source status --porcelain 2>$null) { $sourceBase += '-dirty' }
Write-BundleManifest $bundle $sourceBase
$entries = foreach ($file in @(Get-PlainFiles $bundle | Sort-Object)) {
    [ordered]@{ path=[IO.Path]::GetRelativePath($bundle,$file).Replace('\','/');
        bytes=([IO.FileInfo]$file).Length; sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
}
$manifest = [ordered]@{v=1;version=$version;source_base=$sourceBase;files=@($entries)}
[IO.File]::WriteAllText((Join-Path $bundle 'distribution-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Import-Module (Join-Path $bundle 'DistributionTools.psm1') -Force
Test-DistributionPayload $bundle | Out-Null
if (@($entries.path).Where({$_ -match '(^|/)(interfaces\.json|.*\.(db|db-wal|db-shm|pdb))$'}).Count) {
    throw 'A local configuration, database or debug artifact entered the distribution.'
}
[IO.Directory]::CreateDirectory($output) | Out-Null
$zip = Join-Path $output "Lodestar-$version-win-x64.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($bundle, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
Push-Location $source
try {
    $pack = & npm pack --json --ignore-scripts --offline --cache (Join-Path $work 'npm-cache') --pack-destination $output
    if ($LASTEXITCODE -ne 0) { throw 'CLI release packaging failed.' }
    $packed = ($pack -join "`n") | ConvertFrom-Json
} finally { Pop-Location }
$archives = @($zip, (Join-Path $output $packed[0].filename))
$sums = @($archives | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_) })
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.txt'), ($sums -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
[ordered]@{version=$version;source_base=$sourceBase;directory=$output;archives=$archives;build_workspace=$work} | ConvertTo-Json -Depth 5
