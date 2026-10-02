#requires -Version 7.0
param(
 [Parameter(Mandatory=$true)][string]$BundleRoot,
 [Parameter(Mandatory=$true)][string]$FixtureDirectory,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [ValidateRange(0,600)][int]$SoakSeconds=360,
 [ValidateRange(1,3)][int]$Runs=3
)
$ErrorActionPreference='Stop'
$bundle=[IO.Path]::GetFullPath($BundleRoot)
$fixture=[IO.Path]::GetFullPath($FixtureDirectory)
$output=[IO.Path]::GetFullPath($OutputDirectory)
$exe=Join-Path $bundle 'Lodestar.Loader.exe'
$config=Join-Path $fixture 'interfaces.json'
$manifest=Get-Content -LiteralPath (Join-Path $fixture 'fixture-manifest.json') -Raw | ConvertFrom-Json
if($manifest.fixture -ne 'synthetic-benchmark'){throw 'Only disposable benchmark fixtures are accepted.'}
if(Test-Path -LiteralPath $output){throw 'Use a fresh evidence directory; stale reports are not accepted.'}
New-Item -ItemType Directory -Path $output | Out-Null
$samples=[Collections.Generic.List[object]]::new()
for($run=1;$run -le $Runs;$run++) {
 $phasePath=Join-Path $output "run-$run-startup.json"
 $interactionPath=Join-Path $output "run-$run-interactions.json"
 $duration=if($run -eq $Runs){$SoakSeconds}else{0}
 $psi=[Diagnostics.ProcessStartInfo]::new($exe)
 $psi.UseShellExecute=$false
 $psi.RedirectStandardError=$true
 foreach($argument in @('--interface-config',$config,'--interactive-smoke','--journal-root',
   (Join-Path $fixture 'pending'),'--diagnostics-file',$phasePath,'--performance-output',$interactionPath,
   '--performance-seconds',[string]$duration)){ $psi.ArgumentList.Add($argument) }
 $app=$null
 try {
  $started=[DateTimeOffset]::UtcNow
  $timer=[Diagnostics.Stopwatch]::StartNew()
  $app=[Diagnostics.Process]::Start($psi)
  $stderr=$app.StandardError.ReadToEndAsync()
  $visible=$null
  while(!(Test-Path -LiteralPath $interactionPath)) {
   $app.Refresh()
   if($app.HasExited){throw "Run $run exited early with $($app.ExitCode)."}
   if($null -eq $visible -and $app.MainWindowHandle -ne [IntPtr]::Zero){$visible=$timer.ElapsedMilliseconds}
   if($timer.Elapsed.TotalSeconds -gt $duration+120){throw "Run $run exceeded the interaction deadline."}
   Start-Sleep -Milliseconds 40
  }
  $phase=Get-Content -LiteralPath $phasePath -Raw|ConvertFrom-Json
  $interactions=Get-Content -LiteralPath $interactionPath -Raw|ConvertFrom-Json
  if(!$phase.ready -or !$phase.library.complete -or !$interactions.library_complete){throw 'Library was not complete.'}
  $app.Refresh();$idleCpu=$app.TotalProcessorTime.TotalMilliseconds
  $idleTimer=[Diagnostics.Stopwatch]::StartNew();Start-Sleep -Milliseconds 3000
  $app.Refresh();$idleTimer.Stop()
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($app.Id)"|Select-Object ProcessId,Name)
  $listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue|Where-Object OwningProcess -eq $app.Id|Select-Object LocalAddress,LocalPort)
  $cpu=$app.TotalProcessorTime.TotalMilliseconds-$idleCpu
  $ws=$app.WorkingSet64;$private=$app.PrivateMemorySize64
  $closing=[Diagnostics.Stopwatch]::StartNew()
  if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){throw 'Ordinary close failed within five seconds.'}
  $closing.Stop()
  $errors=$stderr.GetAwaiter().GetResult()
  if($app.ExitCode -ne 0 -or $errors){throw "Unclean close: code=$($app.ExitCode), stderr=$errors"}
  if($children.Count -or $listeners.Count){throw 'The app retained a child or listening socket at settled idle.'}
  $catalog=$phase.libraryLoad.Phases|Where-Object Phase -like 'catalog-published-*'|Select-Object -First 1
  $samples.Add([ordered]@{run=$run;pid=$app.Id;shell_visible_ms=$visible;
    catalog_published_ms=([DateTimeOffset]::Parse($phase.libraryLoad.StartedAt)-$started).TotalMilliseconds+$catalog.ElapsedMilliseconds;
    process_cold_ui_ready_ms=([DateTimeOffset]::Parse($phase.capturedAt)-$started).TotalMilliseconds;
    app_startup_ui_ready_ms=$phase.uiReadyElapsedMilliseconds;warm_refresh_ms=$interactions.warm_refresh_ms;
    filter_max_ms=($interactions.filters.elapsed_ms|Measure-Object -Maximum).Maximum;
    filter_below_150ms=(@($interactions.filters|Where-Object elapsed_ms -ge 150).Count -eq 0);
    idle_sample_ms=$idleTimer.ElapsedMilliseconds;idle_cpu_ms=$cpu;settled_working_set_bytes=$ws;settled_private_bytes=$private;
    close_ms=$closing.ElapsedMilliseconds;exit_code=$app.ExitCode;stderr_empty=($errors.Length -eq 0);
    idle_children=$children;listeners=$listeners;startup_evidence=$phasePath;interaction_evidence=$interactionPath})
  [IO.File]::WriteAllText((Join-Path $output 'samples.json'),(ConvertTo-Json -InputObject $samples.ToArray() -Depth 8))
  Write-Output "Run $run complete; shell $visible ms, warm refresh $([math]::Round($interactions.warm_refresh_ms)) ms, close $($closing.ElapsedMilliseconds) ms."
 } finally {
  if($app -and !$app.HasExited){
   if($app.Path -ne $exe){throw 'Owned process identity changed; cleanup refused.'}
   if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){$app.Kill($true);$app.WaitForExit()}
  }
  if($app){$app.Dispose()}
 }
}
$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors
$report=[ordered]@{result='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');runs=$Runs;
 definitions=@{process_cold='New Loader process and one-shot Node children; filesystem/OS caches are not flushed.';
 warm='Explicit complete library refresh in that same initialized process.';
 filter='Actual TextBox event, debounce, filtering and WPF idle/layout, instrumented inside the app.'};
 fixture=$manifest;cpu=$cpu;logical_processors=[Environment]::ProcessorCount;os=[Environment]::OSVersion.VersionString;
 dll_sha256=(Get-FileHash -LiteralPath (Join-Path $bundle 'Lodestar.Loader.dll')).Hash;
 samples=$samples.ToArray();limits='No reboot or filesystem cache purge; forced full-GC sample is separately labeled and does not replace ordinary working-set samples.'}
[IO.File]::WriteAllText((Join-Path $output 'performance-matrix.json'),($report|ConvertTo-Json -Depth 12))
