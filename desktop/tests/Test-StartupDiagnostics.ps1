#requires -Version 7.0
param([Parameter(Mandatory=$true)][string]$BundleRoot,
      [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
$bundle=[IO.Path]::GetFullPath($BundleRoot)
$output=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $output){throw 'Use a new disposable evidence directory.'}
New-Item -ItemType Directory -Path $output | Out-Null
$marker='PRIVATE-CONTENT-MUST-NOT-BE-LOGGED-52f75a'
$config=Get-Content -LiteralPath (Join-Path $bundle 'interfaces.json') -Raw|ConvertFrom-Json
$config.runtime.node=Join-Path $output "$marker.exe"
$configPath=Join-Path $output 'interfaces.json'
$config|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $configPath
$phase=Join-Path $output 'startup.json'
$exe=Join-Path $bundle 'Lodestar.Loader.exe'
$psi=[Diagnostics.ProcessStartInfo]::new($exe)
$psi.UseShellExecute=$false;$psi.RedirectStandardError=$true
foreach($argument in @('--interface-config',$configPath,'--interactive-smoke','--journal-root',
  (Join-Path $output 'pending'),'--diagnostics-file',$phase)){$psi.ArgumentList.Add($argument)}
$app=$null
try {
 $app=[Diagnostics.Process]::Start($psi);$stderr=$app.StandardError.ReadToEndAsync()
 $timer=[Diagnostics.Stopwatch]::StartNew()
 while(!(Test-Path -LiteralPath $phase)){
  if($app.HasExited -or $timer.Elapsed.TotalSeconds -gt 30){throw 'Startup error view was not reached.'}
  Start-Sleep -Milliseconds 50
 }
 $events=@(Get-ChildItem -LiteralPath (Join-Path $output 'diagnostics') -Filter 'diag-*.json')
 if($events.Count -ne 1){throw "Expected one bounded startup event; found $($events.Count)."}
 $raw=Get-Content -LiteralPath $events[0].FullName -Raw;$event=$raw|ConvertFrom-Json
 $hash=(Get-FileHash -LiteralPath (Join-Path $bundle 'Lodestar.Loader.dll')).Hash.ToLowerInvariant()
 if($raw.Contains($marker) -or $raw.Contains($config.runtime.database)){throw 'Diagnostic contained private context.'}
 if($event.operation -ne 'Startup' -or $event.app_build -ne $hash -or !$event.exception_type){throw 'Missing operation/build/exception identity.'}
 if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){throw 'Recoverable startup-error view did not close.'}
 $errorText=$stderr.GetAwaiter().GetResult()
 if($app.ExitCode -ne 0 -or $errorText){throw 'Startup-error view closed uncleanly.'}
 $report=[ordered]@{result='PASS';at=[DateTimeOffset]::UtcNow.ToString('o');
  scenario='Missing fixture runtime; recoverable Connection view';event=$event;event_bytes=$events[0].Length;
  privacy_marker_absent=$true;database_path_absent=$true;exit_code=$app.ExitCode;stderr_empty=$true;dll_sha256=$hash}
 $report|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $output 'diagnostic-integration.json')
 Write-Output 'Startup diagnostic integration PASS.'
} finally {
 if($app -and !$app.HasExited){
  if($app.Path -ne $exe){throw 'Owned process identity changed.'}
  if(!$app.CloseMainWindow() -or !$app.WaitForExit(5000)){$app.Kill($true);$app.WaitForExit()}
 }
 if($app){$app.Dispose()}
}
