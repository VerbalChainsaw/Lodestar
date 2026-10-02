[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundlePath,[switch]$KeepArtifacts)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath($BundlePath).TrimEnd('\')
Import-Module (Join-Path $source 'DistributionTools.psm1') -Force
Test-DistributionPayload $source | Out-Null
$node = Resolve-Node ''
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('lodestar-distribution-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
$results = [Collections.Generic.List[object]]::new()

function Assert-That([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function New-Case([string]$Name) {
    $case = Join-Path $testRoot $Name
    $app = Join-Path $case 'portable app'
    [IO.Directory]::CreateDirectory($case) | Out-Null
    [IO.Directory]::CreateDirectory($app) | Out-Null
    foreach ($file in [IO.Directory]::EnumerateFiles($source,'*',[IO.SearchOption]::AllDirectories)) {
        $relative = [IO.Path]::GetRelativePath($source,$file)
        $to = Join-Path $app $relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to)) | Out-Null
        [IO.File]::Copy($file,$to,$true)
    }
    Test-DistributionPayload $app | Out-Null
    return [pscustomobject]@{ Case=$case; App=$app; Db=(Join-Path $case 'fixture store.db') }
}
function Invoke-Setup($Fixture,[string[]]$Arguments) {
    $output = @(& pwsh -NoProfile -File (Join-Path $Fixture.App 'Setup.ps1') -NodePath $node -DatabasePath $Fixture.Db @Arguments 2>&1)
    return [pscustomobject]@{ Exit=$LASTEXITCODE; Output=($output | Out-String) }
}
function New-Database($Fixture) {
    $output = @(& $node (Join-Path $Fixture.App 'core\lodestar.mjs') init --db $Fixture.Db 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Disposable database initialization failed: $($output | Out-String)" }
}
function Run-Case([string]$Name,[scriptblock]$Body) {
    try {
        & $Body
        $results.Add([pscustomobject]@{ name=$Name; status='pass' })
    } catch {
        $results.Add([pscustomobject]@{ name=$Name; status='fail'; error=$_.Exception.Message })
    }
}

Run-Case 'existing_database_and_config_preservation' {
    $fixture = New-Case 'existing'
    New-Database $fixture
    $databaseBefore = (Get-FileHash -LiteralPath $fixture.Db -Algorithm SHA256).Hash
    $result = Invoke-Setup $fixture @()
    Assert-That ($result.Exit -eq 0) "Existing DB setup failed: $($result.Output)"
    $config = Join-Path $fixture.App 'interfaces.json'
    $before = (Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash
    $repeat = Invoke-Setup $fixture @()
    Assert-That ($repeat.Exit -ne 0) 'Repeat setup overwrote config.'
    Assert-That ((Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash -eq $before) 'Config bytes changed.'
    Assert-That ((Get-FileHash -LiteralPath $fixture.Db -Algorithm SHA256).Hash -eq $databaseBefore) 'Setup changed existing database bytes.'
    $selection = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
    Assert-That ($selection.runtime.database -eq $fixture.Db) 'Selected database changed.'
}
Run-Case 'missing_runtime_refused' {
    $fixture = New-Case 'missing-node'
    New-Database $fixture
    $missing = Join-Path $fixture.Case 'absent-node.exe'
    $output = @(& pwsh -NoProfile -File (Join-Path $fixture.App 'Setup.ps1') -NodePath $missing -DatabasePath $fixture.Db 2>&1)
    Assert-That ($LASTEXITCODE -ne 0) 'Missing Node was accepted.'
    Assert-That (-not [IO.File]::Exists((Join-Path $fixture.App 'interfaces.json'))) 'Missing Node created config.'
}
Run-Case 'new_store_requires_explicit_init' {
    $fixture = New-Case 'new-store'
    $refused = Invoke-Setup $fixture @()
    Assert-That ($refused.Exit -ne 0) 'Absent database was silently initialized.'
    Assert-That (-not [IO.File]::Exists($fixture.Db)) 'Absent database was created without opt-in.'
    $created = Invoke-Setup $fixture @('-InitializeDatabase')
    Assert-That ($created.Exit -eq 0) "Explicit new-store setup failed: $($created.Output)"
    Assert-That ([IO.File]::Exists($fixture.Db)) 'Explicit init did not create database.'
    Assert-That ([IO.File]::Exists((Join-Path $fixture.App 'interfaces.json'))) 'Explicit init did not create config.'
}
Run-Case 'setup_ignores_inherited_node_and_host_environment' {
    $existing = New-Case 'hostile-environment-existing'
    New-Database $existing
    $newStore = New-Case 'hostile-environment-new'
    $keys = @('NODE_OPTIONS','NODE_PATH','CODEX_THREAD_ID','CODEX_SESSION_ID',
        'CLAUDE_SESSION_ID','OPENCODE_SESSION_ID','CODEX_AGENT_NAME','LODESTAR_AGENT',
        'LODESTAR_HARNESS','LODESTAR_DB')
    $original = @{}
    $poisoned = @{}
    foreach ($key in $keys) { $original[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
    try {
        foreach ($key in $keys) {
            $poisoned[$key] = if ($key -eq 'NODE_OPTIONS') { '--require=lodestar-absent-preload-for-setup-test' }
                elseif ($key -eq 'NODE_PATH') { Join-Path $testRoot 'absent node modules' }
                else { 'hostile-setup-test-' + $key }
            [Environment]::SetEnvironmentVariable($key,$poisoned[$key],'Process')
        }
        Assert-That ((Resolve-Node $node) -eq $node) 'Node version check inherited a hostile environment.'
        $probe = Invoke-CleanNode $node @('-e',
            'process.stdout.write(JSON.stringify(Object.fromEntries(["NODE_OPTIONS","NODE_PATH","CODEX_THREAD_ID","CODEX_SESSION_ID","CLAUDE_SESSION_ID","OPENCODE_SESSION_ID","CODEX_AGENT_NAME","LODESTAR_AGENT","LODESTAR_HARNESS","LODESTAR_DB"].map(key => [key, process.env[key] ?? null]))))')
        Assert-That ($probe.ExitCode -eq 0) "Clean Node probe failed: $($probe.Output)"
        $childEnvironment = $probe.Output | ConvertFrom-Json
        foreach ($key in $keys) {
            Assert-That ($null -eq $childEnvironment.$key) "Node child inherited $key."
        }
        foreach ($key in $keys) {
            Assert-That ([Environment]::GetEnvironmentVariable($key,'Process') -ceq $poisoned[$key]) "Node version check changed parent $key."
        }
        $existingResult = Invoke-Setup $existing @()
        Assert-That ($existingResult.Exit -eq 0) "Existing-store setup inherited a hostile environment: $($existingResult.Output)"
        $newResult = Invoke-Setup $newStore @('-InitializeDatabase')
        Assert-That ($newResult.Exit -eq 0) "New-store setup inherited a hostile environment: $($newResult.Output)"
        Assert-That ([IO.File]::Exists($newStore.Db)) 'New-store setup did not initialize the disposable database.'
        foreach ($key in $keys) {
            Assert-That ([Environment]::GetEnvironmentVariable($key,'Process') -ceq $poisoned[$key]) "Setup changed parent $key."
        }
    } finally {
        foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key,$original[$key],'Process') }
    }
}
Run-Case 'database_inside_app_refused' {
    $fixture = New-Case 'internal-database'
    $inside = Join-Path $fixture.App 'inside.db'
    $output = @(& pwsh -NoProfile -File (Join-Path $fixture.App 'Setup.ps1') -NodePath $node -DatabasePath $inside -InitializeDatabase 2>&1)
    Assert-That ($LASTEXITCODE -ne 0) 'Database inside app was accepted.'
    Assert-That (-not [IO.File]::Exists($inside)) 'Internal database was initialized.'
    Assert-That (-not [IO.File]::Exists((Join-Path $fixture.App 'interfaces.json'))) 'Internal database selection created config.'
}
Run-Case 'database_reparse_parent_refused_before_init' {
    $fixture = New-Case 'junction-database'
    $real = Join-Path $fixture.Case 'real store'
    $alias = Join-Path $fixture.Case 'alias store'
    [IO.Directory]::CreateDirectory($real) | Out-Null
    New-Item -ItemType Junction -Path $alias -Target $real | Out-Null
    $database = Join-Path $alias 'new.db'
    $output = @(& pwsh -NoProfile -File (Join-Path $fixture.App 'Setup.ps1') -NodePath $node -DatabasePath $database -InitializeDatabase 2>&1)
    Assert-That ($LASTEXITCODE -ne 0) 'Database path through a junction was accepted.'
    Assert-That (($output | Out-String) -match 'Reparse path is not allowed') 'Junction rejection did not identify the path issue.'
    Assert-That (-not [IO.File]::Exists((Join-Path $real 'new.db'))) 'Database was initialized through a junction before rejection.'
    Assert-That (-not [IO.File]::Exists((Join-Path $fixture.App 'interfaces.json'))) 'Junction path created config.'
}
Run-Case 'interrupted_setup_temp_keeps_manifest_strict' {
    $fixture = New-Case 'interrupted-setup'
    $leftover = Join-Path $fixture.App '.interfaces-0123456789abcdef0123456789abcdef.tmp'
    [IO.File]::WriteAllText($leftover,'interrupted fixture')
    $result = Invoke-Setup $fixture @()
    Assert-That ($result.Exit -ne 0) 'Interrupted setup temporary file was accepted by the strict manifest.'
    Assert-That ($result.Output -match 'fresh verified extraction') 'Interrupted setup error lacks recovery guidance.'
    Assert-That (-not [IO.File]::Exists((Join-Path $fixture.App 'interfaces.json'))) 'Interrupted setup file created config.'
}
Run-Case 'launch_argument_boundaries' {
    $fixture = New-Case 'launch'
    New-Database $fixture
    $setup = Invoke-Setup $fixture @()
    Assert-That ($setup.Exit -eq 0) "Launch fixture setup failed: $($setup.Output)"
    $manager = (& pwsh -NoProfile -File (Join-Path $fixture.App 'Launch.ps1') -Mode Manager -DescribeOnly | Out-String) | ConvertFrom-Json
    Assert-That ($LASTEXITCODE -eq 0 -and $manager.arguments.Count -eq 4) 'Manager argument structure changed.'
    Assert-That ($manager.arguments[0] -eq (Join-Path $fixture.App 'core\lodestar.mjs')) 'Manager CLI path was split.'
    Assert-That ($manager.arguments[3] -eq (Join-Path $fixture.App 'interfaces.json')) 'Manager config path was split.'
    $loader = (& pwsh -NoProfile -File (Join-Path $fixture.App 'Launch.ps1') -Mode Loader -DescribeOnly | Out-String) | ConvertFrom-Json
    Assert-That ($LASTEXITCODE -eq 0 -and $loader.arguments.Count -eq 2) 'Loader argument structure changed.'
    Assert-That ($loader.arguments[0] -eq '--interface-config') 'Loader config flag changed.'
    Assert-That ($loader.arguments[1] -eq (Join-Path $fixture.App 'interfaces.json')) 'Loader config path was split.'
}
Run-Case 'loader_early_failure_is_not_success' {
    $fixture = New-Case 'early-loader-failure'
    New-Database $fixture
    $setup = Invoke-Setup $fixture @()
    Assert-That ($setup.Exit -eq 0) "Launch fixture setup failed: $($setup.Output)"
    # Node is a safe fast-failing stand-in: it rejects Loader's --interface-config.
    [IO.File]::Copy($node,(Join-Path $fixture.App 'Lodestar.Loader.exe'),$true)
    $output = @(& pwsh -NoProfile -File (Join-Path $fixture.App 'Launch.ps1') -Mode Loader 2>&1)
    Assert-That ($LASTEXITCODE -ne 0) 'Launcher reported success when its child immediately failed.'
    Assert-That (($output | Out-String) -match 'exited.*code|failed.*code') 'Launch error omitted the child exit code.'
}
Run-Case 'x86_or_script_dotnet_host_refused' {
    $fake = Join-Path $testRoot 'fake runtime'
    [IO.Directory]::CreateDirectory($fake) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fake 'dotnet.cmd'), "@echo off`r`necho Microsoft.WindowsDesktop.App 10.0.1 [C:\Program Files (x86)\dotnet\shared\Microsoft.WindowsDesktop.App]`r`n")
    $savedPath = $env:PATH
    try {
        $env:PATH = $fake + [IO.Path]::PathSeparator + $savedPath
        $failure = $null
        try { Assert-DesktopRuntime } catch { $failure = $_.Exception.Message }
        Assert-That ($failure -match 'selected dotnet host must be an x64 dotnet.exe') 'A script reporting an x86-only runtime did not fail the x64 host check.'
    } finally { $env:PATH = $savedPath }

    $x86 = Join-Path $testRoot 'x86 runtime'
    [IO.Directory]::CreateDirectory($x86) | Out-Null
    $hostPath = (Get-Command dotnet -CommandType Application).Source
    $bytes = [IO.File]::ReadAllBytes($hostPath)
    $header = [BitConverter]::ToInt32($bytes,0x3c)
    Assert-That ($header -ge 0x40 -and $header -le $bytes.Length - 6) 'Selected dotnet host lacks a bounded PE header fixture.'
    $bytes[$header + 4] = 0x4c
    $bytes[$header + 5] = 0x01
    $x86Host = Join-Path $x86 'dotnet.exe'
    [IO.File]::WriteAllBytes($x86Host,$bytes)
    try {
        $env:PATH = $x86 + [IO.Path]::PathSeparator + $savedPath
        $selectedHost = Get-Command dotnet -ErrorAction Stop | Select-Object -First 1
        Assert-That ($selectedHost.Source -eq $x86Host) 'x86 fixture was not selected from PATH.'
        $failure = $null
        try { Assert-DesktopRuntime } catch { $failure = $_.Exception.Message }
        Assert-That ($failure -match 'selected dotnet host must be an x64 dotnet.exe') 'An x86 PE dotnet host did not fail the x64 host check.'
    } finally { $env:PATH = $savedPath }
}
Run-Case 'invalid_update_refused_before_mutation' {
    $fixture = New-Case 'invalid-update'
    New-Database $fixture
    $setup = Invoke-Setup $fixture @()
    Assert-That ($setup.Exit -eq 0) "Update fixture setup failed: $($setup.Output)"
    $payload = New-Case 'invalid-payload'
    [IO.File]::AppendAllText((Join-Path $payload.App 'core\lodestar.mjs'),'tampered')
    $configHash = (Get-FileHash -LiteralPath (Join-Path $fixture.App 'interfaces.json') -Algorithm SHA256).Hash
    $output = @(& pwsh -NoProfile -File (Join-Path $payload.App 'Update.ps1') -Destination $fixture.App 2>&1)
    Assert-That ($LASTEXITCODE -ne 0) 'Tampered payload update succeeded.'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $fixture.App 'interfaces.json') -Algorithm SHA256).Hash -eq $configHash) 'Failed update changed config.'
    Assert-That (-not [IO.Directory]::Exists($fixture.App + '.lodestar-stage')) 'Invalid payload created a stage.'
}
Run-Case 'payload_config_entry_refused' {
    $payload = New-Case 'config-entry-payload'
    $inside = Join-Path $payload.App 'interfaces.json'
    [IO.File]::WriteAllText($inside,'{"v":1}',[Text.UTF8Encoding]::new($false))
    $manifestPath = Join-Path $payload.App 'distribution-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.files = @($manifest.files) + [pscustomobject]@{ path='interfaces.json'; bytes=([IO.FileInfo]$inside).Length;
        sha256=(Get-FileHash -LiteralPath $inside -Algorithm SHA256).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $refused = $false
    try { Test-DistributionPayload $payload.App | Out-Null } catch { $refused = $true }
    Assert-That $refused 'Manifest-listed interfaces.json was accepted.'
}
Run-Case 'payload_version_mismatch_refused' {
    $payload = New-Case 'version-mismatch-payload'
    $manifestPath = Join-Path $payload.App 'distribution-manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.version = '3.0.1'
    [IO.File]::WriteAllText($manifestPath,($manifest | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
    $refused = $false
    try { Test-DistributionPayload $payload.App | Out-Null } catch { $refused = $true }
    Assert-That $refused 'Manifest/package version mismatch was accepted.'
}
Run-Case 'valid_update_retains_previous' {
    $fixture = New-Case 'valid-update'
    New-Database $fixture
    $setup = Invoke-Setup $fixture @()
    Assert-That ($setup.Exit -eq 0) "Update fixture setup failed: $($setup.Output)"
    $payload = New-Case 'valid-payload'
    $configHash = (Get-FileHash -LiteralPath (Join-Path $fixture.App 'interfaces.json') -Algorithm SHA256).Hash
    $databaseHash = (Get-FileHash -LiteralPath $fixture.Db -Algorithm SHA256).Hash
    $output = @(& pwsh -NoProfile -File (Join-Path $payload.App 'Update.ps1') -Destination $fixture.App 2>&1)
    Assert-That ($LASTEXITCODE -eq 0) "Valid update failed: $($output | Out-String)"
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $fixture.App 'interfaces.json') -Algorithm SHA256).Hash -eq $configHash) 'Update changed config.'
    Assert-That ([IO.Directory]::Exists($fixture.App + '.lodestar-previous')) 'Previous version was not retained.'
    $recovery = @(& pwsh -NoProfile -File (Join-Path $payload.App 'Update.ps1') -Mode Recover -Destination $fixture.App 2>&1)
    Assert-That ($LASTEXITCODE -eq 0 -and ($recovery | Out-String) -match 'new_target_valid') 'Recovery command did not verify the completed transaction.'
    # Exercise the updated core through the preserved binding, rather than
    # treating unchanged config bytes as proof that runtime selection still works.
    $selected=Read-InterfaceConfig $fixture.App
    Assert-That ($selected.Cli -eq (Join-Path $fixture.App 'core/lodestar.mjs')) 'Updated binding selected another core.'
    Assert-That ($selected.Database -eq $fixture.Db) 'Updated binding selected another store.'
    $readArgs=@($selected.Cli,'--db',$selected.Database,'doctor')
    $result=Read-CliEnvelope (Invoke-CleanNode $selected.Node $readArgs) 'doctor' $readArgs $false
    Assert-That ($result.Kind -eq 'success' -and $result.Envelope.data.healthy -eq $true -and $result.Envelope.data.database -eq $fixture.Db) 'Updated selected core could not read the preserved database.'
    Assert-That ((Get-FileHash -LiteralPath $fixture.Db -Algorithm SHA256).Hash -eq $databaseHash) 'Update/recovery/read changed selected store bytes.'
    Test-DistributionPayload $payload.App | Out-Null
}

$failed = @($results | Where-Object status -eq 'fail').Count
[pscustomobject]@{ passed=@($results | Where-Object status -eq 'pass').Count; failed=$failed;
    tests=@($results); artifacts=$(if ($failed -or $KeepArtifacts) { $testRoot } else { $null }) } | ConvertTo-Json -Depth 8
if (-not $failed -and -not $KeepArtifacts) {
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolved.StartsWith($temp + '\',[StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolved) -notlike 'lodestar-distribution-test-*') {
        throw 'Disposable test cleanup path changed.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
if ($failed) { exit 1 }
