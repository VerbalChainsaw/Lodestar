Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-PlainPath([string]$Path) {
    $walk = [IO.Path]::GetFullPath($Path)
    while ($walk) {
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($walk) }
        catch [IO.FileNotFoundException] { }
        catch [IO.DirectoryNotFoundException] { }
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse path is not allowed: $walk"
        }
        $next = [IO.Path]::GetDirectoryName($walk)
        if (-not $next -or $next -eq $walk) { break }
        $walk = $next
    }
}

function Assert-ExactIntegerVersion([System.Text.Json.JsonElement]$Root,[long]$Expected) {
    $number=[System.Text.Json.JsonElement]::new()
    if (-not $Root.TryGetProperty('v',[ref]$number) -or $number.ValueKind -ne [System.Text.Json.JsonValueKind]::Number) { return }
    $token=$number.GetRawText()
    $null=$token -match '\A(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?\z'
    $negative=$Matches[1] -eq '-'; $fraction=[string]$Matches[3]
    $digits=([string]$Matches[2]+$fraction).TrimStart('0')
    $exponentText=([string]$Matches[4]).TrimStart([char[]]@('+','-')).TrimStart('0')
    # A version can equal its small integer only when its exponent can be
    # balanced by the mantissa's digits. Reject larger magnitudes before parsing.
    if ($exponentText.Length -gt $token.Length.ToString([Globalization.CultureInfo]::InvariantCulture).Length) {
        throw 'Consumed JSON /v must retain its exact numeric version.'
    }
    $exponent=if ($exponentText) { [Numerics.BigInteger]::Parse($exponentText,[Globalization.CultureInfo]::InvariantCulture) } else { [Numerics.BigInteger]::Zero }
    if (([string]$Matches[4]).StartsWith('-')) { $exponent=-$exponent }
    $exponent-=$fraction.Length
    if (-not $digits) { $digits='0'; $exponent=[Numerics.BigInteger]::Zero }
    else {
        $trimmed=$digits.TrimEnd('0'); $exponent+=$digits.Length-$trimmed.Length; $digits=$trimmed
    }
    $expectedText=$Expected.ToString([Globalization.CultureInfo]::InvariantCulture)
    if ($negative -or $exponent -lt 0 -or $exponent -gt $expectedText.Length -or
        $digits.Length+$exponent -ne $expectedText.Length -or
        ($digits+('0'*[int]$exponent)) -cne $expectedText) { throw 'Consumed JSON /v must retain its exact numeric version.' }
}

function Assert-ExactJsonFields([System.Text.Json.JsonElement]$Object,[string[]]$Names) {
    if ($Object.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { return }
    foreach ($name in $Names) {
        $value=[System.Text.Json.JsonElement]::new()
        if (-not $Object.TryGetProperty($name,[ref]$value)) { throw "Consumed JSON field requires exact case: $name" }
    }
}

function ConvertFrom-StrictJson([string]$Text,[switch]$AsHashtable,[string]$Contract='') {
    # Validate the original document before ConvertFrom-Json can collapse a
    # repeated member or accept non-JSON control characters and comments.
    $options=[System.Text.Json.JsonDocumentOptions]::new()
    $options.MaxDepth=1024
    $document=[System.Text.Json.JsonDocument]::Parse($Text,$options)
    try {
        $pending=[Collections.Generic.Stack[System.Text.Json.JsonElement]]::new()
        $pending.Push($document.RootElement)
        while ($pending.Count) {
            $element=$pending.Pop()
            if ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
                $names=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                foreach ($property in $element.EnumerateObject()) {
                    if (-not $names.Add($property.Name)) { throw 'JSON contains a duplicate decoded member name.' }
                    $pending.Push($property.Value)
                }
            } elseif ($element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                foreach ($item in $element.EnumerateArray()) { $pending.Push($item) }
            }
        }
        $root=$document.RootElement
        if ($Contract -and $root.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
            $required=switch ($Contract) {
                'configuration' { @('v','generation','runtime') }
                'bundle' { @('v','files') }
                'distribution' { @('v','version','files') }
                'journal' { @('v','id','target','stage','previous','stage_manifest_sha256') }
                'package' { @('version') }
            }
            if ($required) { Assert-ExactJsonFields $root $required }
            if ($Contract -ne 'package') { Assert-ExactIntegerVersion $root $(if ($Contract -eq 'envelope') {5} else {1}) }
            if ($Contract -in @('bundle','distribution')) {
                $files=[System.Text.Json.JsonElement]::new()
                if ($root.TryGetProperty('files',[ref]$files) -and $files.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
                    foreach ($file in $files.EnumerateArray()) { Assert-ExactJsonFields $file @('path','bytes','sha256') }
                }
            }
            if ($Contract -eq 'journal') {
                foreach ($name in @('state','target_manifest_sha256','previous_manifest_sha256','previous_inventory')) {
                    $value=[System.Text.Json.JsonElement]::new()
                    if (-not $root.TryGetProperty($name,[ref]$value)) {
                        foreach ($property in $root.EnumerateObject()) {
                            if ($property.Name -ieq $name) { throw "Consumed JSON field requires exact case: $name" }
                        }
                    }
                }
            }
        }
    } finally { $document.Dispose() }
    ConvertFrom-Json -InputObject $Text -AsHashtable:$AsHashtable -ErrorAction Stop
}

function Read-StrictJsonFile([string]$Path,[switch]$AsHashtable,[string]$Contract='') {
    Assert-PlainPath $Path
    try {
        $text=[Text.UTF8Encoding]::new($false,$true).GetString([IO.File]::ReadAllBytes($Path))
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xfeff) { $text=$text.Substring(1) }
        ConvertFrom-StrictJson $text -AsHashtable:$AsHashtable -Contract $Contract
    } catch {
        throw "json_input_invalid: '$Path'. Next action: preserve this file and restore complete UTF8 JSON with unique member names from verified configuration or transaction evidence."
    }
}

function Get-WindowsCommandArguments([string]$CommandLine) {
    if (-not $CommandLine) { throw 'A Node process has no inspectable command line.' }
    if (-not ('LodestarDistributionCommandLine' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LodestarDistributionCommandLine {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    public static string[] Parse(string commandLine) {
        int count;
        var memory=CommandLineToArgvW(commandLine,out count);
        if(memory==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var arguments=new string[count];
            for(int i=0;i<count;i++) arguments[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size));
            return arguments;
        } finally { LocalFree(memory); }
    }
}
'@
    }
    [LodestarDistributionCommandLine]::Parse($CommandLine)
}

function Test-ProcessSnapshotExited([int]$ProcessId) {
    try { $observed=[Diagnostics.Process]::GetProcessById($ProcessId) }
    catch {
        # The local overload reports an expired/not-running PID specifically
        # with ArgumentException. Access or other inspection failures refuse.
        if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $true }
        throw
    }
    try { return $observed.HasExited }
    finally { $observed.Dispose() }
}

function Assert-BundleProcessesIdle([string[]]$Roots) {
    $loaders=@($Roots | ForEach-Object { Join-Path $_ 'Lodestar.Loader.exe' })
    $clis=@($Roots | ForEach-Object { Join-Path $_ 'core\lodestar.mjs' })
    foreach ($process in @(Get-Process -Name 'Lodestar.Loader' -ErrorAction SilentlyContinue)) {
        if (-not $process.Path) { throw 'Cannot determine a Loader process path; replacement refused.' }
        if ($loaders -icontains [IO.Path]::GetFullPath($process.Path)) {
            throw 'Close Loader before changing this bundle.'
        }
    }
    try { $nodeProcesses=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop) }
    catch {
        $affected=$Roots -join "', '"
        $target=$Roots[0].Replace("'","''")
        $install=(Join-Path $PSScriptRoot 'Install.ps1').Replace("'","''")
        $update=(Join-Path $PSScriptRoot 'Update.ps1').Replace("'","''")
        throw "cannot verify bundle in use: '$affected'. Process inspection is unavailable; replacement refused. Preserve the target, stage, previous and journal folders. Next action: rerun the originating command in a normal shell with process inspection available. For a retained owned installation transaction use pwsh -NoProfile -File '$install' -Mode Recover -Destination '$target'; for a retained portable update transaction use pwsh -NoProfile -File '$update' -Mode Recover -Destination '$target'. Inspect the reported state before retrying."
    }
    foreach ($process in $nodeProcesses) {
        $snapshotId=$null
        try {
            $value=$process.ProcessId
            if (($value -is [int] -or $value -is [uint32] -or $value -is [long]) -and $value -gt 0 -and $value -le [int]::MaxValue) {
                $snapshotId=[int]$value
            }
        } catch { }
        $identity=if ($null -ne $snapshotId) { "PID $snapshotId" } else { 'PID unavailable' }
        $commandLine=$null
        $cause='CommandLine unavailable'
        try { $commandLine=$process.CommandLine }
        catch { $cause="CommandLine property inspection failed ($($_.Exception.GetBaseException().GetType().Name))" }
        if (-not $commandLine) {
            if ($null -ne $snapshotId) {
                try {
                    if (Test-ProcessSnapshotExited $snapshotId) { continue }
                    $cause+=' for a live process'
                } catch {
                    $failure=$_.Exception.GetBaseException()
                    $cause+="; exit inspection failed ($($failure.GetType().Name), HResult $($failure.HResult))"
                }
            }
            throw "cannot verify bundle in use: Node process $identity; $cause. Replacement refused. Next action: preserve the bundle and retained update folders; inspect that PID in a shell with process command-line inspection available, then retry after the operation finishes."
        }
        try { $arguments=@(Get-WindowsCommandArguments $commandLine) }
        catch {
            $failure=$_.Exception.GetBaseException()
            throw "cannot verify bundle in use: Node process $identity; Windows argument parsing failed ($($failure.GetType().Name), HResult $($failure.HResult)). Replacement refused. Next action: preserve the bundle and retained update folders; inspect that PID in a shell with process command-line inspection available, then retry."
        }
        # Supported launchers pass the absolute CLI as the first Node operand.
        # Parse Windows quoting through the OS; path text inside -e code or a
        # longer script filename is not the selected entry point.
        for ($index=1;$index -lt $arguments.Count;$index++) {
            if (-not [IO.Path]::IsPathFullyQualified($arguments[$index])) { continue }
            try { $candidate=[IO.Path]::GetFullPath($arguments[$index]) }
            catch { continue }
            if ($clis -inotcontains $candidate) { continue }
            if ($index -ne 1) {
                throw 'cannot verify selected CLI entry point behind additional Node arguments; replacement refused. Next action: wait for the matching Node operation to finish, then retry the bundle update.'
            }
            if ($arguments.Count -gt 2 -and $arguments[2] -ceq 'manager') {
                throw 'Close Manager before changing this bundle.'
            }
            throw 'The selected Lodestar CLI is active; replacement refused. Next action: wait for the operation to finish, then retry the bundle update.'
        }
    }
}

function Test-DistributionPayload([string]$Root,[switch]$Configured) {
    if (-not [IO.Path]::IsPathFullyQualified($Root) -or -not [IO.Directory]::Exists($Root)) {
        throw 'Payload root must be an existing absolute directory.'
    }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    Assert-PlainPath $rootFull
    $manifestPath = Join-Path $rootFull 'distribution-manifest.json'
    Assert-PlainPath $manifestPath
    if (-not [IO.File]::Exists($manifestPath)) { throw 'Distribution manifest is missing.' }
    $manifest = Read-StrictJsonFile $manifestPath -Contract distribution
    if (($manifest.v -isnot [int] -and $manifest.v -isnot [long] -and $manifest.v -isnot [double]) -or $manifest.v -ne 1 -or [string]$manifest.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$' -or $null -eq $manifest.files) {
        throw "distribution_manifest_invalid_shape: '$manifestPath'. Next action: use a complete verified extraction; preserve the current application, configuration and database."
    }
    $packagePath = Join-Path $rootFull 'core\package.json'
    Assert-PlainPath $packagePath
    if (-not [IO.File]::Exists($packagePath) -or
        [string]((Read-StrictJsonFile $packagePath -Contract package).version) -cne [string]$manifest.version) {
        throw 'Distribution version differs from core/package.json.'
    }
    $listed = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($manifest.files)) {
        $name = [string]$entry.path
        if (-not $name -or $name.Contains('\') -or $name.StartsWith('/') -or
            @($name.Split('/')).Where({ $_ -in @('', '.', '..') }).Count -gt 0 -or
            $name -eq 'distribution-manifest.json' -or $name -match '(^|/)interfaces\.json$|(?i)\.(?:db|sqlite|sqlite3)(?:-wal|-shm)?$' -or
            -not $listed.Add($name) -or
            [string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or
            ($entry.bytes -isnot [int] -and $entry.bytes -isnot [long]) -or [long]$entry.bytes -lt 0) {
            throw "Invalid distribution manifest entry: $name"
        }
        $full = [IO.Path]::GetFullPath((Join-Path $rootFull $name.Replace('/','\')))
        Assert-PlainPath $full
        if (-not $full.StartsWith($rootFull + '\',[StringComparison]::OrdinalIgnoreCase) -or
            -not [IO.File]::Exists($full) -or
            ([IO.File]::GetAttributes($full) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            ([IO.FileInfo]$full).Length -ne [long]$entry.bytes -or
            (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine [string]$entry.sha256) {
            throw "Distribution file differs from manifest: $name"
        }
    }
    foreach ($required in @('Lodestar.Loader.exe','Lodestar.Loader.dll','Lodestar.Loader.deps.json',
        'Lodestar.Loader.runtimeconfig.json','core/lodestar.mjs','core/package.json',
        'bundle-manifest.json','BundleTools.psm1','DistributionTools.psm1','Setup.ps1',
        'Launch.ps1','Update.ps1','Setup.cmd','Loader.cmd','Manager.cmd','Update.cmd')) {
        if (-not $listed.Contains($required)) { throw "Required distribution file missing: $required" }
    }
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($rootFull)
    $actual = 0
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
            if (([IO.File]::GetAttributes($item) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Distribution contains a reparse path: $item"
            }
            if ([IO.Directory]::Exists($item)) { $pending.Push($item); continue }
            if (-not [IO.File]::Exists($item)) { throw "Unsupported distribution item: $item" }
            $relative = [IO.Path]::GetRelativePath($rootFull,$item).Replace('\','/')
            if ($relative -eq 'distribution-manifest.json') { continue }
            if ($Configured -and $relative -ceq 'interfaces.json') {
                Read-InterfaceConfigDocument $rootFull | Out-Null
                continue
            }
            if (-not $listed.Contains($relative)) {
                if ($relative -match '^\.interfaces-[0-9a-fA-F]{32}\.tmp$') {
                    throw "Unlisted distribution file: $relative. Setup may have been interrupted. Use a fresh verified extraction and retry there; preserve any existing interfaces.json and database. If initialization created the database, inspect it and rerun Setup without -InitializeDatabase; Setup validates it read-only."
                }
                throw "Unlisted distribution file: $relative"
            }
            $actual++
        }
    }
    if ($actual -ne $listed.Count) { throw 'Distribution inventory differs from manifest.' }
    return [pscustomobject]@{ valid=$true; version=$manifest.version; files=$actual;
        manifest_sha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function New-OwnedProcessJob {
    if (-not $IsWindows) { return [IntPtr]::Zero }
    if (-not ('LodestarDistributionJob' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LodestarDistributionJob {
    [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Io Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create() {
        var job=CreateJobObject(IntPtr.Zero,null);
        if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits=new Limits(); limits.Basic.Flags=0x2000;
        if(!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<Limits>())) {
            var error=Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
        }
        return job;
    }
}
'@
    }
    return [LodestarDistributionJob]::Create()
}

function Invoke-CleanNode([string]$Node,[string[]]$Arguments,[int]$TimeoutMs=15000,[int]$MaxOutputBytes=1048576) {
    if ($TimeoutMs -lt 1 -or $MaxOutputBytes -lt 1) { throw 'process_bounds_invalid. Next action: supply positive deadline and output bounds.' }
    $start = [Diagnostics.ProcessStartInfo]::new($Node)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.RedirectStandardInput = $true
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    # Match the child environment policy used by Launch.ps1 and interface-client.mjs.
    foreach ($key in @('CODEX_THREAD_ID','CODEX_SESSION_ID','CLAUDE_SESSION_ID','OPENCODE_SESSION_ID',
        'CODEX_AGENT_NAME','LODESTAR_AGENT','LODESTAR_HARNESS','LODESTAR_DB','NODE_OPTIONS','NODE_PATH')) {
        [void]$start.Environment.Remove($key)
    }
    $process = $null; $job = [IntPtr]::Zero; $dispatched = $false; $failureCode = 'launch_failed'
    $buffers = @([byte[]]::new(4096),[byte[]]::new(4096))
    $captured = @([IO.MemoryStream]::new(),[IO.MemoryStream]::new())
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        # The unnamed job contains only this invocation; closing it terminates
        # pipe-holding descendants after the immediate process has exited.
        $job = New-OwnedProcessJob
        $process = [Diagnostics.Process]::Start($start)
        if (-not $process) { throw 'start failed' }
        $dispatched = $true
        if ($job -ne [IntPtr]::Zero -and -not [LodestarDistributionJob]::AssignProcessToJobObject($job,$process.Handle)) {
            $failureCode = 'process_isolation_failed'; throw 'job assignment failed'
        }
        $process.StandardInput.Close()
        $failureCode = 'response_read_failed'
        $streams = @($process.StandardOutput.BaseStream,$process.StandardError.BaseStream)
        $pending = @($streams[0].ReadAsync($buffers[0],0,4096),$streams[1].ReadAsync($buffers[1],0,4096))
        $done = @($false,$false); $total = 0
        do {
            if ($clock.ElapsedMilliseconds -ge $TimeoutMs) { $failureCode = 'timeout'; throw 'deadline exceeded' }
            for ($i=0; $i -lt 2; $i++) {
                if (-not $done[$i] -and $pending[$i].IsCompleted) {
                    $count = $pending[$i].GetAwaiter().GetResult()
                    if ($count -eq 0) { $done[$i] = $true; continue }
                    $total += $count
                    if ($total -gt $MaxOutputBytes) { $failureCode = 'output_limit'; throw 'output limit exceeded' }
                    $captured[$i].Write($buffers[$i],0,$count)
                    $pending[$i] = $streams[$i].ReadAsync($buffers[$i],0,4096)
                }
            }
            if (-not ($process.HasExited -and $done[0] -and $done[1])) { Start-Sleep -Milliseconds 5 }
        } while (-not ($process.HasExited -and $done[0] -and $done[1]))
        $utf8 = [Text.UTF8Encoding]::new($false,$true)
        $stdout = $utf8.GetString($captured[0].ToArray()); $stderr = $utf8.GetString($captured[1].ToArray())
        return [pscustomobject]@{ ExitCode=$process.ExitCode; Stdout=$stdout; Stderr=$stderr; Output=$stdout; Dispatched=$true }
    } catch {
        $outcome = if ($dispatched) { 'The child was dispatched; any write outcome needs reconciliation.' } else { 'No child was dispatched.' }
        $failure = [InvalidOperationException]::new("$failureCode while running configured executable '$Node'. $outcome Next action: inspect the selected runtime and saved state; use read-only doctor validation before repeating initialization. Raw child output was not logged.")
        $failure.Data['Dispatched']=$dispatched; $failure.Data['Code']=$failureCode
        throw $failure
    } finally {
        if ($process) {
            try { if (-not $process.HasExited) { $process.Kill($true); $null=$process.WaitForExit(1000) } } catch { }
            $process.Dispose()
        }
        if ($job -ne [IntPtr]::Zero) { $null=[LodestarDistributionJob]::CloseHandle($job) }
        foreach ($stream in $captured) { $stream.Dispose() }
    }
}

function Get-CliObjectFragments([string]$Stream) {
    $lines=[Collections.Generic.List[string]]::new()
    $depth=0; $quoted=$false; $escaped=$false
    foreach ($line in ($Stream -split '\r?\n')) {
        $trimmed=$line.Trim().TrimStart([char]0xfeff).TrimStart()
        if (-not $lines.Count -and -not $trimmed.StartsWith('{')) { continue }
        $lines.Add($(if ($lines.Count) {$line} else {$trimmed}))
        foreach ($character in $line.ToCharArray()) {
            if ($quoted) {
                if ($escaped) { $escaped=$false }
                elseif ($character -eq '\') { $escaped=$true }
                elseif ($character -eq '"') { $quoted=$false }
            } elseif ($character -eq '"') { $quoted=$true }
            elseif ($character -eq '{') { $depth++ }
            elseif ($character -eq '}') { $depth-- }
        }
        if ($depth -le 0) {
            ($lines -join "`n").Trim()
            $lines.Clear(); $depth=0; $quoted=$false; $escaped=$false
        }
    }
    if ($lines.Count) { ($lines -join "`n").Trim() }
}

function Test-EnvelopeFields([string]$Text,$Parsed=$null) {
    $fields=@('v','ok','operation','error','data')
    if ($null -ne $Parsed) {
        if ($Parsed -isnot [System.Collections.IDictionary]) { return $false }
        foreach ($field in $fields) { if ($Parsed.Contains($field)) { return $true } }
        return $false
    }
    if (-not $Text.TrimStart().StartsWith('{')) { return $false }
    foreach ($match in [regex]::Matches($Text,'("(?:\\.|[^"\\])*")\s*:')) {
        try {
            $name=(ConvertFrom-StrictJson ('{"name":'+$match.Groups[1].Value+'}') -AsHashtable)['name']
            if ($fields -ccontains $name) { return $true }
        } catch { }
    }
    return $false
}

function Read-CliEnvelope($Result,[string]$Operation,[string[]]$Arguments,[bool]$IsWrite=$false) {
    $candidates = [Collections.Generic.List[object]]::new(); $labels = [Collections.Generic.HashSet[string]]::new()
    $malformed = $false
    foreach ($stream in @($Result.Stdout,$Result.Stderr)) {
        foreach ($fragment in @(Get-CliObjectFragments $stream)) {
            try {
                $parsed=ConvertFrom-StrictJson $fragment -AsHashtable -Contract envelope
                if (-not (Test-EnvelopeFields $fragment $parsed)) { continue }
                $candidates.Add($parsed)
            } catch { if (Test-EnvelopeFields $fragment) { $malformed=$true } }
        }
        foreach ($line in ($stream -split '\r?\n')) {
            $line=$line.Trim(); if (-not $line -or (Test-EnvelopeFields $line)) { continue }
            $null=$labels.Add($(if ($line -match '^(ExperimentalWarning|DeprecationWarning|Warning):') { $Matches[1] } else { 'child diagnostic text omitted' }))
        }
    }
    $code = if ($malformed) { 'invalid_envelope' } elseif ($candidates.Count -eq 0) { 'missing_envelope' } else { '' }
    foreach ($e in $candidates) {
        if ($e -isnot [System.Collections.IDictionary] -or ($e['v'] -isnot [long] -and $e['v'] -isnot [int] -and $e['v'] -isnot [double]) -or $e['v'] -ne 5 -or $e['ok'] -isnot [bool] -or $e['operation'] -cne $Operation -or
            $e['more'] -isnot [bool] -or $e['next'] -isnot [array] -or -not $e.Contains('revision') -or
            ($null -ne $e['revision'] -and ($e['revision'] -isnot [long] -and $e['revision'] -isnot [int] -or $e['revision'] -lt 0 -or $e['revision'] -gt 9007199254740991)) -or
            -not $e.Contains('database_instance_id') -or ($null -ne $e['database_instance_id'] -and $e['database_instance_id'] -isnot [string]) -or
            -not $e.Contains('database_epoch') -or ($null -ne $e['database_epoch'] -and $e['database_epoch'] -isnot [string]) -or
            ($e['ok'] -and $e['data'] -isnot [System.Collections.IDictionary]) -or
            (-not $e['ok'] -and ($e['error'] -isnot [System.Collections.IDictionary] -or $e['error']['code'] -isnot [string] -or $e['error']['message'] -isnot [string]))) { $code='invalid_envelope'; break }
    }
    if (-not $code -and $candidates.Count -ne 1) { $code='multiple_envelopes' }
    $envelope = if ($candidates.Count -eq 1) { $candidates[0] } else { $null }
    if (-not $code) {
        $diagnostics = @{doctor=@('doctor');'agents.verify'=@('agents','verify');setup=@('setup');'skills.verify'=@('skills','verify');'skills.status'=@('skills')}
        $values = @('--db','--output','--source','--cwd','--mode','--target','--home','--codex-root','--codex-home','--claude-home','--xdg-config-home','--hermes-home','--opencode-root','--wsl-shim','--posix-shim')
        $flags = @('--human','--apply','--replace-local','--migration-preflight','--recovery-preflight')
        $positionals = [Collections.Generic.List[string]]::new(); $validArgs=$true
        for ($i=0;$i -lt $Arguments.Count;$i++) {
            $token=$Arguments[$i]
            if ($token -in $values) { $i++; if ($i -ge $Arguments.Count -or $Arguments[$i].StartsWith('--')) { $validArgs=$false } }
            elseif ($token -in $flags) { continue }
            elseif ($token.StartsWith('--')) { $validArgs=$false }
            else { $positionals.Add($token) }
        }
        $diagnostic = $diagnostics.ContainsKey($Operation) -and $validArgs -and (($positionals -join '|') -ceq ($diagnostics[$Operation] -join '|'))
        if (($envelope.ok -and $Result.ExitCode -ne 0 -and -not ($Result.ExitCode -eq 4 -and $diagnostic)) -or (-not $envelope.ok -and $Result.ExitCode -eq 0)) { $code='inconsistent_exit' }
        # An error body cannot prove rejection when its process ended abnormally.
        # Keep the envelope for recovery; exit 1 is unclassified for dispatched writes.
        if (-not $envelope.ok -and (($Result.ExitCode -isnot [int] -and $Result.ExitCode -isnot [long]) -or
            $Result.ExitCode -lt 1 -or $Result.ExitCode -gt 5 -or ($IsWrite -and $Result.ExitCode -eq 1))) { $code='inconsistent_exit' }
    }
    if ($code) { return [pscustomobject]@{Kind='transport_error';Code=$code;Envelope=$envelope;Diagnostics=($labels -join '; ');MayHaveCommitted=$IsWrite} }
    $reported=$envelope['error']; $committed=$null
    if ($reported -and $reported['identifiers'] -is [System.Collections.IDictionary]) { $committed=$reported.identifiers['committed'] }
    if ($IsWrite -and -not $envelope.ok -and ($reported.code -cin @('response_delivery_failed','database_commit_outcome_unknown') -or
        ($committed -is [string] -and $committed -ceq 'unknown') -or ($committed -is [bool] -and $committed -eq $true))) {
        return [pscustomobject]@{Kind='transport_error';Code=$reported.code;Envelope=$envelope;Diagnostics=($labels -join '; ');MayHaveCommitted=$true}
    }
    return [pscustomobject]@{Kind=$(if ($envelope.ok) {'success'} else {'error'}); Code=$(if ($envelope.ok) {'ok'} else {$envelope.error.code});Envelope=$envelope;Diagnostics=($labels -join '; ');MayHaveCommitted=$false}
}

function Resolve-Node([string]$NodePath) {
    if (-not $NodePath) {
        $command = Get-Command node -ErrorAction SilentlyContinue
        if (-not $command) { throw 'Node.js 24.15.0 or newer is required. Supply -NodePath.' }
        $NodePath = $command.Source
    }
    if (-not [IO.Path]::IsPathFullyQualified($NodePath) -or -not [IO.File]::Exists($NodePath)) {
        throw 'NodePath must name an existing absolute node.exe.'
    }
    $node = [IO.Path]::GetFullPath($NodePath)
    if ([IO.Path]::GetFileName($node) -ine 'node.exe') { throw 'NodePath must name node.exe.' }
    $versionResult = Invoke-CleanNode $node @('--version')
    $versionText = $versionResult.Stdout.Trim()
    if ($versionResult.ExitCode -ne 0 -or $versionText -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
        throw 'Node version check failed.'
    }
    $version = [version]::new([int]$Matches[1],[int]$Matches[2],[int]$Matches[3])
    if ($version -lt [version]'24.15.0') { throw "Node.js 24.15.0 or newer is required; found $versionText." }
    return $node
}

function Test-X64PeExecutable([string]$Path) {
    if ([IO.Path]::GetFileName($Path) -ine 'dotnet.exe' -or -not [IO.File]::Exists($Path)) { return $false }
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 0x40) { return $false }
        $reader = [IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5a4d) { return $false }
        $stream.Position = 0x3c
        $header = $reader.ReadInt32()
        if ($header -lt 0x40 -or [long]$header -gt $stream.Length - 6) { return $false }
        $stream.Position = $header
        return ($reader.ReadUInt32() -eq 0x00004550 -and $reader.ReadUInt16() -eq 0x8664)
    } finally {
        $stream.Dispose()
    }
}

function Assert-DesktopRuntime {
    $command = Get-Command dotnet -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command -or -not (Test-X64PeExecutable $command.Source)) {
        throw '.NET 10 Windows Desktop Runtime (x64) is required; the selected dotnet host must be an x64 dotnet.exe.'
    }
    $probe = Invoke-CleanNode $command.Source @('--list-runtimes') -TimeoutMs 5000
    $runtimes = @($probe.Stdout -split '\r?\n')
    if ($probe.ExitCode -ne 0 -or -not @($runtimes | Where-Object { $_ -match '^Microsoft\.WindowsDesktop\.App 10\.' }).Count) {
        throw '.NET 10 Windows Desktop Runtime (x64) is required.'
    }
}

function Assert-ExternalDatabase([string]$Database,[string[]]$ProtectedRoots,[string]$FailureMessage='') {
    $databaseFull=[IO.Path]::GetFullPath($Database)
    Assert-PlainPath $databaseFull
    foreach($root in $ProtectedRoots){
        $protected=[IO.Path]::GetFullPath($root).TrimEnd('\','/')
        if($databaseFull.Equals($protected,[StringComparison]::OrdinalIgnoreCase) -or
            $databaseFull.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase)){
            if($FailureMessage){throw $FailureMessage}
            throw "database_inside_app: '$databaseFull' is inside '$protected'. Next action: preserve the selected database and configuration; select an external store outside the app, stage, previous and payload directories before retrying."
        }
    }
}

function Read-InterfaceConfigDocument([string]$Root) {
    $Root=[IO.Path]::GetFullPath($Root)
    $configPath = Join-Path $Root 'interfaces.json'
    if (-not [IO.File]::Exists($configPath)) { throw "config_missing: '$configPath'. Next action: run Setup.cmd in this bundle and select the existing database." }
    try { $config = Read-StrictJsonFile $configPath -AsHashtable -Contract configuration } catch { throw "config_invalid_json: '$configPath'. Next action: preserve this file, correct its UTF8 JSON syntax and unique member names using the retained configuration backup, or configure a fresh verified extraction against the existing database." }
    if ($config -isnot [System.Collections.IDictionary]) { throw "config_invalid_shape: '$configPath'. Next action: preserve this file and use a verified configuration backup or a fresh extraction." }
    $generation = [guid]::Empty
    foreach ($field in @('v','generation','runtime')) {
        $valid = switch ($field) {
            'v' { ($config['v'] -is [int] -or $config['v'] -is [long] -or $config['v'] -is [double]) -and $config['v'] -eq 1 }
            'generation' { $config['generation'] -is [string] -and $config['generation'] -match '\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z' }
            'runtime' { $config['runtime'] -is [System.Collections.IDictionary] }
        }
        if (-not $valid) { throw "config_invalid_field: '$configPath' field '$field'. Next action: restore this field from the retained configuration backup; keep the selected database unchanged." }
    }
    foreach ($field in @('node','cli','database')) {
        if ($config.runtime[$field] -isnot [string] -or [string]::IsNullOrWhiteSpace($config.runtime[$field])) { throw "config_invalid_field: '$configPath' runtime.$field. Next action: set this field to the correct existing path; preserve the database." }
    }
    return $config
}

function Read-InterfaceConfig([string]$Root) {
    $Root=[IO.Path]::GetFullPath($Root)
    $configPath = Join-Path $Root 'interfaces.json'
    $config = Read-InterfaceConfigDocument $Root
    $resolve = { param($value) [IO.Path]::GetFullPath($(if ([IO.Path]::IsPathRooted($value)) { $value } else { Join-Path $Root $value })) }
    $resolved = @{}
    foreach ($field in @('node','cli','database')) {
        try { $value = & $resolve $config.runtime[$field] } catch { throw "config_invalid_path: '$configPath' runtime.$field. Next action: correct the path syntax from the retained configuration; do not initialize or delete the database." }
        if($field -eq 'database'){Assert-ExternalDatabase $value @($Root,"$Root.lodestar-stage","$Root.lodestar-previous")}
        if (-not [IO.File]::Exists($value) -or ($field -eq 'cli' -and $value -ine (Join-Path $Root 'core\lodestar.mjs'))) {
            throw "config_path_unavailable: '$configPath' runtime.$field points to '$value'. Next action: select the existing $field path$(if ($field -eq 'cli') {' inside this verified bundle'}); preserve the original configuration and database. Use a fresh verified extraction if bundle files are missing."
        }
        $resolved[$field]=$value
    }
    return [pscustomobject]@{ Path=$configPath; Node=$resolved.node; Cli=$resolved.cli; Database=$resolved.database }
}

Export-ModuleMember -Function Assert-PlainPath,Assert-ExternalDatabase,Test-DistributionPayload,Invoke-CleanNode,Read-CliEnvelope,Resolve-Node,Assert-DesktopRuntime,Read-InterfaceConfig,Read-InterfaceConfigDocument,Read-StrictJsonFile,Assert-BundleProcessesIdle
