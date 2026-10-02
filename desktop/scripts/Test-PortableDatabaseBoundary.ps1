#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundlePath,[string]$EvidencePath,[switch]$KeepArtifacts,[string]$CaseFilter='*')
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source=[IO.Path]::GetFullPath($BundlePath)
$node=[IO.Path]::GetFullPath((Get-Command node -CommandType Application|Select-Object -First 1).Source)
$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root=Join-Path $temporary ('lodestar-db-boundary-'+[guid]::NewGuid().ToString('N'))
if(-not $root.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture root escaped temporary directory.'}
[IO.Directory]::CreateDirectory($root)|Out-Null
$payload=Join-Path $root candidate
Copy-Item -LiteralPath $source -Destination $payload -Recurse
foreach($relative in @('desktop/distribution/DistributionTools.psm1','desktop/distribution/Setup.ps1','desktop/distribution/InstallTools.psm1','desktop/distribution/Update.ps1','desktop/scripts/BundleTools.psm1')){
    [IO.File]::Copy((Join-Path $repo $relative),(Join-Path $payload ([IO.Path]::GetFileName($relative))),$true)
}
# This disposable fixture explicitly overlays current PS owners; inventories
# describe those actual bytes and are not a release qualification receipt.
Import-Module (Join-Path $payload BundleTools.psm1) -Force -DisableNameChecking
Write-BundleManifest $payload 'test:portable-database-boundary'
$manifestPath=Join-Path $payload distribution-manifest.json
$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
foreach($entry in $manifest.files){$file=Join-Path $payload $entry.path;$entry.bytes=([IO.FileInfo]$file).Length;$entry.sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
[IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
$results=[Collections.Generic.List[object]]::new()
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Inventory([string]$Directory){
    $entries=[Collections.Generic.List[string]]::new();$pending=[Collections.Generic.Stack[string]]::new();$pending.Push($Directory)
    while($pending.Count){
        foreach($item in Get-ChildItem -LiteralPath $pending.Pop() -Force){
            $name=[IO.Path]::GetRelativePath($Directory,$item.FullName)
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){$entries.Add($name+':reparse:'+($item.LinkTarget -join '|'))}
            elseif($item.PSIsContainer){$entries.Add($name+':directory');$pending.Push($item.FullName)}
            else{$entries.Add($name+':'+(Get-FileHash -LiteralPath $item.FullName).Hash)}
        }
    }
    @($entries|Sort-Object) -join "`n"
}
function Write-Config($Fixture,[string]$Database){
    $file=Join-Path $Fixture.App interfaces.json
    $config=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
    $config.runtime.database=$Database
    [IO.File]::WriteAllText($file,($config|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
}
function New-Fixture([string]$Name){
    $case=Join-Path $root $Name;[IO.Directory]::CreateDirectory($case)|Out-Null
    $app=Join-Path $case 'app café';Copy-Item -LiteralPath $payload -Destination $app -Recurse
    $database=Join-Path $case 'external/selected.db';[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($database))|Out-Null
    $setup=@(& pwsh -NoProfile -File (Join-Path $app Setup.ps1) -NodePath $node -DatabasePath $database -InitializeDatabase 2>&1)
    Check ($LASTEXITCODE -eq 0) ($setup|Out-String)
    return @{Root=$case;App=$app;Db=$database;Paths=(Get-BundlePaths $app)}
}
function Move-SelectedStore($Fixture,[string]$Database,[string]$ConfigValue=$Database){
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Database))|Out-Null
    [IO.File]::Move($Fixture.Db,$Database);$Fixture.Db=$Database
    Write-Config $Fixture $ConfigValue
}
function Run-Update($Fixture){
    $output=@(& pwsh -NoProfile -File (Join-Path $payload Update.ps1) -Destination $Fixture.App 2>&1)
    return @{Code=$LASTEXITCODE;Text=($output|Out-String)}
}
function Run-Case([string]$Name,[scriptblock]$Body){
    if($Name -notlike $CaseFilter){return}
    try{& $Body;$results.Add(@{name=$Name;status='pass'})}catch{$results.Add(@{name=$Name;status='fail';error=$_.Exception.Message})}
}
function Prepare-PartialSwap($Fixture){
    New-BundleTransaction $Fixture.Paths|Out-Null;Copy-BundlePreserved $Fixture.Paths
    foreach($entry in $manifest.files){$to=Join-Path $Fixture.Paths.Stage $entry.path;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))|Out-Null;[IO.File]::Copy((Join-Path $payload $entry.path),$to,$true)}
    [IO.File]::Copy((Join-Path $payload distribution-manifest.json),(Join-Path $Fixture.Paths.Stage distribution-manifest.json),$true)
    Seal-BundleStage $Fixture.Paths|Out-Null
    [IO.Directory]::Move($Fixture.Paths.Target,$Fixture.Paths.Previous)
    [IO.Directory]::Move($Fixture.Paths.Stage,$Fixture.Paths.Target)
    Check ((Get-Content -LiteralPath $Fixture.Paths.Journal -Raw|ConvertFrom-Json).state -eq 'active') 'Partial swap journal is not active.'
    Check (-not [IO.Directory]::Exists($Fixture.Paths.Stage)) 'Partial swap retained a stage.'
}
foreach($placement in @('internal','internal-corrupt','reparse')){
    Run-Case ('partial_swap_recovery_refuses_'+$placement) {
        $f=New-Fixture ('partial-'+$placement);Prepare-PartialSwap $f;$alias=$null
        try{
            if($placement -eq 'reparse'){
                $alias=Join-Path $f.Root alias
                New-Item -ItemType Junction -Path $alias -Target ([IO.Path]::GetDirectoryName($f.Db))|Out-Null
                Write-Config $f (Join-Path $alias selected.db);$expected='Reparse path'
            }else{
                [IO.File]::Copy($f.Db,(Join-Path $f.App inside.db),$false)
                Write-Config $f '.\inside.db';$expected='database_inside_app'
                if($placement -eq 'internal-corrupt'){[IO.File]::AppendAllText((Join-Path $f.App 'core/lodestar.mjs'),'runtime corruption')}
            }
            $before=Inventory $f.Root;$failure=$null
            try{Invoke-BundleRecover $f.Paths|Out-Null}catch{$failure=$_.Exception.Message}
            Check ($failure -match $expected) ('Partial swap swallowed authority refusal: '+$failure)
            Check ((Inventory $f.Root) -ceq $before) 'Refused partial recovery moved/changed app, config, SQLite or journal.'
            Check (-not [IO.Directory]::Exists($f.Paths.Stage)) 'Refused partial recovery moved target to Stage.'
        }finally{if($alias -and [IO.Directory]::Exists($alias)){[IO.Directory]::Delete($alias)}}
    }.GetNewClosure()
}
Run-Case 'partial_swap_recovery_restores_ordinary_corrupt_runtime' {
    $f=New-Fixture 'partial-corrupt-control';Prepare-PartialSwap $f
    [IO.File]::AppendAllText((Join-Path $f.App 'core/lodestar.mjs'),'runtime corruption')
    $previous=Inventory $f.Paths.Previous;$target=Inventory $f.App
    $store=(Get-FileHash -LiteralPath $f.Db).Hash;$journal=(Get-FileHash -LiteralPath $f.Paths.Journal).Hash
    $result=Invoke-BundleRecover $f.Paths
    Check ($result.state -eq 'restored_previous') 'Ordinary runtime corruption did not restore Previous.'
    Check ((Inventory $f.App) -ceq $previous -and (Inventory $f.Paths.Stage) -ceq $target) 'Corrupt-target recovery did not preserve exact old/new inventories.'
    Check ((Get-FileHash -LiteralPath $f.Db).Hash -eq $store -and (Get-FileHash -LiteralPath $f.Paths.Journal).Hash -eq $journal) 'Corrupt-target recovery changed external SQLite/journal.'
}
foreach($placement in @('relative','case','stage','previous','payload')){
    Run-Case ('public_update_refuses_'+$placement) {
        $f=New-Fixture ('public-'+$placement)
        $database=switch($placement){
            'relative'{Join-Path $f.App 'inside.db'}
            'case'{Join-Path $f.App 'CaseStore.db'}
            'stage'{Join-Path $f.Paths.Stage 'inside.db'}
            'previous'{Join-Path $f.Paths.Previous 'inside.db'}
            'payload'{Join-Path $payload ('selected-'+[guid]::NewGuid().ToString('N')+'.db')}
        }
        $value=switch($placement){'relative'{'.\inside.db'} 'case'{$database.ToUpperInvariant()} default{$database}}
        Move-SelectedStore $f $database $value
        try{
            $before=Inventory $f.Root;$databaseHash=(Get-FileHash -LiteralPath $f.Db).Hash
            $result=Run-Update $f
            Check ($result.Code -ne 0 -and $result.Text -match 'database_inside_app') ('No external-store refusal: '+$result.Text)
            Check ((Inventory $f.Root) -ceq $before) 'Refusal changed old application/config/store or transaction state.'
            Check ((Get-FileHash -LiteralPath $f.Db).Hash -eq $databaseHash) 'Refusal changed selected real SQLite bytes.'
            Check (-not [IO.File]::Exists($f.Paths.Journal)) 'Refusal created a transaction journal.'
            if($placement -notin @('stage','previous')){Check (-not [IO.Directory]::Exists($f.Paths.Stage) -and -not [IO.Directory]::Exists($f.Paths.Previous)) 'Refusal created stage/previous.'}
        }finally{if($placement -eq 'payload'){[IO.File]::Delete($f.Db)}}
    }.GetNewClosure()
}
Run-Case 'public_update_external_prefix_preserves_real_store' {
    $f=New-Fixture 'external-prefix';Move-SelectedStore $f (Join-Path ($f.App+'-external') 'selected.db')
    $configHash=(Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)).Hash
    $databaseHash=(Get-FileHash -LiteralPath $f.Db).Hash
    $result=Run-Update $f;Check ($result.Code -eq 0) $result.Text
    Check ((Get-FileHash -LiteralPath $f.Db).Hash -eq $databaseHash) 'Valid update changed external SQLite bytes.'
    Check ((Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Valid update changed config bytes.'
    Check ([IO.Directory]::Exists($f.Paths.Previous)) 'Valid update did not retain old application.'
    Invoke-BundleRecover $f.Paths|Out-Null
    Invoke-BundleRetirePrevious $f.Paths
    Check ([IO.File]::Exists($f.Db) -and (Get-FileHash -LiteralPath $f.Db).Hash -eq $databaseHash) 'Retirement affected valid external authority.'
}
Run-Case 'retained_seal_refuses_physical_stage_store_before_mapping' {
    $f=New-Fixture 'retained-seal'
    New-BundleTransaction $f.Paths|Out-Null;Copy-BundlePreserved $f.Paths
    foreach($entry in $manifest.files){$to=Join-Path $f.Paths.Stage $entry.path;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))|Out-Null;[IO.File]::Copy((Join-Path $payload $entry.path),$to,$true)}
    [IO.File]::Copy((Join-Path $payload distribution-manifest.json),(Join-Path $f.Paths.Stage distribution-manifest.json),$true)
    $inside=Join-Path $f.Paths.Stage inside.db;[IO.File]::Copy($f.Db,$inside,$false)
    $stageConfig=Get-Content -LiteralPath (Join-Path $f.Paths.Stage interfaces.json) -Raw|ConvertFrom-Json
    $stageConfig.runtime.database=$inside
    [IO.File]::WriteAllText((Join-Path $f.Paths.Stage interfaces.json),($stageConfig|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
    $before=Inventory $f.Root;$failure=$null
    try{Seal-BundleStage $f.Paths|Out-Null}catch{$failure=$_.Exception.Message}
    Check ($failure -match 'database_inside_app') ('No physical-stage refusal: '+$failure)
    Check ((Inventory $f.Root) -ceq $before) 'Rejected sealing changed retained transaction.'
}
Run-Case 'retained_recover_refuses_internal_target_without_mutation' {
    $f=New-Fixture 'retained-recover';New-BundleTransaction $f.Paths|Out-Null;Copy-BundlePreserved $f.Paths
    Move-SelectedStore $f (Join-Path $f.App inside.db) '.\inside.db'
    $before=Inventory $f.Root;$failure=$null
    try{Invoke-BundleRecover $f.Paths|Out-Null}catch{$failure=$_.Exception.Message}
    Check ($failure -match 'database_inside_app') ('No retained recovery refusal: '+$failure)
    Check ((Inventory $f.Root) -ceq $before) 'Rejected recovery changed retained state.'
}
Run-Case 'retirement_refuses_selected_previous_store_without_mutation' {
    $f=New-Fixture 'retained-retire';$update=Run-Update $f;Check ($update.Code -eq 0) $update.Text
    Move-SelectedStore $f (Join-Path $f.Paths.Previous 'selected.db')
    $before=Inventory $f.Root;$failure=$null
    try{Invoke-BundleRetirePrevious $f.Paths}catch{$failure=$_.Exception.Message}
    Check ($failure -match 'database_inside_app') ('No selected-previous refusal: '+$failure)
    Check ((Inventory $f.Root) -ceq $before) 'Rejected retirement changed authority/transaction.'
}
Run-Case 'configured_read_refuses_database_reparse_ancestor' {
    $f=New-Fixture 'reparse';$alias=Join-Path $f.Root alias
    New-Item -ItemType Junction -Path $alias -Target ([IO.Path]::GetDirectoryName($f.Db))|Out-Null
    try{
        Write-Config $f (Join-Path $alias selected.db);$before=Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)
        $failure=$null;Import-Module (Join-Path $payload DistributionTools.psm1) -Force
        try{Read-InterfaceConfig $f.App|Out-Null}catch{$failure=$_.Exception.Message}
        Check ($failure -match 'Reparse path') ('No database ancestor refusal: '+$failure)
        Check ((Get-FileHash -LiteralPath (Join-Path $f.App interfaces.json)).Hash -eq $before.Hash) 'Reader changed config.'
    }finally{[IO.Directory]::Delete($alias)}
}
foreach($suffix in @('.lodestar-stage','.lodestar-previous')){
    Run-Case ('fresh_install_selection_refuses_'+$suffix.TrimStart('.')) {
        $f=New-Fixture ('install-'+$suffix.TrimStart('.'))
        $fresh=Join-Path $f.Root future-app
        $database=Join-Path ($fresh+$suffix) selected.db
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($database))|Out-Null
        [IO.File]::Copy($f.Db,$database,$false)
        $before=Inventory $f.Root;$failure=$null
        Import-Module (Join-Path $payload InstallTools.psm1) -Force -DisableNameChecking
        try{Get-InstallSelection $payload $fresh $node $database '' $true (Join-Path $f.Root host) $false|Out-Null}catch{$failure=$_.Exception.Message}
        Check ($failure -match 'install_database_inside_app') ('Fresh selection missed transaction sibling: '+$failure)
        Check ((Inventory $f.Root) -ceq $before) 'Refused Install selection changed fixture bytes/state.'
    }.GetNewClosure()
}
$report=@{v=1;root=$root;test_fixture='Current PS owners over exact candidate; regenerated fixture inventories only.';cases=$results.ToArray();pass=@($results|Where-Object status -eq pass).Count;fail=@($results|Where-Object status -eq fail).Count}
if($results.Count -eq 0){throw 'No matching cases.'}
$json=$report|ConvertTo-Json -Depth 7
if($EvidencePath){[IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),$json,[Text.UTF8Encoding]::new($false))}
$json
if(-not $KeepArtifacts -and -not $report.fail){Remove-Module BundleTools,DistributionTools -ErrorAction SilentlyContinue;if($root.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)){Remove-Item -LiteralPath $root -Recurse -Force}}
if($report.fail){exit 1}
