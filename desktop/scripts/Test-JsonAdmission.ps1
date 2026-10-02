#requires -Version 7.0
[CmdletBinding()]
param([string]$CaseFilter='*',[switch]$KeepArtifacts,
    [string]$DistributionModule=(Join-Path $PSScriptRoot '../distribution/DistributionTools.psm1'),
    [string]$BundleModule=(Join-Path $PSScriptRoot 'BundleTools.psm1'))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$distribution=Import-Module ([IO.Path]::GetFullPath($DistributionModule)) -Force -PassThru
$bundle=Import-Module ([IO.Path]::GetFullPath($BundleModule)) -Force -DisableNameChecking -PassThru
$repo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$lodestarTestParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$root=Join-Path $lodestarTestParent ('.json-admission-test-'+[guid]::NewGuid().ToString('N'))
Assert-Child $lodestarTestParent $root | Out-Null
[IO.Directory]::CreateDirectory($root) | Out-Null
$node=(Get-Command node -ErrorAction Stop).Source
$results=[Collections.Generic.List[object]]::new()
$utf8=[Text.UTF8Encoding]::new($false)
function Check([bool]$Value,[string]$Message) { if (-not $Value) { throw $Message } }
function Case([string]$Name,[scriptblock]$Body) {
    if ($Name -notlike $CaseFilter) { return }
    try {
        $evidence=& $Body
        $record=@{name=$Name;status='pass'}
        if ($evidence -is [System.Collections.IDictionary] -and $evidence.Contains('public_instructions')) {
            $record.public_instructions=$evidence.public_instructions
        }
        $results.Add($record)
    }
    catch { $results.Add(@{name=$Name;status='fail';error=$_.Exception.Message}) }
}
function Reject([scriptblock]$Read,[string]$Name,[string]$MessagePattern='') {
    $rejected=$false; $message=''
    try { & $Read | Out-Null } catch { $rejected=$true; $message=$_.Exception.Message }
    Check $rejected "Owner admitted $Name."
    if ($MessagePattern) { Check ($message -match $MessagePattern) "Wrong rejection for ${Name}: $message" }
}
function Set-NodeSnapshot([object[]]$Items) {
    # OS process enumeration is a separate integration boundary. Supply the
    # known child argument snapshot to the actual shared identity guard.
    & $distribution {
        param($Items)
        $script:NodeSnapshot=@($Items)
        function script:Get-CimInstance { [CmdletBinding()] param($ClassName,$Filter) $script:NodeSnapshot }
    } $Items
}
function Write-Json([string]$Path,[string]$Text) { [IO.File]::WriteAllText($Path,$Text,$utf8) }
function Corrupt([string]$Path,[string]$Text) {
    $bytes=$utf8.GetBytes($Text.Replace('MARKER','X'))
    $index=[Array]::IndexOf($bytes,[byte][char]'X')
    Check ($index -ge 0) 'Corruption marker missing.'
    $bytes[$index]=0xff
    [IO.File]::WriteAllBytes($Path,$bytes)
}
try {
    $app=Join-Path $root 'app'
    [IO.Directory]::CreateDirectory((Join-Path $app 'core')) | Out-Null
    $db=Join-Path $root 'selected.db'
    Write-Json $db 'preserved placeholder database'
    $dbHash=(Get-FileHash -LiteralPath $db).Hash
    $config=@{v=1;generation=[guid]::NewGuid().ToString('D');runtime=@{node=$node;cli='core/lodestar.mjs';database=$db};loader='Lodestar.Loader.exe';note='MARKER'} | ConvertTo-Json -Depth 8 -Compress
    $configPath=Join-Path $app 'interfaces.json'
    Write-Json $configPath $config
    Case 'configuration rejects nested duplicate in extension array' {
        Write-Json $configPath ('{"extensions":[{"value":1,"\u0076alue":2}],'+$config.Substring(1))
        Reject {Read-InterfaceConfigDocument $app} 'nested duplicate extension'
    }
    Write-Json $configPath $config
    $required=@('Lodestar.Loader.exe','Lodestar.Loader.dll','Lodestar.Loader.deps.json','Lodestar.Loader.runtimeconfig.json',
        'core/lodestar.mjs','core/package.json','bundle-manifest.json','BundleTools.psm1','DistributionTools.psm1',
        'Setup.ps1','Launch.ps1','Update.ps1','Setup.cmd','Loader.cmd','Manager.cmd','Update.cmd')
    foreach ($name in $required) { Write-Json (Join-Path $app $name) 'placeholder payload' }
    Write-Json (Join-Path $app 'core/package.json') '{"version":"3.0.0"}'
    Write-BundleManifest $app 'fixture'
    $bundleManifestPath=Join-Path $app 'bundle-manifest.json'
    $bundleManifest=[IO.File]::ReadAllText($bundleManifestPath)
    $entries=foreach ($name in $required) {
        $file=Join-Path $app $name
        @{path=$name;bytes=([IO.FileInfo]$file).Length;sha256=(Get-FileHash -LiteralPath $file).Hash.ToLowerInvariant()}
    }
    $manifest=@{v=1;version='3.0.0';files=@($entries);note='MARKER'} | ConvertTo-Json -Depth 8 -Compress
    $manifestPath=Join-Path $app 'distribution-manifest.json'
    # Distribution payloads deliberately exclude configured interfaces.json.
    $paths=Get-BundlePaths (Join-Path $root 'transaction')
    $journal=@{v=1;id=[guid]::NewGuid().ToString('D');target=$paths.Target;stage=$paths.Stage;previous=$paths.Previous;state='active';stage_manifest_sha256=$null;note='MARKER'} | ConvertTo-Json -Depth 8 -Compress
    Case 'journal actual Recover rejects duplicate state before filesystem change' {
        [IO.Directory]::CreateDirectory($paths.Stage) | Out-Null
        $sentinel=Join-Path $paths.Stage 'sentinel.txt'
        Write-Json $sentinel 'preserve stage bytes'
        $text='{"state":"invalid","\u0073tate":"active",'+($journal -replace '"state":"active",?','').Substring(1)
        Write-Json $paths.Journal $text
        Reject {Invoke-BundleRecover $paths} 'Recover duplicate journal state'
        Check ([IO.File]::ReadAllText($sentinel) -ceq 'preserve stage bytes') 'Recover changed stage bytes.'
        Check (-not [IO.Directory]::Exists($paths.Target) -and -not [IO.Directory]::Exists($paths.Previous)) 'Recover created target/previous.'
    }
    Write-Json $paths.Journal $journal
    Case 'journal rejects consumed state case substitution' {
        Write-Json $paths.Journal ($journal -replace '"state"\s*:', '"State":')
        Reject {& $bundle {param($p) Read-BundleJournal $p} $paths} 'wrong-case consumed state'
    }
    Write-Json $paths.Journal $journal
    $readers=@(
        @{name='configuration';path=$configPath;text=$config;read={Read-InterfaceConfigDocument $app};member='v';bad='2';good='1'},
        @{name='bundle manifest';path=$bundleManifestPath;text=$bundleManifest;read={Test-Bundle $app -SkipHelp};member='v';bad='2';good='1'},
        @{name='transaction journal';path=$paths.Journal;text=$journal;read={& $bundle {param($p) Read-BundleJournal $p} $paths};member='state';bad='"invalid"';good='"active"'}
    )
    foreach ($reader in $readers) {
        Case "$($reader.name) rejects incorrectly cased version field" {
            Write-Json $reader.path ($reader.text -replace '"v"\s*:', '"V":')
            Reject $reader.read "$($reader.name) uppercase version"
        }
        if ($reader.name -ne 'transaction journal') {
            Case "$($reader.name) rejects lossy version decimal" {
                Write-Json $reader.path ($reader.text -replace '"v"\s*:\s*1', '"v":1.0000000000000001')
                Reject $reader.read "$($reader.name) rounded version"
            }
        }
        Write-Json $reader.path $reader.text
    }
    Case 'configuration preserves ignored numeric metadata' {
        Write-Json $configPath ('{"bytes":6.9999999999999999,"files":[{"path":"core/ignored","bytes":9007199254740992}],"ui":{"v":1.0000000000000001},'+$config.Substring(1))
        Check ((Read-InterfaceConfigDocument $app).runtime.cli -ceq 'core/lodestar.mjs') 'Ignored metadata restricted admission.'
    }
    Write-Json $configPath $config
    Case 'configuration accepts exact decimal and exponent version spellings' {
        foreach ($token in @('1.0','10e-1','0.1e1')) {
            Write-Json $configPath ($config -replace '"v"\s*:\s*1', ('"v":'+$token))
            Check ((Read-InterfaceConfigDocument $app)['v'] -eq 1) 'Exact numeric version changed.'
        }
    }
    Write-Json $configPath $config
    Case 'bundle consumed numeric byte count rejects decimal rounding' {
        $text=$bundleManifest -replace '("bytes"\s*:\s*\d+)', '$1.0000000000000001'
        Write-Json $bundleManifestPath $text
        Reject {Test-Bundle $app -SkipHelp} 'rounded byte count'
    }
    Write-Json $bundleManifestPath $bundleManifest
    Case 'bundle preserves ignored numeric metadata' {
        $text='{"metadata":{"bytes":6.9999999999999999,"v":1.0000000000000001,"number":9007199254740992},'+$bundleManifest.Substring(1)
        Write-Json $bundleManifestPath $text
        Check ((Test-Bundle $app -SkipHelp).valid) 'Ignored bundle metadata restricted admission.'
    }
    Write-Json $bundleManifestPath $bundleManifest
    foreach ($reader in $readers) {
        foreach ($escaped in @($false,$true)) {
            $label=if ($escaped) {'escaped duplicate'} else {'duplicate'}
            Case "$($reader.name) rejects $label" {
                $second=if ($escaped) {'\u'+([int][char]$reader.member[0]).ToString('x4')+$reader.member.Substring(1)} else {$reader.member}
                $prefix='{"'+$reader.member+'":'+$reader.bad+',"'+$second+'":'+$reader.good+','
                $original=$reader.text -replace ('"'+$reader.member+'"\s*:\s*(?:"[^"]*"|\d+)\s*,?'),''
                $duplicate=$prefix+$original.Substring(1)
                Write-Json $reader.path $duplicate
                Reject $reader.read "$($reader.name) $label"
            }
        }
        Case "$($reader.name) rejects invalid UTF8" {
            $text=if ($reader.text.Contains('MARKER')) {$reader.text} else {'{"note":"MARKER",'+$reader.text.Substring(1)}
            Corrupt $reader.path $text
            Reject $reader.read "$($reader.name) malformed bytes"
        }
        Case "$($reader.name) rejects raw control character" {
            $text='{"extra":"line'+[char]10+'break",'+$reader.text.Substring(1)
            Write-Json $reader.path $text
            Reject $reader.read "$($reader.name) raw control"
        }
        Write-Json $reader.path $reader.text
    }
    Case 'configuration valid Unicode and UTF8 BOM remain accepted' {
        $text=$config.Replace('MARKER','music 漢字')
        [IO.File]::WriteAllText($configPath,$text,[Text.UTF8Encoding]::new($true))
        Check ((Read-InterfaceConfigDocument $app).note -ceq 'music 漢字') 'Valid Unicode or UTF8 BOM changed.'
    }
    Case 'configuration rejects UTF16 file bytes' {
        [IO.File]::WriteAllText($configPath,$config,[Text.UnicodeEncoding]::new($false,$true))
        Reject {Read-InterfaceConfigDocument $app} 'UTF16 configuration'
    }
    Case 'configuration case-distinct extension fields retain both values' {
        Write-Json $configPath ('{"Meta":1,"meta":2,'+$config.Substring(1))
        $value=Read-InterfaceConfigDocument $app
        Check ($value['Meta'] -eq 1 -and $value['meta'] -eq 2) 'Case-distinct fields were collapsed.'
    }
    Write-Json $configPath $config
    foreach ($escaped in @($false,$true)) {
        Case "CLI rejects duplicate ok escaped=$escaped" {
            $key=if ($escaped) {'\u006fk'} else {'ok'}
            $text='{"ok":false,"'+$key+'":true,"v":5,"operation":"help","data":{},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
            $result=Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')
            Check ($result.Kind -eq 'transport_error' -and $result.Code -eq 'invalid_envelope') 'CLI accepted duplicate ok.'
        }
    }
    Case 'CLI rejects nested duplicate response member' {
        $text='{"v":5,"ok":true,"operation":"help","data":{"nested":[{"a":1,"\u0061":2}]},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
        $result=Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')
        Check ($result.Kind -eq 'transport_error') 'CLI accepted nested duplicate.'
    }
    Case 'CLI preserves nested case-distinct response members' {
        $text='{"v":5,"ok":true,"operation":"help","data":{"A":1,"a":2},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
        $result=Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')
        Check ($result.Kind -eq 'success' -and $result.Envelope.data['A'] -eq 1 -and $result.Envelope.data['a'] -eq 2) 'CLI collapsed case-distinct members.'
    }
    Case 'CLI rejects lossy contract version decimal' {
        $text='{"v":5.0000000000000001,"ok":true,"operation":"help","data":{},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
        Check ((Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')).Kind -eq 'transport_error') 'Rounded contract version accepted.'
    }
    Case 'CLI rejects wrong-case operation field' {
        $text='{"v":5,"ok":true,"Operation":"help","data":{},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
        Check ((Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')).Kind -eq 'transport_error') 'Wrong-case operation accepted.'
    }
    Case 'CLI consumed numeric revision rejects decimal rounding and unsafe integer' {
        foreach ($revision in @('7.0000000000000001','9007199254740992')) {
            $text='{"v":5,"ok":true,"operation":"help","data":{},"revision":'+$revision+',"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
            Check ((Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')).Kind -eq 'transport_error') 'Invalid numeric revision admitted.'
        }
    }
    Case 'CLI preserves ignored numeric metadata' {
        $text='{"v":5,"ok":true,"operation":"help","data":{"legacy":1.0000000000000001,"bytes":9007199254740992},"revision":null,"database_instance_id":null,"database_epoch":null,"more":false,"next":[]}'
        Check ((Read-CliEnvelope @{Stdout=$text;Stderr='';ExitCode=0} 'help' @('--help')).Kind -eq 'success') 'Ignored numeric response metadata restricted admission.'
    }
    Case 'CLI child bytes reject invalid UTF8' {
        Reject {Invoke-CleanNode $node @('-e','process.stdout.write(Buffer.from([255]));')} 'malformed child bytes'
    }
    Case 'configuration full reader rejects NUL path' {
        $text=$config.Replace('"cli":"core/lodestar.mjs"','"cli":"core/\u0000lodestar.mjs"')
        Write-Json $configPath $text
        Reject {Read-InterfaceConfig $app} 'NUL path'
    }
    Write-Json $configPath $config
    [IO.File]::Delete($configPath)
    Write-Json $manifestPath $manifest
    Case 'distribution valid payload remains accepted' { Check ((Test-DistributionPayload $app).valid) 'Valid payload rejected.' }
    foreach ($escaped in @($false,$true)) {
        Case "distribution manifest rejects duplicate version escaped=$escaped" {
            $key=if ($escaped) {'\u0076ersion'} else {'version'}
            $text='{"version":"2.0.0","'+$key+'":"3.0.0",'+($manifest -replace '"version":"3.0.0",?','').Substring(1)
            Write-Json $manifestPath $text
            Reject {Test-DistributionPayload $app} 'duplicate distribution version'
        }
    }
    Case 'distribution manifest rejects invalid UTF8' {
        Corrupt $manifestPath $manifest
        Reject {Test-DistributionPayload $app} 'malformed manifest bytes'
    }
    Write-Json $manifestPath $manifest
    Case 'core package rejects consumed version case substitution' {
        Write-Json (Join-Path $app 'core/package.json') '{"Version":"3.0.0"}'
        $changed=$manifest | ConvertFrom-Json
        $entry=$changed.files | Where-Object path -eq 'core/package.json'
        $entry.bytes=([IO.FileInfo](Join-Path $app 'core/package.json')).Length
        $entry.sha256=(Get-FileHash -LiteralPath (Join-Path $app 'core/package.json')).Hash.ToLowerInvariant()
        Write-Json $manifestPath ($changed | ConvertTo-Json -Depth 8)
        Reject {Test-DistributionPayload $app} 'wrong-case consumed package version'
    }
    Write-Json (Join-Path $app 'core/package.json') '{"version":"3.0.0"}'
    Write-Json $manifestPath $manifest
    Case 'core package rejects duplicate version' {
        Write-Json (Join-Path $app 'core/package.json') '{"version":"2.0.0","version":"3.0.0"}'
        # Matching hashes ensure the package reader, rather than inventory checks, decides.
        $changed=$manifest | ConvertFrom-Json
        $entry=$changed.files | Where-Object path -eq 'core/package.json'
        $entry.bytes=([IO.FileInfo](Join-Path $app 'core/package.json')).Length
        $entry.sha256=(Get-FileHash -LiteralPath (Join-Path $app 'core/package.json')).Hash.ToLowerInvariant()
        Write-Json $manifestPath ($changed | ConvertTo-Json -Depth 8)
        Reject {Test-DistributionPayload $app} 'duplicate package version'
    }
    Case 'placeholder database unchanged' { Check ((Get-FileHash -LiteralPath $db).Hash -ceq $dbHash) 'Database placeholder changed.' }
    Case 'bundle rejects volume root target' { Reject {Get-BundlePaths ([IO.Path]::GetPathRoot($root))} 'volume root target' }
    if ($IsWindows) {
        Case 'bundle unavailable process snapshot has actionable refusal' {
            & $distribution { function script:Get-CimInstance { [CmdletBinding()] param($ClassName,$Filter) throw 'fixture snapshot unavailable' } }
            $message=''
            try { Assert-NotRunning @{Target=$app;Previous=(Join-Path $root 'retained previous')} } catch { $message=$_.Exception.Message }
            finally { & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance } }
            Check ($message.Contains($app) -and $message.Contains('retained previous') -and $message -match 'cannot verify.*in use' -and $message -match 'Next action:' -and $message -match 'pwsh -NoProfile -File' -and $message -match 'Recover' -and $message -match 'preserve') 'Snapshot denial lacked affected bundles and supported recovery action.'
            @{public_instructions=$message}
        }
        Case 'bundle idle guard rejects selected Manager child from process snapshot' {
            $script=Join-Path $app 'core/lodestar.mjs'
            Write-Json $script 'setTimeout(()=>{},15000);'
            $start=[Diagnostics.ProcessStartInfo]::new($node)
            $start.UseShellExecute=$false; $start.CreateNoWindow=$true
            $start.ArgumentList.Add($script); $start.ArgumentList.Add('manager')
            $process=[Diagnostics.Process]::Start($start)
            try {
                Check (-not $process.HasExited) 'Manager fixture did not remain active.'
                Set-NodeSnapshot @(@{ProcessId=$process.Id;CommandLine=('"'+$node+'" "'+$script+'" manager')})
                Reject {Assert-NotRunning @{Target=$app;Previous=(Join-Path $root 'absent-previous')}} 'active selected Manager' 'Close Manager'
            } finally {
                & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance }
                if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
                $process.Dispose()
            }
        }
        Case 'bundle idle guard rejects previous Manager and permits unrelated process snapshot' {
            $previous=Join-Path $root 'previous bundle'
            [IO.Directory]::CreateDirectory((Join-Path $previous 'core')) | Out-Null
            $script=Join-Path $previous 'core/lodestar.mjs'
            Write-Json $script 'setTimeout(()=>{},15000);'
            $start=[Diagnostics.ProcessStartInfo]::new($node)
            $start.UseShellExecute=$false; $start.CreateNoWindow=$true
            $start.ArgumentList.Add($script); $start.ArgumentList.Add('manager')
            $process=[Diagnostics.Process]::Start($start)
            try {
                Check (-not $process.HasExited) 'Previous Manager fixture did not remain active.'
                Set-NodeSnapshot @(@{ProcessId=$process.Id;CommandLine=('"'+$node+'" "'+$script+'" manager')})
                Assert-NotRunning @{Target=$app;Previous=(Join-Path $root 'unrelated')}
                Reject {Assert-NotRunning @{Target=$app;Previous=$previous}} 'active previous Manager' 'Close Manager'
            } finally {
                & $distribution { Remove-Item -LiteralPath Function:script:Get-CimInstance }
                if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit() }
                $process.Dispose()
            }
        }
        Case 'transaction rejects dangling junction target before writing' {
            $destination=Join-Path $root 'junction-target'
            $linked=Join-Path $root 'linked-target'
            [IO.Directory]::CreateDirectory($linked) | Out-Null
            New-Item -ItemType Junction -Path $destination -Value $linked | Out-Null
            [IO.Directory]::Delete($linked)
            $message=''
            try {
                $junctionPaths=Get-BundlePaths $destination
                New-BundleTransaction $junctionPaths | Out-Null
            } catch { $message=$_.Exception.Message }
            Check ($message -match 'Reparse path') 'Dangling junction target was accepted.'
            Check (-not [IO.File]::Exists("$destination.lodestar-journal.json") -and -not [IO.Directory]::Exists("$destination.lodestar-stage")) 'Admission rejection left transaction state.'
            [IO.Directory]::Delete($destination)
        }
    }
} finally {
    $failed=@($results | Where-Object status -eq 'fail').Count
    if (-not $KeepArtifacts -and $failed -eq 0) {
        $resolved=[IO.Path]::GetFullPath($root)
        Check ($resolved -ceq $root -and $resolved.StartsWith($lodestarTestParent+'\',[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved) -like '.json-admission-test-*') 'Cleanup containment failed.'
        Assert-Child $lodestarTestParent $resolved | Out-Null
        @(Get-PlainFiles $resolved) | Out-Null
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
@{tests=@($results);passed=@($results | Where-Object status -eq 'pass').Count;failed=$failed;artifacts=$(if ($KeepArtifacts -or $failed) {$root} else {$null})} | ConvertTo-Json -Depth 8
if ($results.Count -eq 0) { throw 'No matching admission cases.' }
if ($failed) { exit 1 }
