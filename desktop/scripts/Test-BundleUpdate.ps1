[CmdletBinding()]
param([switch]$KeepArtifacts,[string]$CaseFilter='*')
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$lodestarTestParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = [IO.Path]::GetFullPath((Join-Path $lodestarTestParent ('.bundle-update-test-' + [guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($lodestarTestParent + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test root escaped its temporary parent.' }
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$results = @()

function Assert-That([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Write-FixtureRuntime([string]$Root,[string]$Version) {
    [IO.Directory]::CreateDirectory((Join-Path $Root 'core')) | Out-Null
    foreach ($name in @('Lodestar.Loader.exe','Lodestar.Loader.dll','Lodestar.Loader.deps.json','Lodestar.Loader.runtimeconfig.json')) {
        [IO.File]::WriteAllText((Join-Path $Root $name),"$Version $name",[Text.UTF8Encoding]::new($false))
    }
    $help = @{v=5;ok=$true;operation='help';data=@{name='lodestar';version=$Version};
        revision=$null;database_instance_id=$null;database_epoch=$null;more=$false;next=@()} | ConvertTo-Json -Depth 5 -Compress
    [IO.File]::WriteAllText((Join-Path $Root 'core\lodestar.mjs'),"console.log('$help');",[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $Root 'core\package.json'),'{}',[Text.UTF8Encoding]::new($false))
    Write-BundleManifest $Root "fixture-$Version"
}
function New-Fixture([string]$Name) {
    $case = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory($case) | Out-Null
    $db = Join-Path $case 'fixture.db'
    [IO.File]::WriteAllText($db,'read-only fixture',[Text.UTF8Encoding]::new($false))
    $paths = Get-BundlePaths (Join-Path $case 'delivery')
    [IO.Directory]::CreateDirectory($paths.Target) | Out-Null
    $config = [ordered]@{ v=1; generation=[guid]::NewGuid().ToString('D');
        runtime=[ordered]@{ node=$node; cli='core/lodestar.mjs'; database=$db };
        loader='Lodestar.Loader.exe'; sentinel='preserve-config-byte-for-byte' }
    [IO.File]::WriteAllText((Join-Path $paths.Target 'interfaces.json'),
        ($config | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $paths.Target 'user-marker.txt'),'unrelated user bytes',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $paths.Target 'Lodestar.Loader.notes'),'not a runtime file',[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $paths.Target 'Other.exe'),'unrelated executable bytes',[Text.UTF8Encoding]::new($false))
    Write-FixtureRuntime $paths.Target 'old'
    Test-Bundle $paths.Target | Out-Null
    $configHash = (Get-FileHash -LiteralPath (Join-Path $paths.Target 'interfaces.json') -Algorithm SHA256).Hash
    New-BundleTransaction $paths | Out-Null
    Copy-BundlePreserved $paths
    Write-FixtureRuntime $paths.Stage 'new'
    Seal-BundleStage $paths | Out-Null
    return [pscustomobject]@{ Paths=$paths; ConfigHash=$configHash }
}
function Stage-NextFixture($Fixture) {
    $paths = $Fixture.Paths
    New-BundleTransaction $paths | Out-Null
    Copy-BundlePreserved $paths
    Write-FixtureRuntime $paths.Stage 'newer'
    Seal-BundleStage $paths | Out-Null
}
function Check-Preserved($Fixture,[string]$Expected) {
    $paths = $Fixture.Paths
    $check = Test-Bundle $paths.Target
    Assert-That ($check.files -eq 6) 'Full six-file runtime manifest was not validated.'
    $configHash = (Get-FileHash -LiteralPath (Join-Path $paths.Target 'interfaces.json') -Algorithm SHA256).Hash
    Assert-That ($configHash -eq $Fixture.ConfigHash) 'Configuration bytes changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $paths.Target 'user-marker.txt') -Raw) -eq 'unrelated user bytes') 'Unrelated file changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $paths.Target 'Lodestar.Loader.notes') -Raw) -eq 'not a runtime file') 'Similar-named user document changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $paths.Target 'Other.exe') -Raw) -eq 'unrelated executable bytes') 'Unrelated executable changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $paths.Target 'Lodestar.Loader.dll') -Raw) -eq "$Expected Lodestar.Loader.dll") 'Wrong bundle version is active.'
}
function Run-Case([string]$Name,[scriptblock]$Body) {
    if ($Name -notlike $CaseFilter) { return }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        & $Body
        $script:results += [pscustomobject]@{ name=$Name; status='pass'; milliseconds=$watch.ElapsedMilliseconds }
    } catch {
        $script:results += [pscustomobject]@{ name=$Name; status='fail'; milliseconds=$watch.ElapsedMilliseconds; error=$_.Exception.Message }
    }
}

Run-Case 'success_retains_previous' {
    $fixture=New-Fixture 'success'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Check-Preserved $fixture 'new'
    $old = Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target
    Assert-That ($old.files -eq 6) 'Previous bundle manifest invalid.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $fixture.Paths.Previous 'Lodestar.Loader.dll') -Raw) -eq 'old Lodestar.Loader.dll') 'Previous bundle is not old.'
}
Run-Case 'two_consecutive_updates' {
    $fixture=New-Fixture 'repeat'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Check-Preserved $fixture 'new'
    Stage-NextFixture $fixture
    Check-Preserved $fixture 'new'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Check-Preserved $fixture 'newer'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
    Assert-That ((Get-Content -LiteralPath (Join-Path $fixture.Paths.Previous 'Lodestar.Loader.dll') -Raw) -eq 'new Lodestar.Loader.dll') 'Second previous bundle is not the first update.'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $fixture.Paths.Previous 'interfaces.json') -Algorithm SHA256).Hash -eq $fixture.ConfigHash) 'Second Previous config bytes changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $fixture.Paths.Previous 'user-marker.txt') -Raw) -eq 'unrelated user bytes') 'Second Previous unrelated file changed.'
    Assert-That ((Get-Content -LiteralPath (Join-Path $fixture.Paths.Previous 'Other.exe') -Raw) -eq 'unrelated executable bytes') 'Second Previous unrelated executable changed.'
}
Run-Case 'first_install_then_update' {
    $fixture=New-Fixture 'first_install'
    $seed=Join-Path ([IO.Path]::GetDirectoryName($fixture.Paths.Target)) 'fixture-seed'
    [IO.Directory]::Move($fixture.Paths.Target,$seed)
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Check-Preserved $fixture 'new'
    Assert-That (-not [IO.Directory]::Exists($fixture.Paths.Previous)) 'First install created a Previous bundle.'
    Stage-NextFixture $fixture
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Check-Preserved $fixture 'newer'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
}
Run-Case 'resume_partial_retirement' {
    $fixture=New-Fixture 'retirement'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    $journal=Get-Content -LiteralPath $fixture.Paths.Journal -Raw | ConvertFrom-Json
    $journal.state='retiring'
    [IO.File]::WriteAllText($fixture.Paths.Journal,($journal | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    [IO.File]::Delete((Join-Path $fixture.Paths.Previous 'Lodestar.Loader.dll'))
    Stage-NextFixture $fixture
    Check-Preserved $fixture 'new'
    Test-Bundle $fixture.Paths.Stage $fixture.Paths.Target | Out-Null
    Assert-That (-not [IO.Directory]::Exists($fixture.Paths.Previous)) 'Partial retirement left previous path occupied.'
}
Run-Case 'foreign_previous_entry_refused' {
    $fixture=New-Fixture 'foreign'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture.Paths.Previous 'foreign.txt'),'not recorded',[Text.UTF8Encoding]::new($false))
    $failed=$false
    try { New-BundleTransaction $fixture.Paths | Out-Null } catch { $failed=$true }
    Assert-That $failed 'Unrecorded Previous entry was retired.'
    Check-Preserved $fixture 'new'
    Assert-That ([IO.File]::Exists((Join-Path $fixture.Paths.Previous 'foreign.txt'))) 'Unrecorded Previous entry was removed.'
}
Run-Case 'journal_less_previous_refused' {
    $fixture=New-Fixture 'journal_less'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    [IO.File]::Delete($fixture.Paths.Journal)
    $failed=$false
    try { New-BundleTransaction $fixture.Paths | Out-Null } catch { $failed=$true }
    Assert-That $failed 'Previous without an ownership journal was adopted.'
    Check-Preserved $fixture 'new'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
}
foreach ($point in @('BeforeSwap','AfterOldMoved','AfterNewMoved')) {
    $caseName = "failure_$point"
    Run-Case $caseName {
        $fixture=New-Fixture $caseName
        $failed=$false
        try { Invoke-BundleSwap $fixture.Paths -InjectFailure $point | Out-Null } catch { $failed=$true }
        Assert-That $failed "Injected $point failure did not return an error."
        Check-Preserved $fixture 'old'
        Assert-That (-not [IO.Directory]::Exists($fixture.Paths.Previous)) 'Rollback left previous path occupied.'
        Test-Bundle $fixture.Paths.Stage $fixture.Paths.Target | Out-Null
    }
}
foreach ($point in @('BeforeSwap','AfterOldMoved','AfterNewMoved')) {
    $caseName = "second_failure_$point"
    Run-Case $caseName {
        $fixture=New-Fixture $caseName
        Invoke-BundleSwap $fixture.Paths | Out-Null
        Stage-NextFixture $fixture
        $failed=$false
        try { Invoke-BundleSwap $fixture.Paths -InjectFailure $point | Out-Null } catch { $failed=$true }
        Assert-That $failed "Second injected $point failure did not return an error."
        Check-Preserved $fixture 'new'
        Assert-That (-not [IO.Directory]::Exists($fixture.Paths.Previous)) 'Second rollback left previous path occupied.'
        Test-Bundle $fixture.Paths.Stage $fixture.Paths.Target | Out-Null
    }
}
Run-Case 'corrupt_stage_refused' {
    $fixture=New-Fixture 'corruption'
    [IO.File]::AppendAllText((Join-Path $fixture.Paths.Stage 'core\lodestar.mjs'),'corrupt')
    $failed=$false
    try { Invoke-BundleSwap $fixture.Paths | Out-Null } catch { $failed=$true }
    Assert-That $failed 'Corrupt stage was accepted.'
    Check-Preserved $fixture 'old'
}
Run-Case 'in_use_refused' {
    $fixture=New-Fixture 'inuse'
    $failed=$false
    try { Invoke-BundleSwap $fixture.Paths -SimulateInUse | Out-Null } catch { $failed=$true }
    Assert-That $failed 'In-use probe did not refuse replacement.'
    Check-Preserved $fixture 'old'
}
Run-Case 'recover_after_old_moved' {
    $fixture=New-Fixture 'recoverold'
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    $recovered=Invoke-BundleRecover $fixture.Paths
    Assert-That ($recovered.state -eq 'restored_previous') 'Interrupted old move was not restored.'
    Check-Preserved $fixture 'old'
    Test-Bundle $fixture.Paths.Stage $fixture.Paths.Target | Out-Null
}
Run-Case 'recover_after_new_moved' {
    $fixture=New-Fixture 'recovernew'
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    [IO.Directory]::Move($fixture.Paths.Stage,$fixture.Paths.Target)
    $recovered=Invoke-BundleRecover $fixture.Paths
    Assert-That ($recovered.state -eq 'new_target_valid') 'Interrupted new move was not accepted.'
    Check-Preserved $fixture 'new'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
}
Run-Case 'recover_second_after_old_moved' {
    $fixture=New-Fixture 'recover_second_old'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Stage-NextFixture $fixture
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    $recovered=Invoke-BundleRecover $fixture.Paths
    Assert-That ($recovered.state -eq 'restored_previous') 'Second interrupted old move was not restored.'
    Check-Preserved $fixture 'new'
    Test-Bundle $fixture.Paths.Stage $fixture.Paths.Target | Out-Null
}
Run-Case 'recover_second_after_new_moved' {
    $fixture=New-Fixture 'recover_second_new'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    Stage-NextFixture $fixture
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    [IO.Directory]::Move($fixture.Paths.Stage,$fixture.Paths.Target)
    $recovered=Invoke-BundleRecover $fixture.Paths
    Assert-That ($recovered.state -eq 'new_target_valid') 'Second interrupted new move was not accepted.'
    Check-Preserved $fixture 'newer'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
    Assert-That ([IO.File]::Exists($fixture.Paths.Journal)) 'Recovered second update lost its completion journal.'
    $rechecked=Invoke-BundleRecover $fixture.Paths
    Assert-That ($rechecked.state -eq 'new_target_valid') 'Completed journal was not recoverable again.'
}
foreach ($badField in @('version','id','state','stage_hash','missing_version','missing_seal','complete_hash')) {
    Run-Case "resilience_invalid_journal_$badField" {
        $fixture=New-Fixture "bad_journal_$badField"
        $journal=Get-Content -LiteralPath $fixture.Paths.Journal -Raw | ConvertFrom-Json
        switch ($badField) {
            'version' { $journal.v='1' }
            'id' { $journal.id=[guid]::Empty.ToString('D') }
            'state' { $journal.state='' }
            'stage_hash' { $journal.stage_manifest_sha256='not-a-hash' }
            'missing_version' { $journal.PSObject.Properties.Remove('v') }
            'missing_seal' { $journal.PSObject.Properties.Remove('stage_manifest_sha256') }
            'complete_hash' {
                $journal.state='complete'
                $journal | Add-Member -NotePropertyName target_manifest_sha256 -NotePropertyValue 'bad-hash'
                $journal | Add-Member -NotePropertyName previous_manifest_sha256 -NotePropertyValue $null
                $journal | Add-Member -NotePropertyName previous_inventory -NotePropertyValue @()
            }
        }
        [IO.File]::WriteAllText($fixture.Paths.Journal,($journal|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
        $original=(Get-FileHash -LiteralPath $fixture.Paths.Journal -Algorithm SHA256).Hash
        $message=''
        try { Invoke-BundleRecover $fixture.Paths | Out-Null } catch { $message=$_.Exception.Message }
        Assert-That ($message -match 'journal_invalid.*Next action:') 'Malformed journal was accepted or lacked exact corrective guidance.'
        Assert-That ((Get-FileHash -LiteralPath $fixture.Paths.Journal -Algorithm SHA256).Hash -eq $original) 'Malformed journal original bytes changed.'
        Check-Preserved $fixture 'old'
        Assert-That ([IO.Directory]::Exists($fixture.Paths.Stage)) 'Invalid journal recovery moved or deleted stage.'
    }
}
Run-Case 'resilience_legacy_missing_state' {
    $fixture=New-Fixture 'legacy_state'
    $journal=Get-Content -LiteralPath $fixture.Paths.Journal -Raw | ConvertFrom-Json
    $journal.PSObject.Properties.Remove('state')
    [IO.File]::WriteAllText($fixture.Paths.Journal,($journal|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $result=Invoke-BundleRecover $fixture.Paths
    Assert-That ($result.state -eq 'pre_swap_stage_retained') 'Valid legacy missing state was not supported.'
    Check-Preserved $fixture 'old'
}
Run-Case 'resilience_recover_preserves_orphan_journal_temp' {
    $fixture=New-Fixture 'orphan_temp'
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    [IO.Directory]::Move($fixture.Paths.Stage,$fixture.Paths.Target)
    $orphan=$fixture.Paths.Journal+'.tmp'
    [IO.File]::WriteAllText($orphan,'{partial 漢字',[Text.UTF8Encoding]::new($false))
    $original=(Get-FileHash -LiteralPath $orphan -Algorithm SHA256).Hash
    $result=Invoke-BundleRecover $fixture.Paths
    Assert-That ($result.state -eq 'new_target_valid') 'Valid interrupted swap was not recovered with an orphan candidate.'
    Assert-That ((Get-FileHash -LiteralPath $orphan -Algorithm SHA256).Hash -eq $original) 'Orphan candidate bytes changed.'
    Check-Preserved $fixture 'new'
    Test-Bundle $fixture.Paths.Previous $fixture.Paths.Target | Out-Null
    $again=Invoke-BundleRecover $fixture.Paths
    Assert-That ($again.state -eq 'new_target_valid') 'Recovered journal did not remain usable.'
}
Run-Case 'resilience_recovery_refuses_live_runtime' {
    $fixture=New-Fixture 'live_recovery'
    [IO.Directory]::Move($fixture.Paths.Target,$fixture.Paths.Previous)
    $module=Get-Module BundleTools
    $originalGuard=& $module { (Get-Command Assert-NotRunning).ScriptBlock }
    try {
        & $module { Set-Item Function:script:Assert-NotRunning -Value { param($paths) throw 'fixture_live_runtime' } }
        $message=''
        try { Invoke-BundleRecover $fixture.Paths | Out-Null } catch { $message=$_.Exception.Message }
        Assert-That ($message -match 'fixture_live_runtime') 'Recovery mutated a runtime before checking its existing in-use guard.'
        Assert-That (-not [IO.Directory]::Exists($fixture.Paths.Target) -and [IO.Directory]::Exists($fixture.Paths.Previous)) 'In-use refusal changed bundle locations.'
    } finally { & $module { param($guard) Set-Item Function:script:Assert-NotRunning -Value $guard } $originalGuard }
}
Run-Case 'resilience_retirement_names_unowned_file' {
    $fixture=New-Fixture 'retire_extra'
    Invoke-BundleSwap $fixture.Paths | Out-Null
    $extra=Join-Path $fixture.Paths.Previous 'unowned-notes.txt'
    [IO.File]::WriteAllText($extra,'preserve extra user bytes',[Text.UTF8Encoding]::new($false))
    $before=(Get-FileHash -LiteralPath $extra -Algorithm SHA256).Hash
    $message=''
    try { New-BundleTransaction $fixture.Paths | Out-Null } catch { $message=$_.Exception.Message }
    Assert-That ($message -match 'unowned-notes.txt' -and $message -match 'Next action:') 'Retirement refusal did not identify the unexpected file and recovery.'
    Assert-That ((Get-FileHash -LiteralPath $extra -Algorithm SHA256).Hash -eq $before) 'Unowned user file changed.'
    Check-Preserved $fixture 'new'
}
Run-Case 'validate_exit_codes' {
    $fixture=New-Fixture 'exitcodes'
    $script=Join-Path $PSScriptRoot 'Build-Portable.ps1'
    & pwsh -NoProfile -File $script -Destination $fixture.Paths.Target -Mode Validate *> $null
    Assert-That ($LASTEXITCODE -eq 0) 'Valid bundle script exit code was nonzero.'
    [IO.File]::AppendAllText((Join-Path $fixture.Paths.Target 'core\lodestar.mjs'),'corrupt')
    & pwsh -NoProfile -File $script -Destination $fixture.Paths.Target -Mode Validate *> $null
    Assert-That ($LASTEXITCODE -ne 0) 'Corrupt bundle script exit code was zero.'
}
$failedCount = @($results | Where-Object status -eq 'fail').Count
$report = [ordered]@{ v=1; tests=@($results); passed=@($results | Where-Object status -eq 'pass').Count;
    failed=$failedCount; artifacts=$(if ($KeepArtifacts -or $failedCount) { $testRoot } else { $null }) }
$report | ConvertTo-Json -Depth 8
if ($failedCount -eq 0 -and -not $KeepArtifacts) {
    if ($testRoot.StartsWith($lodestarTestParent + '\',[StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($testRoot) -like '.bundle-update-test-*') {
        Assert-Child $lodestarTestParent $testRoot | Out-Null
        @(Get-PlainFiles $testRoot) | Out-Null
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    } else { throw 'Test cleanup path identity changed.' }
}
if ($failedCount -gt 0) { exit 1 }
