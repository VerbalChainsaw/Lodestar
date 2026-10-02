param(
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [Parameter(Mandatory=$true)][string]$NodePath,
    [Parameter(Mandatory=$true)][string]$CliPath
)
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($OutputDirectory)
$node = [IO.Path]::GetFullPath($NodePath)
$cli = [IO.Path]::GetFullPath($CliPath)
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$database = Join-Path $directory 'fixture.db'
function Invoke-Lodestar([string[]]$CommandArgs, [bool]$ExpectSuccess = $true) {
    $output = & $node $cli --db $database @CommandArgs 2>&1 | Out-String
    $result = $output | ConvertFrom-Json
    if ($ExpectSuccess -and ($LASTEXITCODE -ne 0 -or !$result.ok)) {
        throw "Lodestar $($CommandArgs[0]) failed: $output"
    }
    return $result
}
Invoke-Lodestar @('init') | Out-Null
function Add-Record([hashtable]$Record) {
    $missing = Invoke-Lodestar @('get', $Record.id) $false
    if ($missing.error.code -ne 'record_not_found') { throw "Expected a missing fixture record: $($Record.id)" }
    $request = @{
        v = 5
        request_id = 'fixture-' + [guid]::NewGuid().ToString('D')
        write_basis = $missing.error.identifiers.write_basis
        input = @{ mode = 'create'; record = $Record }
    }
    $file = Join-Path $directory (($Record.id -replace ':', '-') + '-create.json')
    $request | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $file -Encoding utf8
    Invoke-Lodestar @('put', '--file', $file) | Out-Null
}
$projectId = 'project:loader-fixture'
$semantics = @{ lifecycle = 'current'; context_role = 'orientation'; basis = 'asserted'; applicability = @{ project = $projectId; checkout = $null } }
Add-Record @{ id = $projectId; kind = 'project'; name = 'Loader fixture'; scope = 'global'; availability = 'known'; priority = 1; aliases = @(); links = @(); sources = @(); data = @{ roots = @($directory); description = 'Disposable project for Loader acceptance.'; status = 'active'; notes = 'Inspect current and retained history.' }; semantics = $semantics }
Add-Record @{ id = 'fact:loader-editable'; kind = 'fact'; name = 'Editable fixture fact'; scope = $projectId; availability = 'known'; priority = 1; aliases = @(); links = @(); sources = @(); data = @{ description = 'Edit this note through Loader.'; notes = 'Original'; nested = @{ version = 1 } }; semantics = $semantics }
Add-Record @{ id = 'fact:loader-global'; kind = 'fact'; name = 'Global knowledge fixture'; scope = 'global'; availability = 'known'; priority = 1; aliases = @(); links = @(); sources = @(); data = @{ description = 'This is not owned by a project.' }; semantics = @{ lifecycle = 'current'; context_role = 'on_demand'; basis = 'asserted'; applicability = @{ project = $null; checkout = $null } } }
Add-Record @{ id = 'project:loader-historical'; kind = 'project'; name = 'Older fixture'; scope = 'global'; availability = 'known'; priority = 1; aliases = @(); links = @(); sources = @(); data = @{ roots = @(); description = 'Historical project fixture.'; status = 'archived' }; semantics = @{ lifecycle = 'historical'; context_role = 'on_demand'; basis = 'asserted'; applicability = @{ project = 'project:loader-historical'; checkout = $null } } }
$prior = Invoke-Lodestar @('get', 'fact:loader-editable')
$historyRequest = @{
    v = 5
    request_id = 'fixture-' + [guid]::NewGuid().ToString('D')
    write_basis = $prior.data.write_basis
    input = @{ mode = 'update'; id = 'fact:loader-editable'; set = @{ data = @{ notes = 'Updated in disposable fixture' } }; remove = @() }
}
$historyFile = Join-Path $directory 'fixture-history-update.json'
$historyRequest | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $historyFile -Encoding utf8
Invoke-Lodestar @('put', '--file', $historyFile) | Out-Null
$config = @{
    v = 1
    generation = [guid]::NewGuid().ToString('D')
    runtime = @{ node = $node; cli = $cli; database = $database }
    loader = 'Lodestar.Loader.exe'
    ui = @{ last_project_id = $projectId; theme = 'system'; project_sort = 'name' }
}
$configPath = Join-Path $directory 'interfaces.json'
$config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding utf8
[pscustomobject]@{ config = $configPath; database = $database; projectId = $projectId; editableRecordId = 'fact:loader-editable' } | ConvertTo-Json -Compress
