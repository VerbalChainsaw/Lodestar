$ErrorActionPreference = "Stop"

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $tempRoot ("lodestar-wsl-e2e-" + [guid]::NewGuid().ToString("N"))
$project = Join-Path $directory "project"
New-Item -ItemType Directory -Path $project -Force | Out-Null

function Invoke-WslLodestar {
    param([string[]] $Arguments, [string] $InputText = "")

    if ($InputText) {
        $inputFile = Join-Path $directory ("input-" + [guid]::NewGuid().ToString("N") + ".json")
        [IO.File]::WriteAllText($inputFile, $InputText, [Text.UTF8Encoding]::new($false))
        $inputWsl = (wsl.exe -d Ubuntu -- wslpath -u ($inputFile -replace "\\", "/")).Trim()
        $Arguments += @("--file", $inputWsl)
    }
    $output = & wsl.exe -d Ubuntu -- /home/phixx/.local/bin/lodestar @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "WSL Lodestar failed: $($Arguments -join ' ')`n$($output -join "`n")"
    }
    $envelope = ($output -join "`n") | ConvertFrom-Json
    if ($envelope.ok -ne $true) {
        throw "WSL Lodestar returned a failure envelope: $($output -join "`n")"
    }
    return $envelope
}

try {
    $database = Join-Path $directory "lodestar.db"
    $databaseWsl = (wsl.exe -d Ubuntu -- wslpath -u ($database -replace "\\", "/")).Trim()
    $projectWsl = (wsl.exe -d Ubuntu -- wslpath -u ($project -replace "\\", "/")).Trim()
    $databaseOption = @("--db", $databaseWsl)
    $stateOptions = $databaseOption + @("--cwd", $projectWsl)
    $operations = @()

    $operations += (Invoke-WslLodestar (@("start") + $stateOptions + @(
        "--session", "wsl-start", "--agent", "codex", "--harness", "codex"
    ))).operation
    $target = @{
        id = "wsl:target"; type = "note"; name = "WSL target"; scope = "global"
        content = @{ state = "known"; value = @{ text = "cross-boundary needle" } }
        aliases = @("wsl target alias"); links = @(); sources = @()
    } | ConvertTo-Json -Depth 8 -Compress
    $source = @{
        id = "wsl:source"; type = "note"; name = "WSL source"; scope = "global"
        content = @{ state = "known"; value = @{ text = "linked source" } }
        aliases = @(); links = @(@{ relationship = "depends_on"; to_id = "wsl:target" })
        sources = @()
    } | ConvertTo-Json -Depth 8 -Compress
    $operations += (Invoke-WslLodestar (@("put") + $databaseOption) $target).operation
    $operations += (Invoke-WslLodestar (@("put") + $databaseOption) $source).operation

    foreach ($arguments in @(
        @("get", "wsl target alias"), @("find", "needle", "--limit", "10"),
        @("links", "wsl:source"), @("export"), @("doctor")
    )) {
        $operations += (Invoke-WslLodestar ($arguments + @("--db", $databaseWsl))).operation
    }

    $identity = @("--session", "wsl-work", "--agent", "codex", "--harness", "codex")
    $operations += (Invoke-WslLodestar (@("work", "start", "WSL integration proof") +
        $stateOptions + $identity)).operation
    $operations += (Invoke-WslLodestar (@("work", "status") + $stateOptions)).operation
    $operations += (Invoke-WslLodestar (@("work", "done", "complete") +
        $stateOptions + $identity)).operation
    $operations += (Invoke-WslLodestar (@("work", "history", "--limit", "10") +
        $stateOptions)).operation

    $packet = '{"goal":"Claim through the installed WSL shim","next":["continue"]}'
    $operations += (Invoke-WslLodestar @(
        "handoff", "validate", "--db", $databaseWsl
    ) $packet).operation
    $operations += (Invoke-WslLodestar (@("handoff", "save") + $stateOptions + @(
        "--session", "wsl-source", "--agent", "codex", "--harness", "codex"
    )) $packet).operation
    $operations += (Invoke-WslLodestar (@("handoff", "status") + $stateOptions)).operation
    $claimed = Invoke-WslLodestar (@("start") + $stateOptions + @(
        "--session", "wsl-claimant", "--agent", "codex", "--harness", "codex"
    ))
    if ($claimed.data.handoff.data.state -ne "claimed" -or
        $claimed.data.handoff.data.claimed_by -ne "wsl-claimant") {
        throw "WSL startup did not claim the pending handoff"
    }
    $operations += $claimed.operation
    $operations += (Invoke-WslLodestar (@("handoff", "clear") + $stateOptions + @(
        "--session", "wsl-claimant", "--agent", "codex", "--harness", "codex"
    ))).operation
    $operations += (Invoke-WslLodestar @(
        "delete", "wsl:source", "--db", $databaseWsl
    )).operation
    $final = Invoke-WslLodestar @("doctor", "--db", $databaseWsl)

    [pscustomobject]@{
        operations = $operations
        final_healthy = $final.data.healthy
        records = $final.data.counts.records
        database_bytes = (Get-Item -LiteralPath $database).Length
    } | ConvertTo-Json -Depth 5
} finally {
    $resolved = [IO.Path]::GetFullPath($directory)
    if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a WSL fixture outside the temporary directory"
    }
    [IO.Directory]::Delete($resolved, $true)
}
