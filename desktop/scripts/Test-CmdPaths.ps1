<#
.SYNOPSIS
Checks real CMD launcher paths, child arguments and failure exit propagation.
.DESCRIPTION
Uses disposable files, real PowerShell and the selected Node. Loader GUI is not
opened. A missing script is an external failure fixture for each actual wrapper.
#>
[CmdletBinding()]
param([string]$NodePath,[string]$EvidencePath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$distribution=Join-Path $repo 'desktop/distribution'
if (-not $NodePath) { $NodePath=(Get-Command node -ErrorAction Stop).Source }
$node=[IO.Path]::GetFullPath($NodePath)
$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$caseRoot=Join-Path $temporary ('lodestar-cmd-'+[guid]::NewGuid().ToString('N'))
if (-not $caseRoot.StartsWith($temporary+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Test root escaped temporary directory.' }
$results=[Collections.Generic.List[object]]::new()
[IO.Directory]::CreateDirectory($caseRoot)|Out-Null
function Assert-That([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-OwnedCmd([string]$Directory,[string]$Command,[Text.Encoding]$StdoutEncoding=$null) {
    $start=[Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32/cmd.exe'))
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    if ($StdoutEncoding) { $start.StandardOutputEncoding=$StdoutEncoding }
    $start.WorkingDirectory=$Directory
    foreach ($argument in @('/d','/v:on','/c',$Command)) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start; $started=$false
    try {
        $started=$process.Start(); Assert-That $started 'Owned CMD failed to start.'
        $process.StandardInput.Close()
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) { throw 'Owned CMD exceeded 30-second deadline.' }
        [pscustomobject]@{ exit=$process.ExitCode; stdout=$stdout.GetAwaiter().GetResult(); stderr=$stderr.GetAwaiter().GetResult() }
    } finally {
        if ($started -and -not $process.HasExited) { $process.Kill($true); $null=$process.WaitForExit(5000) }
        $process.Dispose()
    }
}
function Run-Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; $results.Add([pscustomobject]@{name=$Name;status='pass'}) }
    catch { $results.Add([pscustomobject]@{name=$Name;status='fail';error=$_.Exception.Message}) }
}
try {
    Run-Case 'Manager_CMD_PowerShell_child_literal_paths_with_delayed_expansion' {
        $app=Join-Path $caseRoot 'app ! literal %PATH% ^ & (unicode 雪)'
        $core=Join-Path $app 'core'; [IO.Directory]::CreateDirectory($core)|Out-Null
        foreach ($name in @('Manager.cmd','Launch.ps1','DistributionTools.psm1')) { [IO.File]::Copy((Join-Path $distribution $name),(Join-Path $app $name)) }
        $db=Join-Path $caseRoot 'database ! %PATH% ^ & 雪.db'; [IO.File]::WriteAllText($db,'fixture path only')
        $cli=Join-Path $core 'lodestar.mjs'
        [IO.File]::WriteAllText($cli,'import fs from "node:fs"; const json=JSON.stringify({argv:process.argv.slice(1),db:process.env.LODESTAR_DB??null}); fs.writeFileSync(new URL("../child-argv.json",import.meta.url),json,"utf8"); process.stdout.write(json);')
        $config=Join-Path $app 'interfaces.json'
        [IO.File]::WriteAllText($config,([ordered]@{v=1;generation=[guid]::NewGuid().ToString('D');runtime=@{node=$node;cli='core/lodestar.mjs';database=$db};loader='Lodestar.Loader.exe'}|ConvertTo-Json -Depth 6))
        # The Node fixture owns a UTF8 JSON stdout contract; the default console
        # code page can differ when this test runs in a hidden redirected process.
        $utf8=[Text.UTF8Encoding]::new($false,$true)
        $run=Invoke-OwnedCmd $app 'Manager.cmd' $utf8
        Assert-That ($run.exit -eq 0) "Manager wrapper failed ($($run.exit)): $($run.stderr)"
        $received=$run.stdout|ConvertFrom-Json
        $expected=ConvertTo-Json -InputObject @($cli,'manager','--interface-config',$config) -Compress -EscapeHandling EscapeNonAscii
        $actual=ConvertTo-Json -InputObject $received.argv -Compress -EscapeHandling EscapeNonAscii
        Assert-That ($actual -ceq $expected) "Child stdout arguments changed at CMD/PowerShell boundary. Expected: $expected Received: $actual"
        Assert-That ($null -eq $received.db) 'Launch inherited alternate database environment.'
        $childFile=Join-Path $app 'child-argv.json'
        Assert-That ([IO.File]::Exists($childFile)) "Child argument witness is missing: $childFile. Expected: $expected Received stdout: $actual"
        $witness=$utf8.GetString([IO.File]::ReadAllBytes($childFile))|ConvertFrom-Json
        $witnessActual=ConvertTo-Json -InputObject $witness.argv -Compress -EscapeHandling EscapeNonAscii
        Assert-That ($witnessActual -ceq $expected) "Child file arguments changed at CMD/PowerShell boundary. Expected: $expected Received file: $witnessActual Received stdout: $actual"
        Assert-That ($null -eq $witness.db) 'Child file witness shows inherited alternate database environment.'
    }
    foreach ($name in @('Setup.cmd','Manager.cmd','Loader.cmd','Update.cmd')) {
        Run-Case "${name}_help_reports_actual_missing_script_exit" {
            $app=Join-Path $caseRoot $name; [IO.Directory]::CreateDirectory($app)|Out-Null
            [IO.File]::Copy((Join-Path $distribution $name),(Join-Path $app $name))
            $run=Invoke-OwnedCmd $app "$name --help"
            Assert-That ($run.exit -ne 0) 'Wrapper reported success when PowerShell rejected its missing script.'
            Assert-That (($run.stdout+$run.stderr).Length -gt 0) 'Rejected launch produced no diagnostic.'
            Assert-That (($run.stdout+$run.stderr) -match 'Next action:') 'Missing-script rejection gives no corrective action.'
        }.GetNewClosure()
    }
} finally {
    # Delete only this exact, generated fixture root after all owned children exited.
    if ([IO.Directory]::Exists($caseRoot)) { Remove-Item -LiteralPath $caseRoot -Recurse -Force -ErrorAction Stop }
}
$report=[pscustomobject]@{cases=$results.ToArray();pass=@($results|Where-Object status -eq pass).Count;fail=@($results|Where-Object status -eq fail).Count}
$json=$report|ConvertTo-Json -Depth 5
if ($EvidencePath) { [IO.File]::WriteAllText([IO.Path]::GetFullPath($EvidencePath),$json,[Text.UTF8Encoding]::new($false)) }
$json
if ($report.fail) { exit 1 }
