<#
.SYNOPSIS
Checks fail-closed process-inspection diagnostics for owned and portable bundles.
.DESCRIPTION
Invokes the actual DistributionTools guard in an isolated module scope with
unavailable CIM inspection. Bundle fixtures retain exact file inventories.
#>
[CmdletBinding()]
param([string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$distribution=Join-Path $repo 'desktop/distribution'
$module=Import-Module (Join-Path $distribution 'DistributionTools.psm1') -Force -PassThru
$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$caseRoot=Join-Path $temporary ('lodestar-process-guidance-'+[guid]::NewGuid().ToString('N'))
if (-not $caseRoot.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test root escaped temporary directory.' }
$results=[Collections.Generic.List[object]]::new()
[IO.Directory]::CreateDirectory($caseRoot)|Out-Null
function Assert-That([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Inventory([string]$Root) {
    @([IO.Directory]::EnumerateFileSystemEntries($Root,'*',[IO.SearchOption]::AllDirectories) | Sort-Object | ForEach-Object {
        if ([IO.File]::Exists($_)) { $_+'|'+[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($_))) }
        else { $_+'|directory' }
    }) -join "`n"
}
try {
    & $module {
        $script:GuidanceInspectionCalls=0
        function script:Get-Process { param($Name,$ErrorAction) }
        function script:Get-CimInstance {
            param($ClassName,$Filter,$ErrorAction)
            $script:GuidanceInspectionCalls++
            throw 'Injected process inspection denied.'
        }
    }
    foreach ($caller in @('Install','Update')) {
        $target=Join-Path $caseRoot ($caller+" target with 'quote' `$literal 雪")
        $stage=$target+'.stage'; $previous=$target+'.previous'
        foreach ($folder in @($target,$stage,$previous)) {
            [IO.Directory]::CreateDirectory($folder)|Out-Null
            [IO.File]::WriteAllText((Join-Path $folder 'preserved.txt'),'unchanged fixture')
        }
        [IO.File]::WriteAllText(($target+'.journal.json'),'retained transaction witness')
        if ($caller -eq 'Install') { [IO.File]::WriteAllText(($target+'.lodestar-install.json'),'owned installation witness') }
        $before=Get-Inventory $caseRoot
        $failure=$null
        try { & $module { param($Roots) Assert-BundleProcessesIdle $Roots } @($target,$stage,$previous) }
        catch { $failure=$_.Exception.Message }
        $after=Get-Inventory $caseRoot
        $checks=[Collections.Generic.List[string]]::new()
        if (-not $failure) { $checks.Add('Guard must refuse when process inspection is unavailable.') }
        if ($failure -notlike 'cannot verify bundle in use:*') { $checks.Add('Stable refusal prefix is missing.') }
        if ($failure -notlike '*Process inspection is unavailable; replacement refused.*') { $checks.Add('Inspection problem and refusal must remain explicit.') }
        if ($failure -notlike '*rerun the originating command*') { $checks.Add('Originating-command retry instruction is missing.') }
        foreach ($folder in @($target,$stage,$previous)) { if (-not $failure.Contains($folder)) { $checks.Add('Affected path missing: '+$folder) } }
        $quotedTarget="'"+$target.Replace("'","''")+"'"
        $install="pwsh -NoProfile -File '"+(Join-Path $distribution 'Install.ps1').Replace("'","''")+"' -Mode Recover -Destination "+$quotedTarget
        $update="pwsh -NoProfile -File '"+(Join-Path $distribution 'Update.ps1').Replace("'","''")+"' -Mode Recover -Destination "+$quotedTarget
        if (-not $failure.Contains('owned installation') -or -not $failure.Contains($install)) { $checks.Add('Owned installation recovery must use Install.ps1 and a literal exact destination.') }
        if (-not $failure.Contains('portable update') -or -not $failure.Contains($update)) { $checks.Add('Portable recovery must use Update.ps1 and a literal exact destination.') }
        if ($before -cne $after) { $checks.Add('Guard changed the fixture inventory.') }
        $results.Add([pscustomobject]@{name=$caller+'_inspection_unavailable';status=$(if($checks.Count){'fail'}else{'pass'});errors=$checks.ToArray();diagnostic=$failure;writes_observed=($before -cne $after)})
    }
    $inspectionCalls=& $module { $script:GuidanceInspectionCalls }
    Assert-That ($inspectionCalls -eq 2) 'Each fixture must reach the injected failing inspection exactly once.'
} finally {
    Remove-Module $module -Force
    if ([IO.Directory]::Exists($caseRoot)) { Remove-Item -LiteralPath $caseRoot -Recurse -Force -ErrorAction Stop }
}
$report=[pscustomobject]@{cases=$results.ToArray();inspection_calls=$inspectionCalls;pass=@($results|Where-Object status -eq pass).Count;fail=@($results|Where-Object status -eq fail).Count}
$json=$report|ConvertTo-Json -Depth 7
if ($EvidencePath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),$json,[Text.UTF8Encoding]::new($false)) }
$json
if ($report.fail) { exit 1 }
