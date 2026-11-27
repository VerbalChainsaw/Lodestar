[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Destination,
    [ValidateSet('Build','Validate','Recover','DiscardStage')][string]$Mode='Build',
    [string]$SourceRoot,
    [string]$NodePath,
    [string]$DatabasePath
)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
$paths = Get-BundlePaths $Destination

if ($Mode -eq 'Validate') { Test-Bundle $paths.Target | ConvertTo-Json -Depth 5; exit 0 }
if ($Mode -eq 'Recover') { Invoke-BundleRecover $paths | ConvertTo-Json -Depth 5; exit 0 }
if ($Mode -eq 'DiscardStage') { Invoke-BundleDiscardStage $paths | ConvertTo-Json -Depth 5; exit 0 }

if (-not $SourceRoot) {
    $SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
}
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$project = Join-Path $source 'desktop\Lodestar.Loader\Lodestar.Loader.csproj'
if (-not [IO.File]::Exists($project) -or -not [IO.File]::Exists((Join-Path $source 'lodestar.mjs'))) {
    throw 'SourceRoot does not contain the Loader project and Lodestar CLI.'
}
if ([IO.Directory]::Exists($paths.Target)) {
    if ($NodePath -or $DatabasePath) {
        throw 'Existing interfaces.json is preserved byte-for-byte; NodePath and DatabasePath apply only to a new target.'
    }
} else {
    if (-not $NodePath -or -not $DatabasePath -or
        -not [IO.Path]::IsPathFullyQualified($NodePath) -or
        -not [IO.Path]::IsPathFullyQualified($DatabasePath)) {
        throw 'A new destination needs absolute NodePath and DatabasePath.'
    }
    $NodePath = (Resolve-Path -LiteralPath $NodePath).Path
    $DatabasePath = (Resolve-Path -LiteralPath $DatabasePath).Path
    if (-not [IO.File]::Exists($NodePath) -or -not [IO.File]::Exists($DatabasePath)) {
        throw 'NodePath and DatabasePath must name existing files.'
    }
}

$journal = New-BundleTransaction $paths
try {
    Copy-BundlePreserved $paths
    if (-not [IO.Directory]::Exists($paths.Target)) {
        $config = [ordered]@{ v=1; generation=[guid]::NewGuid().ToString('D');
            runtime=[ordered]@{ node=$NodePath; cli='core/lodestar.mjs'; database=$DatabasePath };
            loader='Lodestar.Loader.exe' }
        [IO.File]::WriteAllText((Join-Path $paths.Stage 'interfaces.json'),
            ($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    }
    $build = Assert-Child $paths.Stage (Join-Path $paths.Stage ('.lodestar-build-' + $journal.id))
    if ([IO.Directory]::Exists($build) -or [IO.File]::Exists($build)) { throw 'Transaction-specific build path already exists.' }
    [IO.Directory]::CreateDirectory($build) | Out-Null
    $feed = Assert-Child $build (Join-Path $build 'empty-feed')
    $publish = Assert-Child $build (Join-Path $build 'publish')
    $sourceProject = Join-Path $source 'desktop\Lodestar.Loader'
    $buildProjectRoot = Assert-Child $build (Join-Path $build 'source\Lodestar.Loader')
    [IO.Directory]::CreateDirectory($buildProjectRoot) | Out-Null
    foreach ($file in @(Get-PlainFiles $sourceProject)) {
        $relative = [IO.Path]::GetRelativePath($sourceProject,$file).Replace('\','/')
        if ($relative -match '^(bin|obj)/') { continue }
        $to = Assert-Child $buildProjectRoot (Join-Path $buildProjectRoot $relative.Replace('/','\'))
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        [IO.File]::Copy($file,$to,$false)
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $to -Algorithm SHA256).Hash) { throw "Source copy changed: $relative" }
    }
    $projectCopy = Join-Path $buildProjectRoot 'Lodestar.Loader.csproj'
    [IO.Directory]::CreateDirectory($feed) | Out-Null
    & dotnet restore $projectCopy --source $feed --verbosity quiet
    if ($LASTEXITCODE -ne 0) { throw "Offline Loader restore failed (exit $LASTEXITCODE)." }
    & dotnet publish $projectCopy -c Release --no-restore --no-self-contained -o $publish --verbosity minimal "-p:PathMap=$buildProjectRoot=/_/src/Lodestar.Loader"
    if ($LASTEXITCODE -ne 0) { throw "Loader publish failed (exit $LASTEXITCODE)." }
    foreach ($file in @(Get-PlainFiles $publish)) {
        $relative = [IO.Path]::GetRelativePath($publish,$file)
        if ($relative.Contains('\') -or $relative.Contains('/')) { throw 'Unexpected nested publish output.' }
        if ($relative -notmatch '^Lodestar\.Loader\.(exe|dll|pdb|deps\.json|runtimeconfig\.json)$') {
            throw "Unexpected Loader publish output requires an explicit runtime inventory decision: $relative"
        }
        [IO.File]::Copy($file,(Join-Path $paths.Stage $relative),$false)
    }
    Push-Location $source
    try {
        $packText = & npm pack --json --ignore-scripts --offline --cache (Join-Path $build 'npm-cache') --pack-destination $build
        if ($LASTEXITCODE -ne 0) { throw "Core npm pack failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    $pack = ($packText -join "`n") | ConvertFrom-Json
    if (@($pack).Count -ne 1 -or $pack[0].filename -notmatch '^[^/\\]+\.tgz$') { throw 'Unexpected npm pack result.' }
    $archive = Assert-Child $build (Join-Path $build $pack[0].filename)
    $members = @(& tar -tf $archive)
    if ($LASTEXITCODE -ne 0 -or $members.Count -eq 0) { throw 'Cannot list core archive.' }
    foreach ($member in $members) {
        if ($member -notmatch '^package/(?!/)' -or
            @($member.Split('/')).Where({$_ -in @('..','.')}).Count -gt 0 -or $member.Contains('\')) {
            throw "Core archive has an unsafe member: $member"
        }
    }
    $details = @(& tar -tvf $archive)
    if ($LASTEXITCODE -ne 0 -or $details.Count -ne $members.Count) { throw 'Cannot inspect core archive entry types.' }
    foreach ($detail in $details) {
        if ($detail -notmatch '^[-d]') { throw 'Core archive contains a link or unsupported entry type.' }
    }
    & tar -xf $archive -C $build
    if ($LASTEXITCODE -ne 0) { throw "Core extraction failed (exit $LASTEXITCODE)." }
    $package = Assert-Child $build (Join-Path $build 'package')
    if (-not [IO.Directory]::Exists($package)) { throw 'Core archive has no package directory.' }
    [IO.Directory]::Move($package,(Join-Path $paths.Stage 'core'))
    # This transaction-owned work directory is confined to the stage and never enters the bundle.
    @(Get-PlainFiles $build) | Out-Null
    Remove-Item -LiteralPath $build -Recurse -Force
    $sourceBase = (& git -C $source rev-parse HEAD 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $sourceBase -notmatch '^[0-9a-f]{40}$') { $sourceBase='unknown' }
    $dirty = & git -C $source status --porcelain 2>$null
    if ($LASTEXITCODE -eq 0 -and $dirty) { $sourceBase += '-dirty' }
    Write-BundleManifest $paths.Stage $sourceBase
    Seal-BundleStage $paths | Out-Null
    $result = Invoke-BundleSwap $paths
    $result | ConvertTo-Json -Depth 5
    exit 0
} catch {
    Write-Error "Build/update failed: $($_.Exception.Message). Existing target was preserved or rollback was attempted. Journal: $($paths.Journal). Inspect state and use -Mode Recover; -Mode DiscardStage applies only to an abandoned active stage."
    exit 1
}
