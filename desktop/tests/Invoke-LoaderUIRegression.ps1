param(
  [Parameter(Mandatory=$true)][string]$BundleRoot,
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [string]$WorkRoot,
  [ValidateSet('All','Recovery')][string]$CaseScope = 'All'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LoaderUiNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
[LoaderUiNative]::SetProcessDPIAware() | Out-Null
[LoaderUiNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

$script:app = $null
$script:stderrTask = $null
$script:ownedChildren = @{}
$script:activeCase = ''
$script:report = [ordered]@{v=1; result='INCOMPLETE'; case_scope=$CaseScope; full_suite=($CaseScope -eq 'All'); started_utc=[DateTimeOffset]::UtcNow.ToString('o');
  bundle=$null; fixture_root=$null; dll_sha256=$null; core_sha256=$null; manifest_sha256=$null;
  fixtures=@(); cases=@(); errors=@(); cleanup=@(); output=$null}
$script:bundle = $null
$script:node = $null
$script:cli = $null
$script:exe = $null
$script:run = $null
$script:reportPath = $null

function Full([string]$path) { return [IO.Path]::GetFullPath($path) }
function IsInside([string]$path,[string]$parent) {
  $boundary=(Full $parent).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  return (Full $path).StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)
}
function Assert([bool]$condition,[string]$message) { if (-not $condition) { throw $message } }
function Write-Report {
  if ($script:reportPath) {
    $script:report.finished_utc=[DateTimeOffset]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($script:reportPath,($script:report | ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
  }
}
function Pass([string]$name,[object]$evidence) {
  $script:report.cases += [ordered]@{name=$name;result='PASS';evidence=$evidence}
  Write-Report
}
function Wait-Until([scriptblock]$test,[string]$label,[int]$seconds=35) {
  $watch=[Diagnostics.Stopwatch]::StartNew(); $last=$null
  while ($watch.Elapsed.TotalSeconds -lt $seconds) {
    try { if (& $test) { return } } catch { $last=$_.Exception.Message }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out after ${seconds}s: $label. Last observation: $last"
}
function Read-Config([string]$path) { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) }
function Call-Core([string]$database,[string[]]$arguments) {
  Assert (IsInside $database $script:run) 'Core call database is outside the owned fixture run.'
  $prior=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try { $lines=@(& $script:node $script:cli --db $database @arguments 2>&1) }
  finally { $ErrorActionPreference=$prior }
  $code=$LASTEXITCODE
  $body=($lines | ForEach-Object { $_.ToString() }) -join "`n"
  try { $value=$body | ConvertFrom-Json } catch { throw "Packaged core $($arguments[0]) returned non-JSON (exit $code): $($body.Substring(0,[Math]::Min(500,$body.Length)))" }
  return [pscustomobject]@{code=$code;envelope=$value}
}
function Record([object]$fixture) {
  $result=Call-Core $fixture.database @('get','fact:loader-editable')
  Assert ($result.code -eq 0 -and $result.envelope.ok) 'Packaged core could not read editable fixture.'
  return $result.envelope
}
function New-Fixture([string]$name,[string]$delayOperation='') {
  $directory=Join-Path $script:run $name
  Assert (-not (Test-Path -LiteralPath $directory)) "Fixture root exists: $directory"
  $prior=$ErrorActionPreference; $ErrorActionPreference='Continue'
  try { $output=@(& $script:node (Join-Path $PSScriptRoot 'create-ui-fixture.mjs') $directory $script:cli $script:node $script:exe 2>&1) }
  finally { $ErrorActionPreference=$prior }
  $code=$LASTEXITCODE
  Assert ($code -eq 0) "Fixture generator failed ($code): $(($output|ForEach-Object {$_.ToString()}) -join ' ')"
  $fixture=(($output|ForEach-Object {$_.ToString()}) -join "`n") | ConvertFrom-Json
  Assert ((Full $fixture.database) -eq (Full (Join-Path $directory 'fixture.db'))) 'Fixture database provenance differs.'
  if ($delayOperation) {
    Assert ($delayOperation -in @('find','put')) 'Unsupported controlled operation.'
    $wrapper=Join-Path $directory 'controlled-cli.mjs'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'controlled-cli.mjs') -Destination $wrapper
    $marker=if($delayOperation -eq 'put'){'put-started.json'}else{'read-started.json'}
    $control=[ordered]@{packaged_cli=$script:cli;operation=$delayOperation;marker=$marker;delay_ms=25000}
    [IO.File]::WriteAllText((Join-Path $directory 'control.json'),($control|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $config=Read-Config $fixture.config; $config.runtime.cli=$wrapper
    [IO.File]::WriteAllText($fixture.config,($config|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
  }
  $configured=Read-Config $fixture.config
  $script:report.fixtures += [ordered]@{name=$name;config=$fixture.config;database=$fixture.database;
    configured_cli=$configured.runtime.cli;packaged_cli=$script:cli;
    config_sha256=(Get-FileHash -LiteralPath $fixture.config -Algorithm SHA256).Hash}
  Write-Report
  return $fixture
}
function Assert-AppIdentity {
  Assert ($null -ne $script:app) 'No owned Loader Process object.'
  $script:app.Refresh()
  $current=Get-Process -Id $script:app.Id -ErrorAction SilentlyContinue
  Assert ($null -ne $current) "Owned Loader PID $($script:app.Id) vanished."
  Assert ((Full $current.Path) -eq $script:exe) "PID $($script:app.Id) is not the exact selected Loader path."
  Assert ($current.StartTime.ToUniversalTime().Ticks -eq $script:app.StartTime.ToUniversalTime().Ticks) 'Owned Loader PID was reused.'
}
function Get-Window {
  Assert-AppIdentity
  Assert (-not $script:app.HasExited) "Loader exited before UI action with code $($script:app.ExitCode)."
  $script:app.Refresh()
  if ($script:app.MainWindowHandle -eq [IntPtr]::Zero) { return $null }
  $window=[System.Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
  Assert ($window.Current.ProcessId -eq $script:app.Id) 'Main window belongs to another process.'
  return $window
}
function Element([string[]]$ids) {
  $window=Get-Window
  if (!$window) { return $null }
  foreach ($id in $ids) {
    $condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::AutomationIdProperty),$id
    $found=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
    if ($found) { return $found }
  }
  return $null
}
function Visible([string[]]$ids) {
  $e=Element $ids
  return ($null -ne $e -and !$e.Current.IsOffscreen -and $e.Current.IsEnabled)
}
function Invoke-Id([string[]]$ids) {
  $e=Element $ids
  Assert ($null -ne $e -and $e.Current.IsEnabled -and !$e.Current.IsOffscreen) "Unavailable UI control: $($ids -join '/')"
  $pattern=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
}
function Send-OwnedKeys([string]$keys) {
  $window=Get-Window
  [LoaderUiNative]::SetForegroundWindow($script:app.MainWindowHandle) | Out-Null
  Wait-Until { [LoaderUiNative]::GetForegroundWindow() -eq $script:app.MainWindowHandle } 'owned keyboard foreground' 3
  Assert-AppIdentity
  [Windows.Forms.SendKeys]::SendWait($keys)
}
function Set-Id([string[]]$ids,[string]$value) {
  $e=Element $ids
  Assert ($null -ne $e -and $e.Current.IsEnabled) "Unavailable text field: $($ids -join '/')"
  ([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($value)
}
function Value-Id([string[]]$ids) {
  $e=Element $ids
  Assert ($null -ne $e) "Missing value field: $($ids -join '/')"
  return ([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value
}
function Name-Id([string[]]$ids) {
  $e=Element $ids
  Assert ($null -ne $e) "Missing text element: $($ids -join '/')"
  return $e.Current.Name
}
function Select-Child([string[]]$parentIds,[string]$name) {
  $parent=Element $parentIds
  Assert ($null -ne $parent) "Missing list: $($parentIds -join '/')"
  $all=$parent.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $matches=@($all | Where-Object { $_.Current.Name -like "*$name*" -and !$_.Current.IsOffscreen })
  foreach ($item in $matches) {
    $pattern=$null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
      ([System.Windows.Automation.SelectionItemPattern]$pattern).Select(); return $item
    }
  }
  throw "No selectable $name row in $($parentIds -join '/')."
}
function Select-Combo([string]$id,[string]$name) {
  $combo=Element @($id); Assert ($null -ne $combo) "Missing combo: $id"
  ([System.Windows.Automation.ExpandCollapsePattern]$combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)).Expand()
  $selected=$null
  $items=$combo.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  foreach($item in $items) {
    if ($item.Current.Name -ne $name) { continue }
    $pattern=$null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
      ([System.Windows.Automation.SelectionItemPattern]$pattern).Select(); $selected=$item; break
    }
  }
  Assert ($null -ne $selected) "No selectable $name option for $id."
  Wait-Until { ([System.Windows.Automation.SelectionItemPattern]$selected.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Current.IsSelected } "$id selected $name" 5
}
function Start-Ui([object]$fixture,[bool]$waitReady=$true) {
  Assert ($null -eq $script:app) 'A Loader window is already owned.'
  Assert (IsInside $fixture.config $script:run) 'Config path is outside the owned fixture run.'
  $config=Read-Config $fixture.config
  Assert ((Full $config.runtime.database) -eq (Full $fixture.database)) 'Config selected another database.'
  Assert ((Full $config.runtime.node) -eq $script:node) 'Config selected another Node.'
  Assert ((Full $config.runtime.cli) -eq $script:cli -or (IsInside $config.runtime.cli $fixture.root)) 'Config selected another CLI.'
  $journal=Join-Path $fixture.root 'journal'
  Assert (-not (Test-Path -LiteralPath $journal) -or (IsInside $journal $fixture.root)) 'Invalid journal path.'
  $psi=New-Object Diagnostics.ProcessStartInfo
  $psi.FileName=$script:exe; $psi.UseShellExecute=$false; $psi.RedirectStandardError=$true
  foreach($path in @($fixture.config,$journal)) { Assert (-not $path.Contains('"')) 'Quoted fixture path is unsupported.' }
  $psi.Arguments='--interactive-smoke --interface-config "'+$fixture.config+'" --journal-root "'+$journal+'" --project project:loader-fixture --record fact:loader-editable'
  $script:app=[Diagnostics.Process]::Start($psi)
  Assert ($null -ne $script:app) 'Loader process did not start.'
  $script:stderrTask=$script:app.StandardError.ReadToEndAsync()
  Assert-AppIdentity
  if ($waitReady) { Wait-Until { Visible @('EditRecord') } 'editable fixture detail' 45 }
}
function Track-Child([int]$id) {
  Assert-AppIdentity
  $info=Get-CimInstance Win32_Process -Filter "ProcessId = $id"
  Assert ($null -ne $info) "Expected owned child PID $id has exited before identity check."
  Assert ($info.ParentProcessId -eq $script:app.Id) "Child PID $id is not directly owned by Loader."
  $child=Get-Process -Id $id
  Assert ((Full $child.Path) -eq $script:node) "Owned child PID $id is not the selected Node executable."
  Assert ($child.StartTime -ge $script:app.StartTime) 'Child predates Loader start.'
  $script:ownedChildren[$id]=[ordered]@{id=$id;path=(Full $child.Path);start_ticks=$child.StartTime.ToUniversalTime().Ticks}
}
function Snapshot-Descendants {
  Assert-AppIdentity
  $queue=@($script:app.Id); $seen=@{}
  while($queue.Count -gt 0) {
    $parent=$queue[0]; $queue=@($queue | Select-Object -Skip 1)
    foreach($item in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parent")) {
      $id=[int]$item.ProcessId
      if($seen.ContainsKey($id)){continue}
      $seen[$id]=$true; $queue+=,$id
      $child=Get-Process -Id $id -ErrorAction SilentlyContinue
      if($child -and $child.StartTime -ge $script:app.StartTime) {
        $script:ownedChildren[$id]=[ordered]@{id=$id;path=(Full $child.Path);start_ticks=$child.StartTime.ToUniversalTime().Ticks}
      }
    }
  }
}
function Child-Alive([object]$entry) {
  $now=Get-Process -Id $entry.id -ErrorAction SilentlyContinue
  if (!$now) { return $false }
  Assert ((Full $now.Path) -eq $entry.path -and $now.StartTime.ToUniversalTime().Ticks -eq $entry.start_ticks) "Owned child PID $($entry.id) identity changed."
  return $true
}
function Assert-ChildrenGone {
  foreach ($entry in $script:ownedChildren.Values) { Assert (-not (Child-Alive $entry)) "Owned child PID $($entry.id) survived Loader exit." }
  $script:ownedChildren=@{}
}
function Click-Dialog([string]$choice) {
  Assert-AppIdentity
  $script:dialogMatches=@()
  Wait-Until {
    $condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty),$script:app.Id
    $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
    $script:dialogMatches=@()
    foreach($window in $windows) {
      $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
      foreach($e in $all) {
        if (($e.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -or $e.Current.ClassName -eq 'Button') -and
            $e.Current.Name -eq $choice -and $e.Current.IsEnabled -and !$e.Current.IsOffscreen) { $script:dialogMatches+=,$e }
      }
    }
    return $script:dialogMatches.Count -eq 1
  } "one native $choice dialog button on owned Loader" 8
  $matches=$script:dialogMatches
  $pattern=$null
  if ($matches[0].TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke(); return
  }
  $handle=[IntPtr]$matches[0].Current.NativeWindowHandle; [uint32]$dialogProcessId=0
  [LoaderUiNative]::GetWindowThreadProcessId($handle,[ref]$dialogProcessId) | Out-Null
  Assert ($handle -ne [IntPtr]::Zero -and $dialogProcessId -eq $script:app.Id -and $matches[0].Current.ClassName -eq 'Button') 'Dialog button native ownership is unverified.'
  [LoaderUiNative]::SendMessage($handle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
}
function Request-Close { $window=Get-Window; Assert ($null -ne $window) 'No owned main window to close.'
  Snapshot-Descendants
  ([System.Windows.Automation.WindowPattern]$window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Close() }
function Finish-Close([string]$branch) {
  Assert ($script:app.WaitForExit(7000)) "Loader did not exit after $branch."
  $code=$script:app.ExitCode; $stderr=$script:stderrTask.GetAwaiter().GetResult()
  Assert ($code -eq 0) "$branch exited with code $code; stderr: $stderr"
  Assert ([string]::IsNullOrWhiteSpace($stderr)) "$branch wrote stderr: $stderr"
  Wait-Until { foreach($entry in $script:ownedChildren.Values){if(Child-Alive $entry){return $false}}; return $true } 'owned child cleanup' 8
  Assert-ChildrenGone
  $script:app.Dispose(); $script:app=$null; $script:stderrTask=$null
}
function Cleanup-Owned {
  if (!$script:app) { return }
  try {
    $script:app.Refresh()
    if (!$script:app.HasExited) {
      Snapshot-Descendants
    }
    foreach($entry in $script:ownedChildren.Values) {
      if (Child-Alive $entry) { Stop-Process -Id $entry.id -Force; $script:report.cleanup+= "Stopped exact owned descendant PID $($entry.id)" }
    }
    if (!$script:app.HasExited) {
      Assert-AppIdentity
      Stop-Process -Id $script:app.Id -Force
      $script:report.cleanup+= "Stopped exact owned Loader PID $($script:app.Id)"
      $script:app.WaitForExit(5000) | Out-Null
    }
  } catch {
    $script:report.cleanup+= "Cleanup error: $($_.Exception.Message)"
    try {
      foreach($entry in $script:ownedChildren.Values) {
        if (Child-Alive $entry) { Stop-Process -Id $entry.id -Force; $script:report.cleanup+= "Stopped exact tracked descendant PID $($entry.id) after cleanup error" }
      }
      if ($script:app -and !$script:app.HasExited) { Assert-AppIdentity; Stop-Process -Id $script:app.Id -Force;
        $script:report.cleanup+= "Stopped exact owned Loader PID $($script:app.Id) after cleanup error" }
    } catch { $script:report.cleanup+= "Verified Loader fallback failed: $($_.Exception.Message)" }
  }
  finally { $script:app.Dispose(); $script:app=$null; $script:stderrTask=$null; $script:ownedChildren=@{} }
}
function Capture([string]$name) {
  $window=Get-Window
  $handle=$script:app.MainWindowHandle
  $rect=New-Object LoaderUiNative+RECT
  Assert ([LoaderUiNative]::GetWindowRect($handle,[ref]$rect)) 'GetWindowRect failed.'
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  Assert ($width -gt 100 -and $height -gt 100) 'Owned capture has invalid dimensions.'
  $bitmap=New-Object Drawing.Bitmap $width,$height
  $graphics=[Drawing.Graphics]::FromImage($bitmap); $dc=$graphics.GetHdc()
  try { Assert ([LoaderUiNative]::PrintWindow($handle,$dc,2)) 'PrintWindow failed on owned handle.' }
  finally { $graphics.ReleaseHdc($dc) }
  $path=Join-Path $script:report.output ($name+'.png')
  try {
    $bitmap.Save($path,[Drawing.Imaging.ImageFormat]::Png)
    $colors=@($bitmap.GetPixel(0,0).ToArgb(),$bitmap.GetPixel([int]($width/2),[int]($height/2)).ToArgb(),
      $bitmap.GetPixel([int]($width/3),[int]($height/3)).ToArgb(),$bitmap.GetPixel(($width-1),($height-1)).ToArgb())
    Assert (@($colors|Select-Object -Unique).Count -gt 1) 'PrintWindow returned a uniform image.'
  } finally { $graphics.Dispose();$bitmap.Dispose() }
  $bytes=[IO.File]::ReadAllBytes($path)
  Assert ($bytes.Length -gt 1024 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71) 'Owned capture is not a valid PNG.'
  return [ordered]@{file=$path;width=$width;height=$height;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash}
}
function Resize-Ui([int]$width,[int]$height) {
  $window=Get-Window
  $scale=[LoaderUiNative]::GetDpiForWindow($script:app.MainWindowHandle)/96.0
  if($scale -le 0){$scale=1.0}
  ([System.Windows.Automation.TransformPattern]$window.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern)).Resize($width*$scale,$height*$scale)
  Wait-Until { $r=New-Object LoaderUiNative+RECT; [LoaderUiNative]::GetWindowRect($script:app.MainWindowHandle,[ref]$r) -and
    [Math]::Abs(($r.Right-$r.Left)-$width*$scale) -lt 12 -and [Math]::Abs(($r.Bottom-$r.Top)-$height*$scale) -lt 12 } "window resize to ${width}x$height" 8
}

$failed=$false
try {
  $repo=Full (Join-Path $PSScriptRoot '..\..')
  $script:bundle=Full (Resolve-Path -LiteralPath $BundleRoot).Path
  $script:exe=Full (Join-Path $script:bundle 'Lodestar.Loader.exe')
  $dll=Full (Join-Path $script:bundle 'Lodestar.Loader.dll')
  $script:cli=Full (Join-Path $script:bundle 'core\lodestar.mjs')
  $manifest=Full (Join-Path $script:bundle 'bundle-manifest.json')
  foreach($file in @($script:exe,$dll,$script:cli,$manifest,(Join-Path $script:bundle 'interfaces.json'))) { Assert (Test-Path -LiteralPath $file -PathType Leaf) "Incomplete bundle: $file" }
  $bundleManifest=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  Assert ($bundleManifest.v -eq 1 -and @($bundleManifest.files).Count -gt 0) 'Bundle manifest has an unsupported or empty shape.'
  foreach($entry in $bundleManifest.files) {
    $file=Full (Join-Path $script:bundle $entry.path)
    Assert (IsInside $file $script:bundle) "Bundle manifest path escapes selected root: $($entry.path)"
    Assert (Test-Path -LiteralPath $file -PathType Leaf) "Manifest file is absent: $($entry.path)"
    $item=Get-Item -LiteralPath $file
    Assert (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "Manifest file is a reparse point: $($entry.path)"
    Assert ($item.Length -eq [long]$entry.bytes) "Manifest byte count differs: $($entry.path)"
    Assert ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -eq $entry.sha256) "Manifest SHA-256 differs: $($entry.path)"
  }
  $script:node=Full (Read-Config (Join-Path $script:bundle 'interfaces.json')).runtime.node
  Assert (Test-Path -LiteralPath $script:node -PathType Leaf) 'Selected bundle Node executable is missing.'
  if (!$WorkRoot) { $WorkRoot=Join-Path ([IO.Path]::GetTempPath()) 'LodestarLoaderUiFixtures' }
  $work=Full $WorkRoot
  Assert ($work -ne $script:bundle -and -not (IsInside $work $script:bundle) -and -not (IsInside $script:bundle $work)) 'WorkRoot must be separate from the selected bundle.'
  if (Test-Path -LiteralPath $work) {
    Assert (Test-Path -LiteralPath (Join-Path $work '.lodestar-ui-fixtures-root') -PathType Leaf) 'Existing nonempty WorkRoot lacks the UI fixture ownership marker.'
  } else {
    [IO.Directory]::CreateDirectory($work) | Out-Null
    [IO.File]::WriteAllText((Join-Path $work '.lodestar-ui-fixtures-root'),'lodestar-loader-ui-regression-v1',[Text.UTF8Encoding]::new($false))
  }
  $script:run=Join-Path $work ('run-'+[Guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($script:run) | Out-Null
  $outputRoot=Full $OutputDirectory
  Assert ($outputRoot -ne $script:bundle -and -not (IsInside $outputRoot $script:bundle)) 'OutputDirectory must be separate from the selected bundle.'
  [IO.Directory]::CreateDirectory($outputRoot) | Out-Null
  $script:report.output=Join-Path $outputRoot (Split-Path $script:run -Leaf)
  Assert (-not (Test-Path -LiteralPath $script:report.output)) 'Unique output folder already exists.'
  [IO.Directory]::CreateDirectory($script:report.output) | Out-Null
  $script:reportPath=Join-Path $script:report.output 'ui-regression.json'
  $script:report.bundle=$script:bundle; $script:report.fixture_root=$script:run
  $script:report.dll_sha256=(Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
  $script:report.core_sha256=(Get-FileHash -LiteralPath $script:cli -Algorithm SHA256).Hash
  $script:report.manifest_sha256=(Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
  Write-Report

  if ($CaseScope -eq 'All') {
  $script:activeCase='read-save-conflict-layout'
  $fixture=New-Fixture 'read-save-conflict-layout'
  $before=Record $fixture
  Start-Ui $fixture
  Assert ((Name-Id @('DetailTitle')) -match 'Editable fixture fact') 'Initial record detail was not selected.'
  if (Visible @('ReadableRecord')) { Invoke-Id @('ReadableRecord'); Assert (Visible @('ReadableContent')) 'Readable detail did not appear.' }
  if (Visible @('ReadableContent')) { Assert (-not [string]::IsNullOrWhiteSpace((Name-Id @('ReadoutSummary')))) 'Readable detail has no fixture summary.' }
  Invoke-Id @('RecordRaw','RawButton')
  Wait-Until { (Value-Id @('DetailContent')) -match 'fact:loader-editable' } 'raw fixture evidence'
  Invoke-Id @('RecordHistory','HistoryButton')
  Wait-Until { (Value-Id @('DetailContent')) -match 'RETAINED VERSIONS' } 'history evidence'
  Pass 'fixture-detail-raw-history' @{initial_revision=$before.revision;database=$fixture.database}
  Invoke-Id @('EditRecord'); Set-Id @('EditName') 'Saved through maintained UI regression'
  Invoke-Id @('ReviewEdit'); Wait-Until { Visible @('SaveEdit') } 'reviewed Save'
  Resize-Ui 1440 900; $wide=Capture 'review-wide-1440x900'
  Resize-Ui 900 600
  Assert (Visible @('EditName')) 'Compact editor disappeared.'
  Assert (Visible @('InspectorBack','BackButton')) 'Compact Back is unavailable.'
  Assert ((Value-Id @('EditName')) -eq 'Saved through maintained UI regression') 'Compact resize lost reviewed draft.'
  $compact=Capture 'review-compact-900x600'
  Resize-Ui 1440 900
  Assert (Visible @('SaveEdit') -and (Value-Id @('EditName')) -eq 'Saved through maintained UI regression') 'Wide resize lost reviewed editor.'
  Pass 'wide-compact-wide-reviewed-editor' @{wide=$wide;compact=$compact}
  Invoke-Id @('SaveEdit')
  Wait-Until { (Record $fixture).revision -gt $before.revision } 'saved revision advance'
  $saved=Record $fixture
  Assert ($saved.data.name -eq 'Saved through maintained UI regression') 'UI Save stored the wrong fixture value.'
  Wait-Until { (Name-Id @('CoverageText')) -match ('revision '+$saved.revision+'\b') } 'refreshed list revision'
  Wait-Until { (Name-Id @('StatusText')) -match ('refreshed library revision '+$saved.revision+'\b') } 'completed Save refresh'
  Select-Child @('MainTabs') 'Records' | Out-Null
  Wait-Until { Visible @('RecordList') } 'enabled record table'
  Select-Child @('RecordList') 'Saved through maintained UI regression' | Out-Null
  Wait-Until { Visible @('EditRecord') } 'refreshed list record selection'
  Pass 'reviewed-save-refresh' @{before=$before.revision;after=$saved.revision;stored_name=$saved.data.name}
  Invoke-Id @('EditRecord'); Set-Id @('EditName') 'Retained stale UI draft'
  $fresh=Record $fixture
  $request=[ordered]@{v=5;request_id='ui-conflict-'+[Guid]::NewGuid().ToString('N');write_basis=$fresh.data.write_basis;
    input=[ordered]@{mode='update';id='fact:loader-editable';set=[ordered]@{name='External fixture update'};remove=@()}}
  $requestPath=Join-Path $fixture.root 'external-update.json'
  [IO.File]::WriteAllText($requestPath,($request|ConvertTo-Json -Depth 25),[Text.UTF8Encoding]::new($false))
  $external=Call-Core $fixture.database @('put','--file',$requestPath)
  Assert ($external.code -eq 0 -and $external.envelope.ok) 'Concurrent packaged CLI fixture update failed.'
  Invoke-Id @('ReviewEdit'); Invoke-Id @('SaveEdit')
  Wait-Until { (Name-Id @('EditHint')) -match 'draft and original basis retained' } 'stale Save rejection'
  $conflicted=Record $fixture
  Assert ((Value-Id @('EditName')) -eq 'Retained stale UI draft') 'Conflict lost the draft.'
  Assert ($conflicted.data.name -eq 'External fixture update' -and $conflicted.revision -eq $external.envelope.revision) 'Stale Save overwrote external update.'
  Pass 'concurrent-conflict-retains-draft' @{external_revision=$conflicted.revision;draft=(Value-Id @('EditName'))}
  Invoke-Id @('DiscardEdit','CancelEditButton')
  if (Visible @('HealthNavigation')) {
    Invoke-Id @('HealthNavigation'); Assert (Visible @('HealthObservations')) 'Health observations are absent.'
    Invoke-Id @('RunHealthCheck')
    Wait-Until { (Name-Id @('StatusText')) -match 'Lodestar doctor (result read|read failed)|did not describe a safe public doctor read' } 'health check result' 35
    Invoke-Id @('ProjectsNavigation')
    Assert (Visible @('ProjectDashboard')) 'Project dashboard is absent.'
    Select-Combo 'ProjectGroup' 'Status'; Invoke-Id @('ResetProjectView')
    Select-Child @('ProjectList') 'Loader fixture' | Out-Null
    $tabs=Element @('MainTabs')
    Assert ($null -ne $tabs) 'Project tabs are absent.'
    Select-Child @('MainTabs') 'Records' | Out-Null
    Assert (Visible @('RecordList')) 'Record list is absent.'
    Select-Combo 'RecordSort' 'Name'; Select-Combo 'RecordGroup' 'Kind'; Invoke-Id @('ResetRecordView')
    $continue=Element @('ContinueLibrary')
    $continued=$false
    if (Visible @('ContinueLibrary')) {
      $priorCoverage=Name-Id @('CoverageText')
      Invoke-Id @('ContinueLibrary')
      Wait-Until { (Name-Id @('StatusText')) -match '^Read [0-9,]+ rows' } 'validated continuation result' 45
      Assert ((Name-Id @('CoverageText')) -ne $priorCoverage) 'Continue did not change library coverage.'
      $continued=$true
    }
    Pass 'console-navigation-health-sort-group' @{health='UI action';project_group='Status';record_sort='Name';record_group='Kind';
      continue_control_present=($null -ne $continue);continue_invoked=$continued;reason=if($continued){'validated page'}else{'Four-record fixture has no continuation page.'}}
  } else {
    $script:report.cases += [ordered]@{name='console-navigation-health-sort-group';result='SKIP';
      evidence=@{reason='New console API absent from this bundle; final bundle must exercise this scenario.'}}
    Write-Report
  }
  Send-OwnedKeys '^f'
  Wait-Until { [System.Windows.Automation.AutomationElement]::FocusedElement.Current.AutomationId -eq 'LibrarySearch' } 'Ctrl F search focus'
  Send-OwnedKeys 'Loader'
  Assert ((Value-Id @('LibrarySearch')) -eq 'Loader') 'Keyboard finder did not accept input.'
  Send-OwnedKeys '^a{BACKSPACE}'
  $keyboardStops=@()
  for($step=0;$step -lt 10;$step++) {
    Send-OwnedKeys '{TAB}'
    $focus=[System.Windows.Automation.AutomationElement]::FocusedElement
    Assert ($focus.Current.ProcessId -eq $script:app.Id) 'Keyboard focus left the owned console.'
    $keyboardStops += @{id=$focus.Current.AutomationId;name=$focus.Current.Name;type=$focus.Current.ControlType.ProgrammaticName}
  }
  $splitter=Element @('NavigationSplitter'); $splitter.SetFocus()
  $beforeSplit=$splitter.Current.BoundingRectangle.X
  Send-OwnedKeys '{RIGHT}{RIGHT}{RIGHT}'
  Wait-Until { (Element @('NavigationSplitter')).Current.BoundingRectangle.X -gt $beforeSplit } 'keyboard splitter resize'
  Send-OwnedKeys '{LEFT}{LEFT}{LEFT}'
  Pass 'keyboard-finder-tab-order-and-splitter' @{stops=$keyboardStops;search_shortcut='Ctrl+F';splitter_arrows='resized and restored'}
  Request-Close; Finish-Close 'read-save-conflict-layout'

  $script:activeCase='close-and-back'
  $fixture=New-Fixture 'close-and-back'; $baseline=Record $fixture
  Start-Ui $fixture; Invoke-Id @('EditRecord'); Request-Close; Finish-Close 'unchanged edit close'
  Start-Ui $fixture; Invoke-Id @('EditRecord'); Set-Id @('EditName') 'Unreviewed close draft'; Request-Close
  Click-Dialog 'Yes'
  Wait-Until { Visible @('SaveEdit') } 'review after unreviewed close'
  Assert ((Record $fixture).revision -eq $baseline.revision) 'Close Yes wrote an unreviewed change.'
  Request-Close; Click-Dialog 'No'; Finish-Close 'review then discard'
  Start-Ui $fixture; Resize-Ui 900 600
  Assert (Visible @('InspectorBack','BackButton')) 'Compact Back is unavailable.'
  Invoke-Id @('InspectorBack','BackButton')
  Assert (Visible @('ProjectList')) 'Compact Back did not reveal project list.'
  Request-Close; Finish-Close 'compact Back close'
  Assert ((Record $fixture).revision -eq $baseline.revision) 'Close and Back branches changed fixture.'
  Pass 'close-choices-and-compact-back' @{revision=$baseline.revision;unchanged='exit 0';unreviewed_yes='review only';discard='exit 0';back='project list'}

  $script:activeCase='slow-read-runtime-guard'
  $fixture=New-Fixture 'slow-read-runtime-guard' 'find'
  Start-Ui $fixture $false
  $marker=Join-Path $fixture.root 'read-started.json'
  Wait-Until { Test-Path -LiteralPath $marker } 'slow read marker' 20
  $read=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  Track-Child ([int]$read.pid)
  Invoke-Id @('Connection')
  if (Visible @('SelectRuntimeTop')) {
    Invoke-Id @('SelectRuntimeTop')
    Assert ((Name-Id @('StatusText')) -match 'Wait for the active library read or save') 'Runtime switch was not blocked during read.'
  } elseif (Visible @('SelectRuntime')) {
    Invoke-Id @('SelectRuntime')
    Assert ((Name-Id @('StatusText')) -match 'Wait for the active library read or save') 'Runtime switch was not blocked during read.'
  } else {
    Assert ((Name-Id @('StatusText')) -eq 'Wait for the current library read to finish.') 'Connection navigation was not explicitly blocked during read.'
  }
  $guardMessage=Name-Id @('StatusText')
  $generation=(Read-Config $fixture.config).generation
  Request-Close; Finish-Close 'slow read close'
  Assert ((Read-Config $fixture.config).generation -eq $generation) 'Runtime switch modified fixture config.'
  Pass 'slow-read-runtime-switch-close' @{child_pid=$read.pid;guard=$guardMessage;exit=0;child_cleanup='verified'}
  }

  $script:activeCase='delayed-save-exact-replay'
  $fixture=New-Fixture 'delayed-save-exact-replay' 'put'
  $before=Record $fixture
  Start-Ui $fixture; Invoke-Id @('EditRecord'); Set-Id @('EditName') 'Replay exact frozen fixture request'
  Invoke-Id @('ReviewEdit'); Wait-Until { Visible @('SaveEdit') } 'reviewed delayed Save'
  Invoke-Id @('SaveEdit')
  $marker=Join-Path $fixture.root 'put-started.json'
  Wait-Until { Test-Path -LiteralPath $marker } 'delayed put marker' 20
  $put=Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  Track-Child ([int]$put.pid)
  $journal=Join-Path $fixture.root 'journal'
  Wait-Until { @(Get-ChildItem -LiteralPath $journal -Filter request.json -Recurse -ErrorAction SilentlyContinue).Count -eq 1 } 'durable exact request' 10
  $requestFile=@(Get-ChildItem -LiteralPath $journal -Filter request.json -Recurse)[0].FullName
  $requestHash=(Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash
  $requestBody=Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
  Assert ($requestBody.input.id -eq 'fact:loader-editable' -and $requestBody.input.set.name -eq 'Replay exact frozen fixture request') 'Journal contains the wrong frozen request.'
  Request-Close; Click-Dialog 'Yes'; Finish-Close 'interrupted save close'
  Assert ((Record $fixture).revision -eq $before.revision) 'Delayed Save committed before replay.'
  Start-Ui $fixture; Invoke-Id @('RecoveryNavigation')
  Select-Child @('SpecialList') 'fact:loader-editable' | Out-Null
  Wait-Until { Visible @('ReplayPending') } 'pending exact request'
  Invoke-Id @('ReplayPending'); Click-Dialog 'Yes'
  Wait-Until { (Record $fixture).revision -gt $before.revision } 'exact replay commit' 35
  $replayed=Record $fixture
  Assert ($replayed.data.name -eq 'Replay exact frozen fixture request') 'Replay committed the wrong value.'
  Assert ((Get-FileHash -LiteralPath $requestFile -Algorithm SHA256).Hash -eq $requestHash) 'Replay changed the original request bytes.'
  Wait-Until { Test-Path -LiteralPath (Join-Path (Split-Path $requestFile -Parent) 'response.json') } 'journal response' 10
  Invoke-Id @('RecoveryNavigation')
  Wait-Until { $pending=Element @('ReplayPending'); !$pending -or $pending.Current.IsOffscreen } 'resolved pending control hidden' 8
  Request-Close; Finish-Close 'replay close'
  Pass 'interrupted-save-restart-exact-replay' @{before=$before.revision;after=$replayed.revision;request_id=$requestBody.request_id;
    request_sha256=$requestHash;response_retained=$true;unresolved_pending=$false;child_pid=$put.pid}

  $script:report.result=if(@($script:report.cases|Where-Object {$_.result -eq 'SKIP'}).Count){'PARTIAL'}else{'PASS'}
} catch {
  $failed=$true
  $script:report.result='FAIL'
  $script:report.errors += [ordered]@{case=$script:activeCase;at=[DateTimeOffset]::UtcNow.ToString('o');message=$_.Exception.Message;
    position=$_.InvocationInfo.PositionMessage}
} finally {
  Cleanup-Owned
  Write-Report
  if ($script:reportPath) { Write-Output "UI regression [$CaseScope] $($script:report.result): $script:reportPath" }
  else { Write-Error "UI regression setup failed: $(($script:report.errors|ConvertTo-Json -Depth 4))" }
}
if ($failed -or $script:report.result -ne 'PASS') { exit 1 }
exit 0
