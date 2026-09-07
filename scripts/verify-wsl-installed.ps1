param([string] $Distribution, [string] $Launcher = "lodestar")
$ErrorActionPreference = "Stop"
$wslOptions = @()
if ($Distribution) { $wslOptions = @("-d", $Distribution) }
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $tempRoot ("lodestar-wsl-e2e-" + [guid]::NewGuid().ToString("N"))
$project = Join-Path $directory "project"
New-Item -ItemType Directory -Path $project -Force | Out-Null

function ConvertTo-WslPath([string] $Path) {
    $converted = & wsl.exe @wslOptions --exec wslpath -u ($Path -replace "\\", "/")
    if ($LASTEXITCODE -ne 0) { throw "Could not translate fixture path: $Path" }
    return ($converted -join "").Trim()
}
function Invoke-WslLodestar {
    param([string[]] $Arguments, $Body = $null)
    if ($null -ne $Body) {
        $inputFile = Join-Path $directory ("input-" + [guid]::NewGuid().ToString("N") + ".json")
        [IO.File]::WriteAllText($inputFile, ($Body | ConvertTo-Json -Depth 100 -Compress), [Text.UTF8Encoding]::new($false))
        $Arguments += @("--file", (ConvertTo-WslPath $inputFile))
    }
    $output = & wsl.exe @wslOptions --cd $projectWsl --exec bash -lc 'exec "$@"' lodestar-check $Launcher @Arguments
    if ($LASTEXITCODE -ne 0) { throw "WSL Lodestar failed: $($Arguments -join ' ')`n$($output -join "`n")" }
    $envelope = ($output -join "`n") | ConvertFrom-Json
    if ($envelope.ok -ne $true -or $envelope.v -ne 5) { throw "Expected a successful contract-5 envelope" }
    return $envelope
}
function New-MutationRequest {
    param([string] $Id, $InputValue, [switch] $Existing)
    $basis = (Invoke-WslLodestar (@("start") + $stateOptions)).data.write_basis
    $expected = $null
    if ($Existing) {
        $recordBasis = (Invoke-WslLodestar (@("get", $Id) + $databaseOption)).data.write_basis
        $expected = ($recordBasis.targets | Where-Object { $_.kind -eq "record" -and $_.id -eq $Id }).expected_revision
    }
    $basis.targets = @($basis.targets) + @(@{ kind = "record"; id = $Id; expected_revision = $expected })
    return @{ v = 5; request_id = [guid]::NewGuid().ToString("N"); write_basis = $basis; input = $InputValue }
}

try {
    $database = Join-Path $directory "lodestar.db"
    $databaseWsl = ConvertTo-WslPath $database
    $projectWsl = ConvertTo-WslPath $project
    $databaseOption = @("--db", $databaseWsl)
    $stateOptions = $databaseOption + @("--cwd", $projectWsl)
    $identity = @("--session", "wsl-fixture", "--agent", "codex", "--harness", "codex")
    $operations = @()
    $operations += (Invoke-WslLodestar (@("init") + $databaseOption)).operation
    $start = Invoke-WslLodestar (@("start") + $stateOptions)
    $projectScope = $start.data.project.scope
    $record = @{ id = "wsl:fact"; kind = "fact"; name = "WSL fact"; scope = $projectScope
        availability = "known"; data = @{ text = "cross-boundary needle" }
        aliases = @("wsl fact alias"); links = @(); sources = @() }
    $request = New-MutationRequest "wsl:fact" @{ mode = "create"; record = $record }
    $created = Invoke-WslLodestar (@("put") + $databaseOption) $request
    $operations += $created.operation
    $replayed = Invoke-WslLodestar (@("put") + $databaseOption) $request
    if ($replayed.request.replayed -ne $true -or $replayed.revision -ne $created.revision) {
        throw "Replaying the same accepted request changed state"
    }
    foreach ($arguments in @(@("get", "wsl fact alias"), @("find", "needle"), @("export"), @("doctor"))) {
        $operations += (Invoke-WslLodestar ($arguments + $databaseOption)).operation
    }
    $request = New-MutationRequest "work:wsl" @{ id = "work:wsl"; description = "WSL integration proof" }
    $operations += (Invoke-WslLodestar (@("work", "start") + $stateOptions + $identity) $request).operation
    $request = New-MutationRequest "work:wsl" @{ id = "work:wsl"; outcome = "completed"
        description = "Installed boundary exercised"; action_id = "wsl-proof" } -Existing
    $operations += (Invoke-WslLodestar (@("work", "done") + $stateOptions + $identity) $request).operation

    $checkpoint = @{ objective = "Exercise installed WSL transport"; current_state = "Saved checkpoint"
        completed_results = @("CLI record replay passed"); unresolved_work = @("Claim explicitly"); references = @("work:wsl") }
    $request = New-MutationRequest "handoff:wsl" @{ id = "handoff:wsl"; checkpoint = $checkpoint }
    $operations += (Invoke-WslLodestar (@("handoff", "arm") + $stateOptions + $identity) $request).operation
    $before = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash
    $null = Invoke-WslLodestar (@("start") + $stateOptions + $identity)
    if ((Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -ne $before) { throw "Startup mutated the store" }
    $armed = Invoke-WslLodestar (@("get", "handoff:wsl") + $databaseOption)
    if ($armed.data.data.state -ne "open") { throw "Startup changed the unclaimed handoff" }
    $request = New-MutationRequest "handoff:wsl" @{ id = "handoff:wsl" } -Existing
    $claimed = Invoke-WslLodestar (@("handoff", "claim") + $stateOptions + $identity) $request
    if ($claimed.data.record.data.state -ne "claimed") { throw "Explicit claim failed" }
    $operations += $claimed.operation
    $request = New-MutationRequest "wsl:fact" @{ id = "wsl:fact"; reason = "Fixture completed" } -Existing
    $operations += (Invoke-WslLodestar (@("delete") + $databaseOption) $request).operation
    $final = Invoke-WslLodestar (@("doctor") + $databaseOption)
    if ($final.data.healthy -ne $true) { throw "The isolated fixture store is not healthy" }
    [pscustomobject]@{ operations = $operations; final_healthy = $final.data.healthy
        replay_verified = $true; startup_read_only = $true; explicit_claim_verified = $true
        database_bytes = (Get-Item -LiteralPath $database).Length } | ConvertTo-Json -Depth 5
} finally {
    $resolved = [IO.Path]::GetFullPath($directory)
    if (-not $resolved.StartsWith(($tempRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a WSL fixture outside the temporary directory"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
