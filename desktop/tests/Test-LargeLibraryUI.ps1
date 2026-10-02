param([Parameter(Mandatory=$true)][string]$BundleRoot,
      [Parameter(Mandatory=$true)][string]$FixtureDirectory,
      [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$bundle=[IO.Path]::GetFullPath($BundleRoot);$fixture=[IO.Path]::GetFullPath($FixtureDirectory)
$output=[IO.Path]::GetFullPath($OutputDirectory)
$manifest=Get-Content -LiteralPath (Join-Path $fixture 'fixture-manifest.json') -Raw|ConvertFrom-Json
if($manifest.fixture -ne 'synthetic-benchmark' -or $manifest.currentRecords -le 100000){throw 'Expected a large synthetic benchmark fixture.'}
if(Test-Path -LiteralPath $output){throw 'Use a fresh evidence directory.'}
New-Item -ItemType Directory -Path $output|Out-Null
$configPath=Join-Path $fixture 'interfaces.json'
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
if([IO.Path]::GetFullPath($config.runtime.database) -ne [IO.Path]::GetFullPath($manifest.database)){throw 'Fixture config identity differs.'}
$exe=Join-Path $bundle 'Lodestar.Loader.exe';$phase=Join-Path $output 'startup.json'
$psi=New-Object Diagnostics.ProcessStartInfo $exe
$psi.UseShellExecute=$false;$psi.RedirectStandardError=$true
$psi.Arguments='--interface-config "'+$configPath+'" --interactive-smoke --journal-root "'+(Join-Path $fixture 'pending')+'" --diagnostics-file "'+$phase+'"'
$app=$null
function Wait-For([scriptblock]$predicate,[string]$label,[int]$seconds=180){
 $clock=[Diagnostics.Stopwatch]::StartNew()
 while($clock.Elapsed.TotalSeconds -lt $seconds){
  if($app.HasExited){throw "Loader exited during $label with $($app.ExitCode)."}
  if(&$predicate){return};Start-Sleep -Milliseconds 150
 }
 throw "Timed out: $label"
}
function Find-Control([string]$id){
 $app.Refresh();$window=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
 $condition=New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::AutomationIdProperty),$id
 return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
}
try {
 $timer=[Diagnostics.Stopwatch]::StartNew();$app=[Diagnostics.Process]::Start($psi)
 $stderr=$app.StandardError.ReadToEndAsync()
 Wait-For {Test-Path -LiteralPath $phase} 'initial bounded batch'
 $first=Get-Content -LiteralPath $phase -Raw|ConvertFrom-Json
 if($first.library.complete -or $first.library.currentRecords -ge $manifest.currentRecords){throw 'Expected an explicit partial first batch.'}
 $button=Find-Control 'ContinueLibrary'
 if(!$button -or !$button.Current.IsEnabled -or $button.Current.IsOffscreen){throw 'Continue loading is unavailable.'}
 $firstMs=$timer.ElapsedMilliseconds
 ([System.Windows.Automation.InvokePattern]$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
 Wait-For { (Find-Control 'StatusText').Current.Name -match '^Read [0-9,]+ rows.*\bcomplete\b.*revision' } 'completed continuation'
 $status=(Find-Control 'StatusText').Current.Name
 $grid=Find-Control 'HealthObservations'
 $text=@($grid.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)|ForEach-Object{$_.Current.Name}) -join "`n"
 if($text -notmatch [regex]::Escape([string]$manifest.currentRecords)){throw 'Expected final current-record count is absent from health.'}
 $completedMs=$timer.ElapsedMilliseconds
 $continueAfter=Find-Control 'ContinueLibrary'
 if($continueAfter -and !$continueAfter.Current.IsOffscreen -and $continueAfter.Current.IsEnabled){throw 'Continue remains active after complete coverage.'}
 $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)")
 if($children.Count){throw 'Data child remains after completed continuation.'}
 $app.Refresh();$ws=$app.WorkingSet64
 if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){throw 'Large library did not close normally.'}
 $errors=$stderr.GetAwaiter().GetResult()
 if($app.ExitCode -ne 0 -or $errors){throw 'Large library close was unclean.'}
 [ordered]@{result='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');expected_current_records=$manifest.currentRecords;
  first_current_records=$first.library.currentRecords;first_complete=$first.library.complete;first_ms=$firstMs;
  completed_ms=$completedMs;status=$status;health_count_observed=$true;working_set_bytes=$ws;exit_code=$app.ExitCode;
  stderr_empty=$true;owned_children_at_idle=0;dll_sha256=(Get-FileHash (Join-Path $bundle 'Lodestar.Loader.dll')).Hash}|
  ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $output 'large-ui.json')
 Write-Output 'Large library UI continuation PASS.'
} finally {
 if($app -and !$app.HasExited){
  if($app.Path -ne $exe){throw 'Owned process identity changed.'}
  if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){$app.Kill();$app.WaitForExit()}
 }
 if($app){$app.Dispose()}
}
