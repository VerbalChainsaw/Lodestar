#requires -Version 7.0
# Keep native CLI flags as literal script arguments. PowerShell -File cannot bind
# arbitrary --flags to an advanced script's parameter list.
$CliArguments=@($args)
$DescribeOnly=$false
if($CliArguments.Count -and $CliArguments[0] -ceq '-DescribeOnly'){$DescribeOnly=$true;$CliArguments=@($CliArguments|Select-Object -Skip 1)}
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1') -Force
    $selection=Read-InterfaceConfig $PSScriptRoot
    $node=Resolve-Node $selection.Node
    foreach($argument in $CliArguments){
        if($argument -ceq '--'){break}
        if($argument -in @('--db','--interface-config','--args-file','--args-stdin') -or $argument -match '^--(?:db|interface-config|args-file)='){throw 'Selected runtime/database is fixed by interfaces.json. Use the core executable explicitly to choose another binding or argument-file transport.'}
    }
    $arguments=@($selection.Cli,'--db',$selection.Database)+$CliArguments
    if($CliArguments.Count -and $CliArguments[0] -ceq 'manager'){$arguments+=@('--interface-config',$selection.Path)}
    if($DescribeOnly){@{executable=$node;arguments=$arguments;config=$selection.Path}|ConvertTo-Json -Depth 6;return}
    $start=[Diagnostics.ProcessStartInfo]::new($node);$start.UseShellExecute=$false;$start.WorkingDirectory=$PSScriptRoot
    foreach($argument in $arguments){$start.ArgumentList.Add($argument)}
    foreach($key in @('NODE_OPTIONS','NODE_PATH','LODESTAR_DB','CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_SESSION_ID','OPENCODE_SESSION_ID','CODEX_AGENT_NAME','LODESTAR_AGENT','LODESTAR_HARNESS')){$null=$start.Environment.Remove($key)}
    $process=[Diagnostics.Process]::Start($start)
    try{$process.WaitForExit();$code=$process.ExitCode}finally{$process.Dispose()}
    exit $code
} catch {[Console]::Error.WriteLine("Lodestar CLI failed: $($_.Exception.Message) Next action: inspect the selected interfaces.json and runtime; preserve the database.");exit 1}
