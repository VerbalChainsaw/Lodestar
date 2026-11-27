#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundlePath,[string]$EvidencePath,[switch]$KeepArtifacts)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($BundlePath)
$owner=Join-Path $PSScriptRoot '../distribution/Install.ps1'
$node=[IO.Path]::GetFullPath((Get-Command node -CommandType Application | Select-Object -First 1).Source)
$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root=Join-Path $temporary ('lodestar-legacy-recovery-'+[guid]::NewGuid().ToString('N'))
if (-not $root.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test root escaped temporary directory.' }
[IO.Directory]::CreateDirectory($root)|Out-Null
$results=[Collections.Generic.List[object]]::new()
function Check([bool]$Value,[string]$Message) { if(-not $Value){throw $Message} }
function Inventory([string]$Directory) {
    @([IO.Directory]::EnumerateFiles($Directory,'*',[IO.SearchOption]::AllDirectories)|Sort-Object|ForEach-Object {
        [IO.Path]::GetRelativePath($Directory,$_)+':'+(Get-FileHash -LiteralPath $_).Hash
    }) -join "`n"
}
$payload=Join-Path $root candidate
Copy-Item -LiteralPath $source -Destination $payload -Recurse
[IO.File]::Copy([IO.Path]::GetFullPath($owner),(Join-Path $payload Install.ps1),$true)
Import-Module (Join-Path $payload BundleTools.psm1) -Force -DisableNameChecking
Write-BundleManifest $payload 'test:current-installer-legacy-recovery'
$manifestPath=Join-Path $payload distribution-manifest.json
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
foreach($entry in $manifest.files){$file=Join-Path $payload $entry.path;$entry.bytes=([IO.FileInfo]$file).Length;$entry.sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
function Run($Fixture,[string[]]$Extra=@()) {
    $out=@(& pwsh -NoProfile -File (Join-Path $payload Install.ps1) -Destination $Fixture.App -DatabasePath $Fixture.Db -NodePath $node -TestMode -TestHostRoot $Fixture.Host @Extra 2>&1)
    return @{Code=$LASTEXITCODE;Text=($out|Out-String)}
}
foreach($change in @('unchanged','changed','missing')){
    $fixtureRoot=Join-Path $root $change
    [IO.Directory]::CreateDirectory($fixtureRoot)|Out-Null
    $f=@{App=(Join-Path $fixtureRoot 'legacy café & app');Db=(Join-Path $fixtureRoot 'data/selected store.db');Host=(Join-Path $fixtureRoot host)}
    $witness=@{name=('legacy_portable_preswap_'+$change);status='fail';artifact_root=$fixtureRoot}
    try {
        Copy-Item -LiteralPath $source -Destination $f.App -Recurse
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($f.Db))|Out-Null
        $setup=@(& pwsh -NoProfile -File (Join-Path $f.App Setup.ps1) -NodePath $node -DatabasePath $f.Db -InitializeDatabase 2>&1)
        Check ($LASTEXITCODE -eq 0) ($setup|Out-String)
        [IO.File]::Delete((Join-Path $f.App distribution-manifest.json))
        $originalInventory=Inventory $f.App
        $configHash=(Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)).Hash
        $dbHash=(Get-FileHash -LiteralPath $f.Db).Hash
        $interrupt=Run $f @('-Fault','BeforeSwap')
        $witness.interruption=$interrupt.Text
        Check ($interrupt.Code -ne 0 -and $interrupt.Text -match 'install_interrupted') $interrupt.Text
        Check (-not [IO.File]::Exists((Join-Path $f.App distribution-manifest.json))) 'Interrupted adoption mislabeled old runtime with a distribution manifest.'
        Check ((Inventory $f.App) -ceq $originalInventory) 'Interrupted adoption changed old target inventory.'
        $stage=$f.App+'.lodestar-stage'
        $stageManifest=Join-Path $stage distribution-manifest.json
        if($change -eq 'changed'){[IO.File]::AppendAllText($stageManifest,"`n ")}
        if($change -eq 'missing'){[IO.File]::Delete($stageManifest)}
        $stageBefore=Inventory $stage
        $receiptPath=$f.App+'.lodestar-install.json'
        $receiptHash=(Get-FileHash -LiteralPath $receiptPath).Hash
        $journalHash=(Get-FileHash -LiteralPath ($f.App+'.lodestar-journal.json')).Hash
        $recover=Run $f @('-Mode','Recover')
        $witness.recovery=$recover.Text
        if($change -eq 'unchanged'){
            Check ($recover.Code -eq 0) $recover.Text
            Check ((Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Recovery changed exact selected config.'
            Check ((Inventory ($f.App+'.lodestar-previous')) -ceq $originalInventory) 'Recovery changed retained old runtime inventory.'
            Check ([IO.File]::Exists((Join-Path $f.App distribution-manifest.json))) 'Recovery did not promote the candidate distribution.'
            Check ((Get-FileHash -LiteralPath (Join-Path $f.App distribution-manifest.json)).Hash -eq (Get-FileHash -LiteralPath $manifestPath).Hash) 'Promoted candidate manifest differs.'
            Import-Module (Join-Path $payload DistributionTools.psm1) -Force
            Test-DistributionPayload $f.App -Configured|Out-Null
            Check ((Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json).phase -eq 'registered') 'Recovery did not settle owned installation.'
        } else {
            Check ($recover.Code -ne 0 -and $recover.Text -match 'install_stage_conflict') 'Changed/missing candidate must refuse with a stage conflict.'
            Check ((Inventory $stage) -ceq $stageBefore) 'Refused recovery changed retained stage.'
            Check ((Inventory $f.App) -ceq $originalInventory) 'Refused recovery changed old application.'
            Check ((Get-FileHash -LiteralPath $receiptPath).Hash -eq $receiptHash) 'Refused recovery rewrote receipt.'
            Check ((Get-FileHash -LiteralPath ($f.App+'.lodestar-journal.json')).Hash -eq $journalHash) 'Refused recovery rewrote journal.'
            Check (-not [IO.Directory]::Exists(($f.App+'.lodestar-previous'))) 'Refused recovery moved old application.'
        }
        Check ((Get-FileHash -LiteralPath $f.Db).Hash -eq $dbHash) 'Recovery changed selected schema5 database.'
        $witness.config_sha256=$configHash;$witness.database_sha256=$dbHash
        $witness.status='pass'
    } catch {$witness.error=$_.Exception.Message}
    $results.Add($witness)
}
$report=@{root=$root;cases=$results.ToArray();pass=@($results|Where-Object status -eq pass).Count;fail=@($results|Where-Object status -eq fail).Count}
$json=$report|ConvertTo-Json -Depth 8
if($EvidencePath){[IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),$json,[Text.UTF8Encoding]::new($false))}
$json
if(-not $KeepArtifacts -and -not $report.fail){Remove-Item -LiteralPath $root -Recurse -Force}
if($report.fail){exit 1}
