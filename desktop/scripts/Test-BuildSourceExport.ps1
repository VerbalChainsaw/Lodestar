#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$SourceRoot,
    [string]$NodePath=(Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $SourceRoot).Path
$script=Join-Path $PSScriptRoot 'Build-Portable.ps1'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('lodestar-export-build-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
try {
    & git -C $source rev-parse HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'Fixture must be a source export without Git metadata.' }
    $database=Join-Path $testRoot 'disposable.db'
    & $NodePath (Join-Path $source 'lodestar.mjs') --db $database init | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable store initialization failed.' }
    $target=Join-Path $testRoot 'app'
    $wrapper=Join-Path $testRoot 'caller.ps1'
    [IO.File]::WriteAllText($wrapper,@'
param($BuildScript,$Destination,$SourceRoot,$NodePath,$DatabasePath,$Mode='Build')
$global:LASTEXITCODE=9
& $BuildScript -Mode $Mode -Destination $Destination -SourceRoot $SourceRoot -NodePath $NodePath -DatabasePath $DatabasePath
exit $LASTEXITCODE
'@,[Text.UTF8Encoding]::new($false))
    & pwsh -NoProfile -File $wrapper -BuildScript $script -Destination $target -SourceRoot $source -NodePath $NodePath -DatabasePath $database *> (Join-Path $testRoot 'build.log')
    $buildExit=$LASTEXITCODE
    $manifest=Get-Content -LiteralPath (Join-Path $target 'bundle-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.source_base -ne 'unknown') { throw 'Export metadata fallback changed.' }
    if ($buildExit -ne 0) { throw "Validated export build returned exit $buildExit. Evidence: $testRoot" }
    foreach ($mode in @('Validate','Recover','DiscardStage')) {
        if ($mode -eq 'DiscardStage') {
            Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
            New-BundleTransaction (Get-BundlePaths $target) | Out-Null
        }
        & pwsh -NoProfile -File $wrapper -BuildScript $script -Mode $mode -Destination $target -SourceRoot $source -NodePath $NodePath -DatabasePath $database *> (Join-Path $testRoot ($mode+'.log'))
        if ($LASTEXITCODE -ne 0) { throw "Successful $mode inherited caller exit $LASTEXITCODE. Evidence: $testRoot" }
    }
    & pwsh -NoProfile -File $script -Destination (Join-Path $testRoot 'bad-app') -SourceRoot (Join-Path $testRoot 'missing-source') -NodePath $NodePath -DatabasePath $database *> (Join-Path $testRoot 'negative.log')
    if ($LASTEXITCODE -eq 0) { throw 'Invalid source build falsely returned success.' }
    [pscustomobject]@{passed=5;failed=0;source_export_build_exit=$buildExit;successful_modes=@('Build','Validate','Recover','DiscardStage');invalid_source_rejected=$true} | ConvertTo-Json
    $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if (-not $resolved.StartsWith($temp+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'lodestar-export-build-*') { throw 'Fixture cleanup containment changed.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    exit 0
} catch {
    [pscustomobject]@{passed=0;failed=1;error=$_.Exception.Message;artifacts=$testRoot} | ConvertTo-Json
    exit 1
}
