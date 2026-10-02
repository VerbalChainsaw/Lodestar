#requires -Version 7.0
[CmdletBinding()]
param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [switch]$SlowCases, [switch]$KeepArtifacts)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$lodestarTestParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $lodestarTestParent ('.bundle-validation-test-' + [guid]::NewGuid().ToString('N'))
$null = Assert-Child $lodestarTestParent $testRoot
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$results = [Collections.Generic.List[object]]::new()
$envelope = '{"v":5,"ok":true,"operation":"help","data":{"name":"lodestar","version":"fixture"},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Case([string]$Name,[scriptblock]$Body) {
    try { & $Body; $results.Add(@{name=$Name;status='pass'}) }
    catch { $results.Add(@{name=$Name;status='fail';error=$_.Exception.Message}) }
}
function Fixture([string]$Name,[string]$Script,[hashtable]$Changes=@{}) {
    $root = Join-Path $testRoot $Name
    [IO.Directory]::CreateDirectory((Join-Path $root 'core')) | Out-Null
    foreach ($name in @('Lodestar.Loader.exe','Lodestar.Loader.dll','Lodestar.Loader.deps.json','Lodestar.Loader.runtimeconfig.json')) {
        [IO.File]::WriteAllText((Join-Path $root $name),'fixture',[Text.UTF8Encoding]::new($false))
    }
    [IO.File]::WriteAllText((Join-Path $root 'core/lodestar.mjs'),$Script,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $root 'core/package.json'),'{}',[Text.UTF8Encoding]::new($false))
    $db = Join-Path $testRoot ($Name + '-fixture.db')
    [IO.File]::WriteAllText($db,'preserved database bytes',[Text.UTF8Encoding]::new($false))
    $config = @{v=1;generation=[guid]::NewGuid().ToString('D');loader='Lodestar.Loader.exe';
        runtime=@{node=$NodePath;cli='core/lodestar.mjs';database=$db};user_extra=@{keep='yes'}}
    foreach ($key in $Changes.Keys) { $config[$key]=$Changes[$key] }
    $configPath = Join-Path $root 'interfaces.json'
    [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    Write-BundleManifest $root 'validation-fixture'
    return @{Root=$root;Db=$db;DbHash=(Get-FileHash $db).Hash;Config=$configPath;ConfigHash=(Get-FileHash $configPath).Hash}
}
function Probe($Fixture) {
    $errorText = ''
    try { Test-Bundle $Fixture.Root | Out-Null } catch { $errorText=$_.Exception.Message }
    Check ((Get-FileHash $Fixture.Db).Hash -eq $Fixture.DbHash) 'Validation changed database bytes.'
    Check ((Get-FileHash $Fixture.Config).Hash -eq $Fixture.ConfigHash) 'Validation changed configuration bytes.'
    return $errorText
}
try {
    Case 'valid typed help and preserved configuration' {
        $f=Fixture 'valid' "console.log('$envelope');"
        Check ((Probe $f) -eq '') 'Valid typed help failed.'
    }
    Case 'ordinary warning with typed help' {
        $f=Fixture 'warning' "console.error('Warning: fixture');console.log('$envelope');"
        Check ((Probe $f) -eq '') 'Warning corrupted valid help.'
    }
    Case 'plain text is rejected' {
        $f=Fixture 'plain' "console.log('help fixture');"
        Check ((Probe $f) -match 'missing_envelope.*Next action') 'Plain text was accepted or lacked actionable protocol error.'
    }
    Case 'string config version is rejected' {
        $f=Fixture 'version' "console.log('$envelope');" @{v='1'}
        Check ((Probe $f) -match 'config_invalid_field.*v.*Next action') 'String version was accepted or lacked correction.'
    }
    Case 'zero runtime generation is rejected' {
        $f=Fixture 'generation' "console.log('$envelope');" @{generation='00000000-0000-0000-0000-000000000000'}
        Check ((Probe $f) -match 'config_invalid_field.*generation.*Next action') 'Zero generation was accepted or lacked correction.'
    }
    Case 'runtime generation trailing newline is rejected' {
        $f=Fixture 'generation-newline' "console.log('$envelope');" @{generation=([guid]::NewGuid().ToString('D')+"`n")}
        Check ((Probe $f) -match 'config_invalid_field.*generation.*Next action') 'Generation trailing newline passed the shared reader.'
    }
    Case 'string bundle manifest schema version is rejected' {
        $f=Fixture 'manifest-version' "console.log('$envelope');"
        $path=Join-Path $f.Root 'bundle-manifest.json'
        $manifest=Get-Content $path -Raw | ConvertFrom-Json
        $manifest.v='1'
        [IO.File]::WriteAllText($path,($manifest | ConvertTo-Json -Depth 8))
        Check ((Probe $f) -match 'bundle_manifest_invalid_shape.*Next action') 'String manifest version was accepted or lacked correction.'
    }
    Case 'wrong operation is rejected' {
        $wrong=$envelope.Replace('"help"','"doctor"')
        $f=Fixture 'operation' "console.log('$wrong');"
        Check ((Probe $f) -match 'invalid_envelope.*Next action') 'Wrong help operation was accepted.'
    }
    Case 'duplicate envelope is rejected' {
        $f=Fixture 'duplicate' "console.log('$envelope');console.log('$envelope');"
        Check ((Probe $f) -match 'multiple_envelopes.*Next action') 'Duplicate help was accepted.'
    }
    Case 'inconsistent success exit is rejected' {
        $f=Fixture 'exit' "console.log('$envelope');process.exitCode=4;"
        Check ((Probe $f) -match 'inconsistent_exit.*Next action') 'Help success exit4 was accepted.'
    }
    Case 'output overflow stops probe' {
        $f=Fixture 'overflow' "console.log('$envelope');console.log('x'.repeat(2097152));"
        Check ((Probe $f) -match 'output_limit.*Next action') 'Probe output was not bounded.'
    }
    if ($SlowCases) {
        Case 'deadline stops selected child and its owned descendant' {
            $child='setTimeout(()=>{},16500)'
            $script="import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','$child'],{stdio:['ignore','inherit','inherit']});writeFileSync(process.argv[1]+'.pid',String(child.pid));console.log('$envelope');"
            $f=Fixture 'deadline' $script
            $watch=[Diagnostics.Stopwatch]::StartNew()
            $errorText=Probe $f
            Check ($errorText -match 'timeout.*Next action') 'Probe deadline was not enforced.'
            Check ($watch.ElapsedMilliseconds -lt 16250) 'Probe exceeded its15-second deadline allowance.'
            $pidPath=Join-Path $f.Root 'core/lodestar.mjs.pid'
            Check ([IO.File]::Exists($pidPath)) 'Descendant did not start.'
            $ownedPid=[int][IO.File]::ReadAllText($pidPath)
            Check ($null -eq (Get-Process -Id $ownedPid -ErrorAction SilentlyContinue)) 'Owned descendant survived probe cleanup.'
        }
    }
} finally {
    $failed=@($results | Where-Object status -eq 'fail').Count
    [ordered]@{v=1;tests=@($results);passed=@($results | Where-Object status -eq 'pass').Count;failed=$failed;artifacts=$testRoot} | ConvertTo-Json -Depth 6
    if (-not $failed -and -not $KeepArtifacts) {
        $null=Assert-Child $lodestarTestParent $testRoot
        @(Get-PlainFiles $testRoot) | Out-Null
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
if ($failed) { exit 1 }
