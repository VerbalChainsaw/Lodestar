#requires -Version 7.0
[CmdletBinding()]
param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source,
    [string]$BundleArchive,[string]$DistributionSource=(Join-Path $PSScriptRoot '../distribution'),[string]$CaseFilter='*')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$DistributionSource=[IO.Path]::GetFullPath($DistributionSource)
$distribution=Import-Module (Join-Path $DistributionSource 'DistributionTools.psm1') -Force -PassThru
$root = Join-Path ([IO.Path]::GetTempPath()) ('lodestar-dist-faults-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$results = [Collections.Generic.List[object]]::new()
function Check([bool]$value,[string]$message) { if (-not $value) { throw $message } }
function Case([string]$name,[scriptblock]$body) {
    if ($name -notlike $CaseFilter) { return }
    try { & $body; $results.Add(@{name=$name;status='pass'}) }
    catch { $results.Add(@{name=$name;status='fail';error=$_.Exception.Message}) }
}
try {
    if ($IsWindows) {
        $guardRoot=Join-Path $root 'guard app 漢字'
        [IO.Directory]::CreateDirectory((Join-Path $guardRoot 'core')) | Out-Null
        $guardCli=Join-Path $guardRoot 'core/lodestar.mjs'
        [IO.File]::WriteAllText($guardCli,'setTimeout(()=>{},15000);')
        $unrelatedCli=$guardCli+'.other.mjs'
        [IO.File]::WriteAllText($unrelatedCli,'setTimeout(()=>{},15000);')
        foreach ($scenario in @('manager','one-shot-manager-cwd','inline-cli-text','substring-cli','runtime-option')) {
            Case "process guard actual snapshot $scenario" {
                $start=[Diagnostics.ProcessStartInfo]::new($NodePath)
                $start.UseShellExecute=$false; $start.CreateNoWindow=$true
                $arguments=switch ($scenario) {
                    'manager' { @($guardCli,'manager') }
                    'one-shot-manager-cwd' { @($guardCli,'get','fact:example','--cwd','C:\manager-tools') }
                    'inline-cli-text' { @('-e',('setTimeout(()=>{},15000);void String.raw`'+$guardCli+' manager`;')) }
                    'substring-cli' { @($unrelatedCli,'manager') }
                    'runtime-option' { @('--no-warnings',$guardCli,'manager') }
                }
                foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
                $owned=[Diagnostics.Process]::Start($start)
                try {
                    Check (-not $owned.HasExited) 'Owned process fixture did not remain active.'
                    $snapshot=Get-CimInstance Win32_Process -Filter "ProcessId = $($owned.Id)" -ErrorAction Stop
                    Check ($null -ne $snapshot -and $snapshot.CommandLine) 'Actual Windows process snapshot was unavailable.'
                    & $distribution {
                        param($Snapshot)
                        $script:EdgeSnapshot=@($Snapshot)
                        function script:Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:EdgeSnapshot }
                    } $snapshot
                    $message=''
                    try { Assert-BundleProcessesIdle @($guardRoot) } catch { $message=$_.Exception.Message }
                    if ($scenario -eq 'manager') { Check ($message -match 'Close Manager') 'Supported Manager was not refused.' }
                    elseif ($scenario -eq 'one-shot-manager-cwd') {
                        Check ($message -match 'Lodestar CLI.*active' -and $message -notmatch 'Close Manager') "One-shot activity was mislabeled Manager: $message"
                    } elseif ($scenario -eq 'runtime-option') {
                        Check ($message -match 'cannot verify.*CLI entry point' -and $message -match 'Next action') "Option-prefixed CLI identity lacked a conservative explicit refusal: $message"
                    } else { Check (-not $message) "Unrelated Node code/path text was classified as selected CLI: $message" }
                    Check (-not $owned.HasExited) 'The identity guard terminated its observed process.'
                } finally {
                    & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance -ErrorAction SilentlyContinue }
                    if (-not $owned.HasExited) { $owned.Kill($true); $owned.WaitForExit() }
                    $owned.Dispose()
                }
            }
        }
        Case 'process guard missing command line refuses inspection loudly' {
            & $distribution {
                $script:EdgeSnapshot=@(@{CommandLine=$null})
                function script:Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:EdgeSnapshot }
            }
            $message=''
            try { Assert-BundleProcessesIdle @($guardRoot) } catch { $message=$_.Exception.Message }
            finally { & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance } }
            Check ($message -match 'cannot verify bundle in use' -and $message -match 'Next action') 'An uninspectable Node process was silently accepted.'
            Check ($message -match 'PID unavailable' -and $message -match 'CommandLine unavailable') "Missing snapshot identity/cause was hidden: $message"
        }
        Case 'process guard actual exited null command line snapshot is idle' {
            $snapshot=$null
            $start=[Diagnostics.ProcessStartInfo]::new($NodePath)
            $start.UseShellExecute=$false; $start.CreateNoWindow=$true
            $start.ArgumentList.Add('-e'); $start.ArgumentList.Add('')
            for ($attempt=0;$attempt -lt 4 -and $null -eq $snapshot;$attempt++) {
                $owned=@(1..8 | ForEach-Object { [Diagnostics.Process]::Start($start) })
                try {
                    $snapshots=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
                    $snapshot=$snapshots | Where-Object { $owned.Id -contains $_.ProcessId -and -not $_.CommandLine } | Select-Object -First 1
                    foreach ($child in $owned) { $child.WaitForExit() }
                } finally {
                    foreach ($child in $owned) { $child.WaitForExit(); $child.Dispose() }
                }
            }
            Check ($null -ne $snapshot) 'Could not observe an actual exited Node CIM snapshot with unavailable arguments.'
            & $distribution {
                param($Snapshot)
                $script:EdgeSnapshot=@($Snapshot)
                function script:Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:EdgeSnapshot }
            } $snapshot
            try { Assert-BundleProcessesIdle @($guardRoot) }
            finally { & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance } }
        }
        Case 'process guard live null command line refuses with PID and cause' {
            $start=[Diagnostics.ProcessStartInfo]::new($NodePath)
            $start.UseShellExecute=$false; $start.CreateNoWindow=$true
            $start.ArgumentList.Add($guardCli); $start.ArgumentList.Add('manager')
            $owned=[Diagnostics.Process]::Start($start)
            try {
                $snapshot=Get-CimInstance Win32_Process -Filter "ProcessId = $($owned.Id)" -ErrorAction Stop
                Check ($null -ne $snapshot -and $snapshot.CommandLine) 'Live Node fixture snapshot unavailable.'
                & $distribution {
                    param($Snapshot)
                    # Model denied argument inspection, retaining the actual live PID.
                    $script:EdgeSnapshot=@(@{ProcessId=$Snapshot.ProcessId; CommandLine=$null})
                    function script:Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:EdgeSnapshot }
                } $snapshot
                $message=''
                try { Assert-BundleProcessesIdle @($guardRoot) } catch { $message=$_.Exception.Message }
                Check ($message -match "PID $($owned.Id)" -and $message -match 'CommandLine unavailable' -and $message -match 'Next action') "Live unknown PID/cause was hidden: $message"
                Check ($message -notmatch [regex]::Escape($guardCli)) 'Diagnostic exposed the process command line.'
                Check (-not $owned.HasExited) 'Guard terminated a live unknown process.'
            } finally {
                & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance -ErrorAction SilentlyContinue }
                if (-not $owned.HasExited) { $owned.Kill($true); $owned.WaitForExit() }
                $owned.Dispose()
            }
        }
        foreach ($failure in @('exit inspection','argument parsing')) {
            Case "process guard $failure failure stays closed without argv" {
                & $distribution {
                    param($Failure,$ProcessId)
                    $script:EdgeOriginalExit=(Get-Item Function:Test-ProcessSnapshotExited).ScriptBlock
                    $script:EdgeOriginalArguments=(Get-Item Function:Get-WindowsCommandArguments).ScriptBlock
                    $script:EdgeSnapshot=@(@{ProcessId=$ProcessId;CommandLine=if ($Failure -eq 'exit inspection') {$null} else {'PRIVATE_ARGV_MARKER'}})
                    function script:Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) $script:EdgeSnapshot }
                    if ($Failure -eq 'exit inspection') {
                        function script:Test-ProcessSnapshotExited { param($ProcessId) throw [ComponentModel.Win32Exception]::new(5) }
                    } else {
                        function script:Get-WindowsCommandArguments { param($CommandLine) throw [InvalidOperationException]::new('PRIVATE_ARGV_MARKER') }
                    }
                } $failure $PID
                $message=''
                try { Assert-BundleProcessesIdle @($guardRoot) } catch { $message=$_.Exception.Message }
                finally {
                    & $distribution {
                        Remove-Item -LiteralPath Function:script:Get-CimInstance
                        Set-Item Function:script:Test-ProcessSnapshotExited -Value $script:EdgeOriginalExit
                        Set-Item Function:script:Get-WindowsCommandArguments -Value $script:EdgeOriginalArguments
                    }
                }
                $specific=if ($failure -eq 'exit inspection') {'exit inspection failed.*Win32Exception'} else {'Windows argument parsing failed.*InvalidOperationException'}
                Check ($message -match "PID $PID" -and $message -match $specific -and $message -match 'Next action') "Inspection failure lacked exact PID/cause: $message"
                Check ($message -notmatch 'PRIVATE_ARGV_MARKER') 'Diagnostic exposed raw argv or exception text.'
            }
        }
    }
    Case 'separate streams preserve warnings without corrupting success' {
        $r = Invoke-CleanNode $NodePath @('-e','console.log("{\"ok\":true}");console.error("Warning: harmless");')
        Check ($r.Stdout -match '"ok":true' -and $r.Stderr -match 'Warning: harmless') 'Separate stdout/stderr were lost.'
        Check (($r.Output | ConvertFrom-Json).ok -eq $true) 'Compatibility Output is not stdout alone.'
    }
    Case 'deadline stops owned child' {
        $pidFile = Join-Path $root 'timeout.pid'
        $script = 'require("fs").writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},1500);'
        $watch = [Diagnostics.Stopwatch]::StartNew(); $errorText = ''
        try { Invoke-CleanNode $NodePath @('-e',$script,$pidFile) -TimeoutMs 250 | Out-Null } catch { $errorText = $_.Exception.Message }
        Check ($errorText -match 'timeout.*Next action') 'Deadline did not give a corrective failure.'
        Check ($watch.ElapsedMilliseconds -lt 1400) 'Child wait was unbounded.'
        if ([IO.File]::Exists($pidFile)) { Check ($null -eq (Get-Process -Id ([int][IO.File]::ReadAllText($pidFile)) -ErrorAction SilentlyContinue)) 'Owned timed-out child survived.' }
    }
    foreach ($stream in @('stdout','stderr')) {
        Case "bounded $stream overflow" {
            $errorText = ''
            try { Invoke-CleanNode $NodePath @('-e',"process.$stream.write('x'.repeat(65536));") -MaxOutputBytes 4096 | Out-Null }
            catch { $errorText = $_.Exception.Message }
            Check ($errorText -match 'output_limit.*Next action') 'Overflow was accepted or lacked recovery guidance.'
        }
    }
    Case 'literal arguments and multibyte bytes' {
        $value = 'space & quote " and 漢字'
        $r = Invoke-CleanNode $NodePath @('-e','process.stdout.write(process.argv[1]);',$value)
        Check ($r.Stdout -ceq $value) 'Literal argument changed.'
    }
    Case 'missing executable is definitely not dispatched' {
        $observed = $null
        try { Invoke-CleanNode (Join-Path $root 'absent.exe') @('--version') | Out-Null }
        catch { $observed = $_.Exception }
        Check ($null -ne $observed -and $observed.Data['Dispatched'] -eq $false) 'Launch failure lacked unsent certainty.'
        Check ($observed.Message -match 'Next action') 'Launch failure has no correction.'
    }
    Case 'pipe-holding descendant is bounded and reaped after parent exit' {
        Invoke-CleanNode $NodePath @('-e','') | Out-Null
        $pidFile=Join-Path $root 'descendant.pid'
        $child="require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},5000);"
        $script="const child=require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:['ignore','inherit','inherit']});require('fs').writeFileSync(process.argv[2],String(child.pid));process.exit(0);"
        $errorText=''; $watch=[Diagnostics.Stopwatch]::StartNew()
        try { Invoke-CleanNode $NodePath @('-e',$script,$child,$pidFile) -TimeoutMs 500 | Out-Null } catch { $errorText=$_.Exception.Message }
        Check ($watch.ElapsedMilliseconds -lt 1500 -and (-not $errorText -or $errorText -match 'timeout')) "Inherited pipe bypassed the deadline or failed unexpectedly: $errorText"
        Check ([IO.File]::Exists($pidFile)) 'Descendant fixture did not start.'
        Start-Sleep -Milliseconds 80
        Check ($null -eq (Get-Process -Id ([int][IO.File]::ReadAllText($pidFile)) -ErrorAction SilentlyContinue)) 'Owned pipe-holding descendant survived.'
    }
    Case 'detached pipe holder escape is refused or reaped by owned job' {
        $pidFile=Join-Path $root 'detached-descendant.pid'
        $refusedFile=Join-Path $root 'detached-spawn-refused.json'
        $child="require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>{},5000);"
        $script="const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{detached:true,windowsHide:true,stdio:['ignore','inherit','inherit']});child.on('error',error=>{fs.writeFileSync(process.argv[3],JSON.stringify({code:error.code}));process.exit(17);});const wait=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(wait);process.exit(0);}},5);"
        $errorText=''; $watch=[Diagnostics.Stopwatch]::StartNew()
        try {
            $response=$null
            try { $response=Invoke-CleanNode $NodePath @('-e',$script,$child,$pidFile,$refusedFile) -TimeoutMs 800 } catch { $errorText=$_.Exception.Message }
            if ([IO.File]::Exists($refusedFile)) {
                $refused=[IO.File]::ReadAllText($refusedFile) | ConvertFrom-Json
                Check ($null -ne $response -and $response.ExitCode -eq 17 -and $refused.code -in @('EPERM','EACCES') -and -not [IO.File]::Exists($pidFile)) 'Detached spawn failure did not prove denied job escape.'
                return
            }
            Check ([IO.File]::Exists($pidFile)) 'Detached descendant must confirm actual startup before the parent exits.'
            Check ($watch.ElapsedMilliseconds -lt 1800 -and $errorText -match 'timeout') "Inherited detached pipe escaped the whole-call deadline: $errorText"
            $fixturePid=[int][IO.File]::ReadAllText($pidFile)
            for ($attempt=0; $attempt -lt 20 -and (Get-Process -Id $fixturePid -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 25 }
            Check ($null -eq (Get-Process -Id $fixturePid -ErrorAction SilentlyContinue)) 'Invocation job did not reap its detached ready pipe holder.'
        } finally {
            # This marker was written by the one finite fixture child; never traverse unrelated PIDs.
            if ([IO.File]::Exists($pidFile)) {
                $owned=Get-Process -Id ([int][IO.File]::ReadAllText($pidFile)) -ErrorAction SilentlyContinue
                if ($owned) { $owned.Kill(); $owned.WaitForExit(); $owned.Dispose() }
            }
        }
    }
    $fixture = Get-Content (Join-Path $PSScriptRoot '../../test/cli-protocol-cases.json') -Raw | ConvertFrom-Json -AsHashtable
    foreach ($entry in $fixture.cases) {
        Case ('protocol ' + $entry.id) {
            $render = { param($parts)
                $lines = foreach ($part in $parts) {
                    if ($part -in @('@success','@error')) {
                        $envelope = @{v=5;ok=($part -eq '@success');operation=$entry.operation;revision=7;
                            database_instance_id=('a'*64);database_epoch=('b'*64);more=$false;next=@()}
                        if ($envelope.ok) { $envelope.data=@{reference='public:opaque-handoff-ref'} }
                        else { $envelope.error=@{code='revision_conflict';message='Observed revision changed.';action='Read the current basis and resolve the saved request.';identifiers=@{request_id='ll-fixture'}} }
                        foreach ($key in @($entry['omit'])) { if ($key) { $envelope.Remove($key) } }
                        if ($entry['set']) { foreach ($key in $entry['set'].Keys) { $envelope[$key]=$entry['set'][$key] } }
                        $envelope | ConvertTo-Json -Depth 15 -Compress
                    } else { $part }
                }
                $lines -join "`n"
            }
            $processResult = [pscustomobject]@{Stdout=(& $render $entry.stdout);Stderr=(& $render $entry.stderr);ExitCode=$entry.exitCode}
            $parsed = Read-CliEnvelope $processResult $entry.operation $entry.args ($entry.effect -ne 'read')
            Check ($parsed.Kind -eq $entry.expect.kind) "Expected $($entry.expect.kind), got $($parsed.Kind)."
            if ($entry.expect['code']) { Check ($parsed.Code -eq $entry.expect['code']) "Wrong code $($parsed.Code)." }
            if ($entry.expect.Contains('mayHaveCommitted')) {
                Check ($parsed.MayHaveCommitted -eq $entry.expect['mayHaveCommitted']) 'Write uncertainty changed.'
            }
            Check ($parsed.Diagnostics -notmatch 'PRIVATE_BODY_MARKER') 'Diagnostic leaked child content.'
            if ($parsed.Kind -eq 'error') { Check ($parsed.Envelope.error.action -eq $(if($entry.expect['action']){$entry.expect.action}else{'Read the current basis and resolve the saved request.'})) 'CLI action was lost.' }
            if ($entry.id.StartsWith('semantic-')) {
                Check (($parsed.Envelope.error | ConvertTo-Json -Depth 15 -Compress) -ceq ($entry.set.error | ConvertTo-Json -Depth 15 -Compress)) 'Full semantic error changed.'
                Check (($parsed.Envelope.next | ConvertTo-Json -Compress) -ceq ($entry.set.next | ConvertTo-Json -Compress)) 'Semantic next changed.'
            }
        }
    }
    $configRoot = Join-Path $root 'app'; [IO.Directory]::CreateDirectory((Join-Path $configRoot 'core')) | Out-Null
    $configPath = Join-Path $configRoot 'interfaces.json'
    $base = @{v=1;generation=[guid]::NewGuid().ToString();runtime=@{node=$NodePath;cli='core/lodestar.mjs';database=(Join-Path $root 'store.db')}}
    [IO.File]::WriteAllText((Join-Path $configRoot 'core/lodestar.mjs'),'fixture')
    [IO.File]::WriteAllText($base.runtime.database,'preserve')
    foreach ($field in @('node','cli','database')) {
        Case "config runtime.$field names correction" {
            $config = ($base | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable)
            $config.runtime[$field] = Join-Path $root "absent-$field"
            [IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 8))
            $before = [IO.File]::ReadAllText($configPath); $errorText = ''
            try { Read-InterfaceConfig $configRoot | Out-Null } catch { $errorText = $_.Exception.Message }
            Check ($errorText -match "runtime\.$field" -and $errorText.Contains($configPath) -and $errorText -match 'Next action') 'Field/path/action missing.'
            Check ([IO.File]::ReadAllText($configPath) -ceq $before) 'Invalid config was modified.'
            Check ([IO.File]::ReadAllText($base.runtime.database) -ceq 'preserve') 'Database changed.'
        }
    }
    Case 'malformed config preserves bytes and names correction' {
        [IO.File]::WriteAllText($configPath,'{ malformed')
        $errorText = ''
        try { Read-InterfaceConfig $configRoot | Out-Null } catch { $errorText = $_.Exception.Message }
        Check ($errorText -match 'config_invalid_json' -and $errorText.Contains($configPath) -and $errorText -match 'Next action') 'Malformed config lacks safe correction.'
        Check ([IO.File]::ReadAllText($configPath) -ceq '{ malformed') 'Malformed config was replaced.'
    }
    foreach ($bad in @(@{field='v';value='1'},@{field='v';value=$true},@{field='generation';value='00000000-0000-0000-0000-000000000000'},@{field='generation';value=('{'+[guid]::NewGuid().ToString()+'}')},@{field='generation';value=([guid]::NewGuid().ToString()+"`n")})) {
        Case "config rejects invalid $($bad.field) $($bad.value)" {
            $config=$base|ConvertTo-Json -Depth 8|ConvertFrom-Json -AsHashtable
            $config[$bad.field]=$bad.value
            [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 8)); $errorText=''
            try { Read-InterfaceConfig $configRoot|Out-Null } catch { $errorText=$_.Exception.Message }
            Check ($errorText -match 'config_invalid_field' -and $errorText -match $bad.field -and $errorText -match 'Next action') 'Config accepted a shape the Manager rejects.'
        }
    }
    Case 'config root trailing separator retains correct paths' {
        [IO.File]::WriteAllText($configPath,($base|ConvertTo-Json -Depth 8))
        $r=Read-InterfaceConfig ($configRoot+[IO.Path]::DirectorySeparatorChar)
        Check ($r.Cli -eq (Join-Path $configRoot 'core/lodestar.mjs')) 'Trailing separator rejected a valid config.'
    }
    if ($BundleArchive) {
        Case 'payload rejects string manifest schema version' {
            $caseRoot=Join-Path $root 'manifest-version'
            [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($BundleArchive),$caseRoot)
            $app=Get-ChildItem -LiteralPath $caseRoot -Directory | Select-Object -First 1 -ExpandProperty FullName
            Test-DistributionPayload $app | Out-Null
            $manifestPath=Join-Path $app 'distribution-manifest.json'
            $manifest=Get-Content $manifestPath -Raw | ConvertFrom-Json
            $manifest.v='1'
            [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 10))
            $errorText=''
            try { Test-DistributionPayload $app | Out-Null } catch { $errorText=$_.Exception.Message }
            Check ($errorText -match 'distribution_manifest_invalid_shape.*Next action') 'String manifest schema version was accepted or lacked correction.'
        }
        foreach ($scenario in @('warning','duplicate','error-zero','malformed-envelope','init-then-doctor-fails','init-rejected','init-rejected-long','init-semantic-unknown','init-semantic-true')) {
            Case "setup actual consumer $scenario" {
                $caseRoot=Join-Path $root $scenario
                [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($BundleArchive),$caseRoot)
                $app=@([IO.Directory]::EnumerateDirectories($caseRoot))[0]
                foreach ($name in @('DistributionTools.psm1','Setup.ps1')) { [IO.File]::Copy((Join-Path $DistributionSource $name),(Join-Path $app $name),$true) }
                $cliPath=Join-Path $app 'core/lodestar.mjs'
                $fake=@'
import {writeFileSync} from 'node:fs';
const scenario=SCENARIO;
const operation=process.argv.includes('init')?'init':'doctor';
const db=process.argv[process.argv.indexOf('--db')+1];
const success={v:5,ok:true,operation,revision:1,database_instance_id:'a'.repeat(64),database_epoch:'b'.repeat(64),more:false,next:[],data:{healthy:true}};
if(operation==='init'&&!['init-rejected','init-rejected-long'].includes(scenario))writeFileSync(db,'preserved-created-store');
if(scenario==='error-zero'||['init-rejected','init-rejected-long'].includes(scenario)||(scenario==='init-then-doctor-fails'&&operation==='doctor')){
 delete success.data;success.ok=false;success.error={code:'fixture_rejected',message:'Read-only fixture validation failed.',action:'Inspect the selected store; preserve it.'};
 if(scenario==='init-then-doctor-fails'||['init-rejected','init-rejected-long'].includes(scenario))process.exitCode=3;
 if(scenario==='init-rejected-long'){
  let deep={marker:'END-DEEP-IDENTIFIERS'};for(let i=0;i<120;i++)deep={child:deep};
  success.error={code:'fixture_rejected_long',message:'Rejected before initialization. '+ 'Complete rejection context. '.repeat(30)+'END-CORE-MESSAGE',action:'Preserve the original rejected request. '+ 'Full rejection recovery guidance. '.repeat(30)+'END-CORE-ACTION',identifiers:{request_id:'fixture-rejected-request',details:{marker:'END-CORE-IDENTIFIERS',expected_revision:7},deep}};
 }
}
if(scenario==='init-semantic-unknown'||scenario==='init-semantic-true'){
 delete success.data;success.ok=false;
 success.error={code:scenario==='init-semantic-unknown'?'database_commit_outcome_unknown':'database_connection_cleanup_failed',
 message:'The initialization requires reconciliation.',identifiers:{committed:scenario==='init-semantic-unknown'?'unknown':true},
 action:'Inspect the original initialization request, receipt and current state. '+ 'Full core recovery guidance. '.repeat(30)+'END-CORE-ACTION'};
 success.next=[success.error.action];process.exitCode=5;
}
console.log(JSON.stringify(success));
if(scenario==='warning'){console.error('Warning: SECRET-RAW-MARKER');console.log('ordinary diagnostic');}
if(scenario==='duplicate')console.log(JSON.stringify(success));
if(scenario==='malformed-envelope')console.log('{"ok":broken');
'@
                [IO.File]::WriteAllText($cliPath,$fake.Replace('SCENARIO',('"'+$scenario+'"')))
                $manifestPath=Join-Path $app 'distribution-manifest.json'
                $manifest=Get-Content $manifestPath -Raw | ConvertFrom-Json
                foreach ($entry in $manifest.files) {
                    $file=Join-Path $app $entry.path
                    $entry.bytes=([IO.FileInfo]$file).Length
                    $entry.sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
                }
                [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 10))
                $db=Join-Path $caseRoot 'selected.db'
                $extra=@()
                if ($scenario -in @('init-then-doctor-fails','init-rejected','init-rejected-long','init-semantic-unknown','init-semantic-true')) { $extra=@('-InitializeDatabase') }
                else { [IO.File]::WriteAllText($db,'preserve-existing-store') }
                $out=@(& pwsh -NoProfile -File (Join-Path $app 'Setup.ps1') -NodePath $NodePath -DatabasePath $db @extra 2>&1)
                $exit=$LASTEXITCODE; $text=$out|Out-String
                if ($scenario -eq 'warning') {
                    Check ($exit -eq 0 -and [IO.File]::Exists((Join-Path $app 'interfaces.json'))) 'Actual Setup rejected success with warnings.'
                    Check ($text -match 'Warning|diagnostic' -and $text -notmatch 'SECRET-RAW-MARKER') 'Warning visibility/redaction failed.'
                } else {
                    Check ($exit -ne 0 -and -not [IO.File]::Exists((Join-Path $app 'interfaces.json'))) 'Actual Setup accepted ambiguous/failed response.'
                    Check ($text -match 'Next\s+action') "Actual setup error lacks correction: $text"
                    if ($scenario -eq 'init-then-doctor-fails') { Check ($text -match 'Initialization was confirmed' -and $text -match 'without -InitializeDatabase') 'Later validation failure erased confirmed initialization.' }
                    if ($scenario -in @('init-rejected','init-rejected-long')) { Check ($text -match 'Initialization was rejected' -and $text -notmatch 'outcome is unconfirmed') 'Explicit rejection was misreported as uncertain.' }
                    if ($scenario -eq 'init-rejected-long') {
                        $expectedMessage='Rejected before initialization. '+('Complete rejection context. '*30)+'END-CORE-MESSAGE'
                        $expectedAction='Preserve the original rejected request. '+('Full rejection recovery guidance. '*30)+'END-CORE-ACTION'
                        Check ($text -match 'fixture_rejected_long' -and $text.Contains($expectedMessage) -and $text.Contains($expectedAction) -and $text -match 'END-CORE-IDENTIFIERS' -and $text -match 'END-DEEP-IDENTIFIERS' -and $text -match 'fixture-rejected-request') 'Explicit rejected init lost complete core code/message/action/identifiers.'
                    }
                    if ($scenario -in @('init-semantic-unknown','init-semantic-true')) {
                        Check ($text -match 'outcome is unconfirmed' -and $text -notmatch 'Initialization was rejected') 'Semantic unknown/confirmed commit was labeled rejected.'
                        Check ($text -match 'Inspect the original initialization request' -and $text -match 'END-CORE-ACTION') 'Full core recovery action was lost.'
                    }
                }
                if ($scenario -in @('init-rejected','init-rejected-long')) { Check (-not [IO.File]::Exists($db)) 'Rejected init created a store.' }
                else { Check ([IO.File]::ReadAllText($db) -ceq $(if ($scenario -in @('init-then-doctor-fails','init-semantic-unknown','init-semantic-true')) {'preserved-created-store'} else {'preserve-existing-store'})) 'Setup error changed or deleted selected store.' }
            }
        }
    }
} finally {
    # Only this invocation's resolved disposable directory is removed.
    if (-not $root.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture containment failed.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
$results | ConvertTo-Json -Depth 6
if ($results.Count -eq 0) { throw "No checks matched CaseFilter '$CaseFilter'. Next action: use '*' or a matching wildcard such as '*setup*'." }
if (@($results | Where-Object {$_.status -eq 'fail'}).Count) { exit 1 }
exit 0
