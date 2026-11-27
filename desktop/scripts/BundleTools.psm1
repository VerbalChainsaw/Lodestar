Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$distributionModule = Join-Path $PSScriptRoot 'DistributionTools.psm1'
if (-not [IO.File]::Exists($distributionModule)) {
    $distributionModule = Join-Path $PSScriptRoot '../distribution/DistributionTools.psm1'
}
if (-not [IO.File]::Exists($distributionModule)) {
    throw "bundle_validator_missing: '$distributionModule'. Next action: use a complete verified source tree or distribution; preserve the current bundle and database."
}
Import-Module $distributionModule -Prefix Distribution -DisableNameChecking

function Get-BundlePaths([string]$Destination) {
    if (-not [IO.Path]::IsPathFullyQualified($Destination)) { throw 'Destination must be absolute.' }
    $target = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parent = [IO.Path]::GetDirectoryName($target)
    if (-not $parent -or -not [IO.Directory]::Exists($parent)) { throw 'Destination parent must exist.' }
    if ([IO.Path]::GetPathRoot($target).TrimEnd('\') -eq $target) { throw 'Destination cannot be a volume root.' }
    if ([IO.File]::Exists($target)) { throw 'Destination is a file, not a bundle directory.' }
    Assert-PlainPath $parent
    return [pscustomobject]@{ Target=$target; Parent=$parent; Stage="$target.lodestar-stage";
        Previous="$target.lodestar-previous"; Journal="$target.lodestar-journal.json" }
}

function Assert-PlainPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    $walk = $full
    while ($walk) {
        if ([IO.File]::Exists($walk) -or [IO.Directory]::Exists($walk)) {
            if (([IO.File]::GetAttributes($walk) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Reparse path is not allowed: $walk"
            }
        }
        $next = [IO.Path]::GetDirectoryName($walk)
        if (-not $next -or $next -eq $walk) { break }
        $walk = $next
    }
}

function Assert-Child([string]$Root, [string]$Path) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path)
    if (-not $full.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escaped the declared directory: $Path"
    }
    Assert-PlainPath $full
    return $full
}

function Get-PlainFiles([string]$Root) {
    Assert-PlainPath $Root
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $full = Assert-Child $Root $item
            if ([IO.Directory]::Exists($full)) { $pending.Push($full) }
            elseif ([IO.File]::Exists($full)) { $full }
            else { throw "Unsupported bundle item: $full" }
        }
    }
}

function Write-BundleReleaseNotes([string]$Root, [string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        throw "release_notes_version_invalid: exporting release notes requires a stable package version, found '$Version'. Next action: use the version from the packed core/package.json and include its matching docs/releases note."
    }
    $relative = "core/docs/releases/v$Version.md"
    $notes = Assert-Child $Root (Join-Path $Root $relative)
    $destination = Assert-Child $Root (Join-Path $Root 'RELEASE-NOTES.md')
    if (-not [IO.File]::Exists($notes)) {
        throw "release_notes_missing: exporting '$destination' requires '$notes'. Next action: include version-matched docs/releases/v$Version.md in the packed core before exporting the release notes index."
    }
    $index = "# Lodestar $Version release notes`n`n" +
        "Read the [complete release notes]($relative) for changes, compatibility, and installation guidance.`n`n" +
        "The complete notes and their linked guides are included under core/docs.`n"
    [IO.File]::WriteAllText($destination, $index, [Text.UTF8Encoding]::new($false))
}

function Get-RuntimeFiles([string]$Root) {
    $core = Join-Path $Root 'core'
    if (-not [IO.Directory]::Exists($core)) { throw 'Core directory is missing.' }
    $files = @()
    foreach ($file in @(Get-PlainFiles $Root)) {
        $relative = [IO.Path]::GetRelativePath($Root, $file).Replace('\','/')
        if ($relative.StartsWith('core/',[StringComparison]::Ordinal) -or
            ($relative -notmatch '/' -and $relative -match '^Lodestar\.Loader\.(exe|dll|pdb|deps\.json|runtimeconfig\.json)$')) {
            $files += [pscustomobject]@{ Relative=$relative; Full=$file }
        }
    }
    return @($files | Sort-Object Relative -CaseSensitive)
}

function Write-BundleManifest([string]$Root, [string]$SourceBase) {
    $files = @(Get-RuntimeFiles $Root)
    $entries = foreach ($item in $files) {
        [ordered]@{ path=$item.Relative; bytes=([IO.FileInfo]$item.Full).Length;
            sha256=(Get-FileHash -LiteralPath $item.Full -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $manifest = [ordered]@{ v=1; built_at=[DateTimeOffset]::UtcNow.ToString('o');
        source_base=$SourceBase; files=@($entries) }
    [IO.File]::WriteAllText((Join-Path $Root 'bundle-manifest.json'),
        ($manifest | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
}

function Resolve-StagedConfigPath([string]$Value, [string]$Stage, [string]$Final) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Contains([char]0)) { throw 'Config contains an invalid path.' }
    $resolved = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($Value)) { $Value } else { Join-Path $Final $Value }))
    $finalFull = [IO.Path]::GetFullPath($Final).TrimEnd('\')
    if ($resolved.StartsWith($finalFull + '\',[StringComparison]::OrdinalIgnoreCase)) {
        $relative = [IO.Path]::GetRelativePath($finalFull,$resolved)
        return Assert-Child $Stage (Join-Path $Stage $relative)
    }
    return $resolved
}

function Test-Bundle([string]$Root, [string]$Final=$Root, [switch]$SkipHelp) {
    if (-not [IO.Directory]::Exists($Root)) { throw "Bundle is missing: $Root" }
    Assert-PlainPath $Root
    $required = @('Lodestar.Loader.exe','Lodestar.Loader.dll','Lodestar.Loader.deps.json',
        'Lodestar.Loader.runtimeconfig.json','core/lodestar.mjs','core/package.json')
    $manifestPath = Join-Path $Root 'bundle-manifest.json'
    if (-not [IO.File]::Exists($manifestPath)) { throw 'Bundle manifest is missing.' }
    $manifest = Read-DistributionStrictJsonFile $manifestPath -Contract bundle
    if (($manifest.v -isnot [int] -and $manifest.v -isnot [long] -and $manifest.v -isnot [double]) -or $manifest.v -ne 1 -or $null -eq $manifest.files) {
        throw "bundle_manifest_invalid_shape: '$manifestPath'. Next action: restore the manifest and runtime from a verified bundle; preserve configuration and database."
    }
    $actual = @(Get-RuntimeFiles $Root)
    $listed = @($manifest.files)
    if ($actual.Count -ne $listed.Count) { throw 'Runtime inventory differs from manifest.' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $listed) {
        $name = [string]$entry.path
        if ($name -notmatch '^(core/.+|[^/]+)$' -or $name.Contains('\') -or
            @($name.Split('/')).Where({$_ -in @('', '.', '..')}).Count -gt 0 -or
            -not $seen.Add($name) -or [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
            $entry.bytes -isnot [long] -and $entry.bytes -isnot [int]) { throw "Invalid manifest entry: $name" }
        $full = Assert-Child $Root (Join-Path $Root $name.Replace('/','\'))
        if (-not [IO.File]::Exists($full) -or ([IO.FileInfo]$full).Length -ne [long]$entry.bytes -or
            (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine [string]$entry.sha256) {
            throw "Manifest hash or size differs: $name"
        }
    }
    foreach ($item in $actual) { if (-not $seen.Contains($item.Relative)) { throw "Unlisted runtime file: $($item.Relative)" } }
    foreach ($name in $required) { if (-not $seen.Contains($name)) { throw "Required runtime file missing: $name" } }
    $configPath = Join-Path $Root 'interfaces.json'
    if (-not [IO.File]::Exists($configPath)) { throw 'interfaces.json is missing.' }
    $config = Read-DistributionInterfaceConfigDocument $Root
    if ($config['loader'] -isnot [string] -or [string]::IsNullOrWhiteSpace($config['loader'])) {
        throw "config_invalid_field: '$configPath' loader. Next action: select Lodestar.Loader.exe in this verified bundle; preserve the database."
    }
    # Admit the actual store before remapping target-relative runtime paths to
    # a stage. The SQLite authority cannot belong to any copied/retired tree.
    $databaseValue=[string]$config.runtime.database
    $databaseAbsolute=[IO.Path]::GetFullPath($(if([IO.Path]::IsPathRooted($databaseValue)){$databaseValue}else{Join-Path $Final $databaseValue}))
    Assert-DistributionExternalDatabase $databaseAbsolute @($Root,$Final,"$Final.lodestar-stage","$Final.lodestar-previous")
    $node = Resolve-StagedConfigPath ([string]$config.runtime.node) $Root $Final
    $cli = Resolve-StagedConfigPath ([string]$config.runtime.cli) $Root $Final
    $database = Resolve-StagedConfigPath ([string]$config.runtime.database) $Root $Final
    $loader = Resolve-StagedConfigPath ([string]$config.loader) $Root $Final
    if (-not [IO.File]::Exists($node) -or -not [IO.File]::Exists($database) -or
        -not [IO.File]::Exists($cli) -or -not [IO.File]::Exists($loader)) { throw 'A configured Node, CLI, database, or loader path is missing.' }
    if ($cli -ine (Join-Path $Root 'core\lodestar.mjs') -or
        $loader -ine (Join-Path $Root 'Lodestar.Loader.exe')) { throw 'Config does not select this staged runtime.' }
    if (-not $SkipHelp) {
        $arguments = @($cli,'--help')
        $probe = Invoke-DistributionCleanNode $node $arguments
        $reply = Read-DistributionCliEnvelope $probe 'help' @('--help')
        if ($reply.Kind -ne 'success') {
            $action = if ($reply.Kind -eq 'error' -and $reply.Envelope.error['action'] -is [string]) {
                $reply.Envelope.error.action
            } else { 'Restore the selected runtime from a verified distribution and validate again; preserve the current bundle, configuration and database.' }
            $message = if ($reply.Kind -eq 'error') { $reply.Envelope.error.message } else { 'The selected core did not return one valid help envelope.' }
            throw "bundle_help_failed/$($reply.Code): $message Next action: $action"
        }
    }
    return [pscustomobject]@{ valid=$true; root=$Root; files=$actual.Count;
        manifest_sha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Read-BundleJournal($Paths) {
    $invalid = "bundle_journal_invalid: '$($Paths.Journal)'. Next action: preserve the journal and target/stage/previous files. Validate '$($Paths.Target)' with Build-Portable.ps1 -Mode Validate -Destination, then reconcile or restore the journal from known-good transaction evidence before Recover."
    if (-not [IO.File]::Exists($Paths.Journal)) { throw $invalid }
    Assert-PlainPath $Paths.Journal
    try { $journal = Read-DistributionStrictJsonFile $Paths.Journal -Contract journal }
    catch { throw $invalid }
    if ($journal -isnot [pscustomobject]) { throw $invalid }
    foreach ($field in @('v','id','target','stage','previous','stage_manifest_sha256')) {
        if (-not $journal.PSObject.Properties[$field]) { throw $invalid }
    }
    if (($journal.v -isnot [int] -and $journal.v -isnot [long]) -or $journal.v -ne 1 -or
        $journal.id -isnot [string] -or $journal.id -notmatch '\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\z' -or
        $journal.target -cne $Paths.Target -or $journal.stage -cne $Paths.Stage -or
        $journal.previous -cne $Paths.Previous -or
        ($null -ne $journal.stage_manifest_sha256 -and
            ($journal.stage_manifest_sha256 -isnot [string] -or $journal.stage_manifest_sha256 -notmatch '\A[0-9a-fA-F]{64}\z'))) { throw $invalid }
    if (-not $journal.PSObject.Properties['state']) {
        $journal | Add-Member -NotePropertyName state -NotePropertyValue 'active'
    }
    if ($journal.state -isnot [string] -or $journal.state -notin @('active','complete','retiring')) {
        throw $invalid
    }
    if ($journal.state -in @('complete','retiring')) {
        foreach ($field in @('target_manifest_sha256','previous_manifest_sha256','previous_inventory')) {
            if (-not $journal.PSObject.Properties[$field]) { throw $invalid }
        }
        if ($journal.target_manifest_sha256 -isnot [string] -or
            $journal.target_manifest_sha256 -notmatch '\A[0-9a-fA-F]{64}\z' -or
            $journal.stage_manifest_sha256 -cne $journal.target_manifest_sha256 -or
            ($null -ne $journal.previous_manifest_sha256 -and
                ($journal.previous_manifest_sha256 -isnot [string] -or $journal.previous_manifest_sha256 -notmatch '\A[0-9a-fA-F]{64}\z')) -or
            $journal.previous_inventory -isnot [array]) { throw $invalid }
    }
    return $journal
}

function Write-BundleJournal($Paths,$Journal) {
    $temporary = "$($Paths.Journal).$([guid]::NewGuid().ToString('N')).tmp"
    Assert-PlainPath $temporary
    $created = $false
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Journal | ConvertTo-Json -Depth 8))
        $stream = [IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        $created = $true
        try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        [IO.File]::Move($temporary,$Paths.Journal,$true)
    } finally {
        if ($created -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-BundleInventory([string]$Root) {
    Assert-PlainPath $Root
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    $entries = [Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            $full = Assert-Child $Root $item
            $relative = [IO.Path]::GetRelativePath($Root,$full).Replace('\','/')
            if ([IO.Directory]::Exists($full)) {
                $entries.Add([pscustomobject]@{ path=$relative; kind='directory' })
                $pending.Push($full)
            } elseif ([IO.File]::Exists($full)) {
                $entries.Add([pscustomobject]@{ path=$relative; kind='file'; bytes=([IO.FileInfo]$full).Length;
                    sha256=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() })
            } else { throw "Unsupported bundle item: $full" }
        }
    }
    return @($entries | Sort-Object path -CaseSensitive)
}

function Assert-RetirementInventory($Paths,$Journal,[bool]$AllowMissing) {
    $recorded = @($Journal.previous_inventory)
    $indexed = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $recorded) {
        $name = [string]$entry.path
        if (-not $name -or $name.Contains('\') -or
            @($name.Split('/')).Where({$_ -in @('', '.', '..')}).Count -gt 0 -or
            -not $indexed.TryAdd($name,$entry) -or $entry.kind -notin @('file','directory')) {
            throw "Invalid recorded previous entry: $name"
        }
        Assert-Child $Paths.Previous (Join-Path $Paths.Previous $name.Replace('/','\')) | Out-Null
        if ($entry.kind -eq 'file' -and
            ($entry.bytes -isnot [long] -and $entry.bytes -isnot [int] -or
             [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$')) {
            throw "Invalid recorded previous file: $name"
        }
    }
    $actual = @()
    if ([IO.Directory]::Exists($Paths.Previous)) { $actual = @(Get-BundleInventory $Paths.Previous) }
    foreach ($item in $actual) {
        $entry = $null
        if (-not $indexed.TryGetValue($item.path,[ref]$entry) -or $entry.path -cne $item.path -or $entry.kind -cne $item.kind -or
            ($item.kind -eq 'file' -and
             ([long]$entry.bytes -ne [long]$item.bytes -or
              [string]$entry.sha256 -ine [string]$item.sha256))) {
            throw "bundle_previous_changed: '$($item.path)' in '$($Paths.Previous)'. Next action: preserve the previous bundle and unexpected user files; reconcile them against '$($Paths.Journal)' before retrying update. The current target remains available."
        }
    }
    if (-not $AllowMissing -and $actual.Count -ne $recorded.Count) {
        throw "bundle_previous_changed: missing recorded entries in '$($Paths.Previous)'. Next action: preserve the current target and restore the missing previous entries from known-good retained bytes before retrying update. Journal: '$($Paths.Journal)'."
    }
}

function Complete-BundleTransaction($Paths,$Journal,$TargetCheck) {
    if ($TargetCheck.manifest_sha256 -cne $Journal.stage_manifest_sha256) {
        throw 'Current target does not match the sealed stage.'
    }
    if ([IO.Directory]::Exists($Paths.Stage)) { throw 'Stage still exists after swap.' }
    $Journal.state = 'complete'
    $Journal | Add-Member -NotePropertyName target_manifest_sha256 -NotePropertyValue $TargetCheck.manifest_sha256 -Force
    if ([IO.Directory]::Exists($Paths.Previous)) {
        $previousCheck = Test-Bundle $Paths.Previous $Paths.Target
        $Journal | Add-Member -NotePropertyName previous_manifest_sha256 -NotePropertyValue $previousCheck.manifest_sha256 -Force
        $Journal | Add-Member -NotePropertyName previous_inventory -NotePropertyValue @(Get-BundleInventory $Paths.Previous) -Force
    } else {
        $Journal | Add-Member -NotePropertyName previous_manifest_sha256 -NotePropertyValue $null -Force
        $Journal | Add-Member -NotePropertyName previous_inventory -NotePropertyValue @() -Force
    }
    Write-BundleJournal $Paths $Journal
}

function Invoke-BundleRetirePrevious($Paths) {
    $journal = Read-BundleJournal $Paths
    if ($journal.state -notin @('complete','retiring')) { throw 'Transaction is not complete.' }
    if ([IO.Directory]::Exists($Paths.Stage) -or [IO.File]::Exists($Paths.Stage)) {
        throw 'Stage exists during previous retirement.'
    }
    $targetCheck = Test-Bundle $Paths.Target
    if ($targetCheck.manifest_sha256 -cne $journal.target_manifest_sha256) {
        throw 'Target changed since successful transaction.'
    }
    if ($journal.state -eq 'complete') {
        if ([IO.Directory]::Exists($Paths.Previous)) {
            $previousCheck = Test-Bundle $Paths.Previous $Paths.Target
            if ($previousCheck.manifest_sha256 -cne $journal.previous_manifest_sha256) {
                throw 'Previous changed since successful transaction.'
            }
        } elseif ($journal.previous_manifest_sha256 -or @($journal.previous_inventory).Count) {
            throw 'Recorded previous bundle is missing.'
        }
        Assert-RetirementInventory $Paths $journal $false
        Assert-NotRunning $Paths
        $journal.state = 'retiring'
        Write-BundleJournal $Paths $journal
    } else {
        Assert-RetirementInventory $Paths $journal $true
        Assert-NotRunning $Paths
    }
    foreach ($entry in @($journal.previous_inventory | Where-Object kind -eq 'file')) {
        $file = Assert-Child $Paths.Previous (Join-Path $Paths.Previous $entry.path.Replace('/','\'))
        if ([IO.File]::Exists($file)) {
            if (([IO.FileInfo]$file).Length -ne [long]$entry.bytes -or
                (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine [string]$entry.sha256) {
                throw "Recorded previous file changed before retirement: $($entry.path)"
            }
            [IO.File]::Delete($file)
        }
    }
    foreach ($entry in @($journal.previous_inventory | Where-Object kind -eq 'directory' | Sort-Object { $_.path.Length } -Descending)) {
        $directory = Assert-Child $Paths.Previous (Join-Path $Paths.Previous $entry.path.Replace('/','\'))
        if ([IO.Directory]::Exists($directory)) { [IO.Directory]::Delete($directory,$false) }
    }
    if ([IO.Directory]::Exists($Paths.Previous)) { [IO.Directory]::Delete($Paths.Previous,$false) }
    [IO.File]::Delete($Paths.Journal)
}

function New-BundleTransaction($Paths) {
    if ([IO.File]::Exists($Paths.Journal)) {
        $journal = Read-BundleJournal $Paths
        if ($journal.state -notin @('complete','retiring')) {
            throw "Existing transaction artifact requires review: $($Paths.Journal)"
        }
        Invoke-BundleRetirePrevious $Paths
    }
    foreach ($path in @($Paths.Stage,$Paths.Previous,$Paths.Journal)) {
        if ([IO.Directory]::Exists($path) -or [IO.File]::Exists($path)) { throw "Existing transaction artifact requires review: $path" }
    }
    if ([IO.Directory]::Exists($Paths.Target)) { Test-Bundle $Paths.Target | Out-Null }
    $journal = [ordered]@{ v=1; id=[guid]::NewGuid().ToString('D'); target=$Paths.Target;
        stage=$Paths.Stage; previous=$Paths.Previous; state='active'; stage_manifest_sha256=$null }
    $stream = [IO.File]::Open($Paths.Journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($journal | ConvertTo-Json -Depth 5))
        $stream.Write($bytes,0,$bytes.Length)
    } finally { $stream.Dispose() }
    [IO.Directory]::CreateDirectory($Paths.Stage) | Out-Null
    return Read-BundleJournal $Paths
}

function Copy-BundlePreserved($Paths) {
    Read-BundleJournal $Paths | Out-Null
    if (-not [IO.Directory]::Exists($Paths.Target)) { return }
    foreach ($file in @(Get-PlainFiles $Paths.Target)) {
        $relative = [IO.Path]::GetRelativePath($Paths.Target,$file).Replace('\','/')
        if ($relative.StartsWith('core/',[StringComparison]::Ordinal) -or
            ($relative -notmatch '/' -and $relative -match '^Lodestar\.Loader\.(exe|dll|pdb|deps\.json|runtimeconfig\.json)$') -or
            $relative -eq 'bundle-manifest.json') { continue }
        $to = Assert-Child $Paths.Stage (Join-Path $Paths.Stage $relative.Replace('/','\'))
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        [IO.File]::Copy($file,$to,$false)
    }
}

function Seal-BundleStage($Paths) {
    $journal = Read-BundleJournal $Paths
    if ($journal.state -ne 'active') { throw 'Only an active transaction can seal a stage.' }
    $validated = Test-Bundle $Paths.Stage $Paths.Target
    if ([IO.Directory]::Exists($Paths.Target)) {
        $oldConfig = (Get-FileHash -LiteralPath (Join-Path $Paths.Target 'interfaces.json') -Algorithm SHA256).Hash
        $newConfig = (Get-FileHash -LiteralPath (Join-Path $Paths.Stage 'interfaces.json') -Algorithm SHA256).Hash
        if ($oldConfig -ne $newConfig) { throw 'Existing interfaces.json bytes changed in stage.' }
    }
    $journal.stage_manifest_sha256 = $validated.manifest_sha256
    Write-BundleJournal $Paths $journal
    return $validated
}

function Assert-NotRunning($Paths) {
    if (-not [IO.Directory]::Exists($Paths.Target) -and -not [IO.Directory]::Exists($Paths.Previous)) { return }
    Assert-DistributionBundleProcessesIdle @($Paths.Target,$Paths.Previous)
}

function Invoke-BundleSwap($Paths, [ValidateSet('None','BeforeSwap','AfterOldMoved','AfterNewMoved')][string]$InjectFailure='None',
    [switch]$SimulateInUse) {
    $journal = Read-BundleJournal $Paths
    if ($journal.state -ne 'active') { throw 'Only an active transaction can swap a stage.' }
    if (-not $journal.stage_manifest_sha256) { throw 'Stage has not been sealed.' }
    if ([IO.Directory]::Exists($Paths.Previous)) { throw 'Previous bundle already exists; preserve it before another replacement.' }
    $stageCheck = Test-Bundle $Paths.Stage $Paths.Target
    if ($stageCheck.manifest_sha256 -cne $journal.stage_manifest_sha256) { throw 'Sealed stage manifest changed.' }
    if ([IO.Directory]::Exists($Paths.Target)) {
        Test-Bundle $Paths.Target | Out-Null
        $oldConfig = (Get-FileHash -LiteralPath (Join-Path $Paths.Target 'interfaces.json') -Algorithm SHA256).Hash
        $newConfig = (Get-FileHash -LiteralPath (Join-Path $Paths.Stage 'interfaces.json') -Algorithm SHA256).Hash
        if ($oldConfig -ne $newConfig) { throw 'Destination config changed since staging.' }
    }
    if ($SimulateInUse) { throw 'Loader is running from the destination (test probe).' }
    Assert-NotRunning $Paths
    if ($InjectFailure -eq 'BeforeSwap') { throw 'Injected failure before swap.' }
    $movedOld = $false
    try {
        if ([IO.Directory]::Exists($Paths.Target)) {
            [IO.Directory]::Move($Paths.Target,$Paths.Previous)
            $movedOld = $true
        }
        if ($InjectFailure -eq 'AfterOldMoved') { throw 'Injected failure after old moved.' }
        [IO.Directory]::Move($Paths.Stage,$Paths.Target)
        if ($InjectFailure -eq 'AfterNewMoved') { throw 'Injected failure after new moved.' }
        $result = Test-Bundle $Paths.Target
        Complete-BundleTransaction $Paths $journal $result
        return $result
    } catch {
        $failure = $_
        if ($movedOld) {
            try {
                if ([IO.Directory]::Exists($Paths.Target) -and -not [IO.Directory]::Exists($Paths.Stage)) {
                    Assert-NotRunning $Paths
                    [IO.Directory]::Move($Paths.Target,$Paths.Stage)
                }
                if (-not [IO.Directory]::Exists($Paths.Target) -and [IO.Directory]::Exists($Paths.Previous)) {
                    [IO.Directory]::Move($Paths.Previous,$Paths.Target)
                }
                Test-Bundle $Paths.Target | Out-Null
            } catch { throw "Swap failed: $failure; rollback also failed: $_. Use -Mode Recover." }
        }
        throw $failure
    }
}

function Invoke-BundleRecover($Paths) {
    $journal = Read-BundleJournal $Paths
    if ($journal.state -eq 'retiring') {
        Invoke-BundleRetirePrevious $Paths
        return [pscustomobject]@{ state='target_valid'; target=$Paths.Target }
    }
    if ($journal.state -eq 'complete') {
        $targetCheck = Test-Bundle $Paths.Target
        if ($targetCheck.manifest_sha256 -cne $journal.target_manifest_sha256 -or
            [IO.Directory]::Exists($Paths.Stage)) { throw 'Completed transaction state changed.' }
        if ([IO.Directory]::Exists($Paths.Previous)) {
            $previousCheck = Test-Bundle $Paths.Previous $Paths.Target
            if ($previousCheck.manifest_sha256 -cne $journal.previous_manifest_sha256) {
                throw 'Completed previous bundle changed.'
            }
        } elseif ($journal.previous_manifest_sha256) { throw 'Completed previous bundle is missing.' }
        Assert-RetirementInventory $Paths $journal $false
        return [pscustomobject]@{ state='new_target_valid'; previous=$Paths.Previous }
    }
    $hasTarget = [IO.Directory]::Exists($Paths.Target)
    $hasPrevious = [IO.Directory]::Exists($Paths.Previous)
    if ($hasPrevious) {
        Test-Bundle $Paths.Previous $Paths.Target | Out-Null
        if ($hasTarget) {
            # A runtime hash failure can precede database admission. Refuse a
            # selected store/alias before the generic corrupt-target rollback
            # can move its authority into Stage or replace its configuration.
            $config = Read-DistributionInterfaceConfigDocument $Paths.Target
            $databaseValue = [string]$config.runtime.database
            $databaseAbsolute = [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($databaseValue)) { $databaseValue } else { Join-Path $Paths.Target $databaseValue }))
            Assert-DistributionExternalDatabase $databaseAbsolute @($Paths.Target,$Paths.Stage,$Paths.Previous)
            try { Test-Bundle $Paths.Target | Out-Null; $targetValid = $true }
            catch { $targetValid = $false }
            if (-not $targetValid) {
                if ([IO.Directory]::Exists($Paths.Stage)) { throw 'Invalid target and stage both exist; manual review required.' }
                Assert-NotRunning $Paths
                [IO.Directory]::Move($Paths.Target,$Paths.Stage)
                [IO.Directory]::Move($Paths.Previous,$Paths.Target)
                Test-Bundle $Paths.Target | Out-Null
                return [pscustomobject]@{ state='restored_previous'; retained=$Paths.Stage }
            }
            Complete-BundleTransaction $Paths $journal (Test-Bundle $Paths.Target)
            return [pscustomobject]@{ state='new_target_valid'; previous=$Paths.Previous }
        }
        Assert-NotRunning $Paths
        [IO.Directory]::Move($Paths.Previous,$Paths.Target)
        Test-Bundle $Paths.Target | Out-Null
        return [pscustomobject]@{ state='restored_previous'; retained=$Paths.Stage }
    }
    if ($hasTarget) { Test-Bundle $Paths.Target | Out-Null }
    if ([IO.Directory]::Exists($Paths.Stage)) {
        return [pscustomobject]@{ state='pre_swap_stage_retained'; stage=$Paths.Stage }
    }
    if ($hasTarget) {
        Complete-BundleTransaction $Paths $journal (Test-Bundle $Paths.Target)
        return [pscustomobject]@{ state='target_valid' }
    }
    throw 'Journal has no target, stage, or previous bundle.'
}

function Invoke-BundleDiscardStage($Paths) {
    $journal = Read-BundleJournal $Paths
    if ($journal.state -ne 'active') { throw 'Only an active pre-swap stage can be discarded.' }
    if ([IO.Directory]::Exists($Paths.Previous)) { throw 'Previous bundle exists; recovery is required.' }
    if ([IO.Directory]::Exists($Paths.Target)) { Test-Bundle $Paths.Target | Out-Null }
    if ([IO.Directory]::Exists($Paths.Stage)) {
        $stage = [IO.Path]::GetFullPath($Paths.Stage)
        if ($stage -cne $Paths.Stage -or [IO.Path]::GetDirectoryName($stage) -ine $Paths.Parent) {
            throw 'Stage path identity changed.'
        }
        @(Get-PlainFiles $stage) | Out-Null
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
    [IO.File]::Delete($Paths.Journal)
    return [pscustomobject]@{ state='stage_discarded'; target=$Paths.Target }
}

Export-ModuleMember -Function Get-BundlePaths,Assert-Child,Get-PlainFiles,Write-BundleReleaseNotes,Write-BundleManifest,Test-Bundle,
    New-BundleTransaction,Copy-BundlePreserved,Seal-BundleStage,Invoke-BundleSwap,
    Invoke-BundleRecover,Invoke-BundleDiscardStage,Invoke-BundleRetirePrevious,Assert-NotRunning
