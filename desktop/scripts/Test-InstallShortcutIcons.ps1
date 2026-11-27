#requires -Version 7.0
[CmdletBinding()]
param([string]$ModulePath=(Join-Path $PSScriptRoot '../distribution/InstallTools.psm1'))
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$root=Join-Path ([IO.Path]::GetTempPath()) ('lodestar-shortcut-icons-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$owner=Join-Path $root 'owner';[IO.Directory]::CreateDirectory($owner)|Out-Null
foreach($name in @('InstallTools.psm1','DistributionTools.psm1')){[IO.File]::Copy((Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ModulePath))) $name),(Join-Path $owner $name))}
$bundleTools=Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ModulePath))) 'BundleTools.psm1'
if(-not [IO.File]::Exists($bundleTools)){$bundleTools=Join-Path $PSScriptRoot 'BundleTools.psm1'}
[IO.File]::Copy($bundleTools,(Join-Path $owner 'BundleTools.psm1'))
Import-Module (Join-Path $owner 'InstallTools.psm1') -Force -DisableNameChecking
$module=Get-Module InstallTools
$results=[Collections.Generic.List[object]]::new()
function Check([bool]$Value,[string]$Message){if(-not $Value){throw $Message}}
function Case([string]$Name,[scriptblock]$Body){try{&$Body;$results.Add(@{name=$Name;status='pass'})}catch{$results.Add(@{name=$Name;status='fail';error=$_.Exception.Message})}}
function Plan([string]$Name){
 $homePath=Join-Path $root $Name;[IO.Directory]::CreateDirectory($homePath)|Out-Null
 $plan=&$module {param($homePath) Get-InstallHost (Join-Path $homePath 'app') ([guid]::NewGuid().ToString('D')) $true $homePath $true} $homePath
 # Real WScript shortcuts at isolated paths; only uninstall registration uses a
 # disposable JSON file. No public Start Menu, Desktop or registry is touched.
 $plan.test=$false
 return $plan
}
function Read-Link([string]$Path){
 $shell=New-Object -ComObject WScript.Shell
 try{$link=$shell.CreateShortcut($Path);return @{target=$link.TargetPath;arguments=$link.Arguments;working_directory=$link.WorkingDirectory;icon_location=$link.IconLocation;description=$link.Description;hotkey=$link.Hotkey;window_style=$link.WindowStyle}}
 finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)}
}
function Write-Link($Entry,[string]$Icon='',[bool]$Foreign=$false){
 $shell=New-Object -ComObject WScript.Shell
 try{$link=$shell.CreateShortcut($Entry.path);$link.TargetPath=if($Foreign){Join-Path $root 'foreign.exe'}else{$Entry.target};$link.Arguments=$Entry.arguments;$link.WorkingDirectory=$Entry.working_directory;if($Icon){$link.IconLocation=$Icon};$link.Description='Keep my launch note';$link.Hotkey='CTRL+ALT+L';$link.WindowStyle=7;$link.Save()}
 finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)}
}
try{
 Case 'fresh real shortcuts use the embedded Lodestar icon' {
  $plan=Plan fresh;Publish-InstallHostEntries $plan '3.0.0'
  foreach($entry in $plan.shortcuts){$link=Read-Link $entry.path;Check ($link.icon_location -ieq ((Join-Path $entry.working_directory 'Lodestar.Loader.exe')+',0')) 'Fresh shortcut still uses the PowerShell icon';Check ($link.target -ieq $entry.target -and $link.arguments -ceq $entry.arguments -and $link.working_directory -ieq $entry.working_directory) 'Fresh shortcut changed launch selection'}
 }
 Case 'legacy owned real shortcut gains branding and retains customized fields' {
  $plan=Plan legacy;$entry=$plan.shortcuts[0];Write-Link $entry
  $before=Read-Link $entry.path;Publish-InstallHostEntries $plan '3.0.0';$after=Read-Link $entry.path
  Check ($after.icon_location -ieq ((Join-Path $entry.working_directory 'Lodestar.Loader.exe')+',0')) 'Legacy shortcut remains unbranded'
  foreach($field in @('target','arguments','working_directory','description','hotkey','window_style')){Check ($after[$field] -ceq $before[$field]) "Legacy upgrade changed $field"}
  $hash=(Get-FileHash -LiteralPath $entry.path).Hash;Publish-InstallHostEntries $plan '3.0.0';Check ((Get-FileHash -LiteralPath $entry.path).Hash -ceq $hash) 'Already branded shortcut was rewritten'
 }
 Case 'custom real shortcut icon and bytes are preserved' {
  $plan=Plan custom;$entry=$plan.shortcuts[0];Write-Link $entry ((Join-Path $env:SystemRoot 'System32/shell32.dll')+',42');$hash=(Get-FileHash -LiteralPath $entry.path).Hash
  Publish-InstallHostEntries $plan '3.0.0';Check ((Get-FileHash -LiteralPath $entry.path).Hash -ceq $hash) 'Custom icon shortcut was rewritten'
 }
 Case 'foreign real shortcut refuses publication and preserves bytes' {
  $plan=Plan foreign;$entry=$plan.shortcuts[0];Write-Link $entry '' $true;$hash=(Get-FileHash -LiteralPath $entry.path).Hash;$failed=$false
  try{Publish-InstallHostEntries $plan '3.0.0'}catch{$failed=$_.Exception.Message -match 'install_shortcut_conflict:'}
  Check $failed 'Foreign shortcut did not refuse publication';Check ((Get-FileHash -LiteralPath $entry.path).Hash -ceq $hash) 'Foreign shortcut changed';Check (-not [IO.File]::Exists($plan.registry)) 'Foreign shortcut caused registration publication'
 }
 Case 'read-only legacy real shortcut preserves original bytes when replacement fails' {
  $plan=Plan readonly;$entry=$plan.shortcuts[0];Write-Link $entry;$hash=(Get-FileHash -LiteralPath $entry.path).Hash
  [IO.File]::SetAttributes($entry.path,[IO.FileAttributes]::ReadOnly)
  try{$failed=$false;try{Publish-InstallHostEntries $plan '3.0.0'}catch{$failed=$true};Check $failed 'Read-only shortcut replacement returned success';Check ((Get-FileHash -LiteralPath $entry.path).Hash -ceq $hash) 'Failed replacement changed original shortcut';Check (-not [IO.File]::Exists($plan.registry)) 'Failed replacement published registration'}
  finally{[IO.File]::SetAttributes($entry.path,[IO.FileAttributes]::Normal)}
  Check (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($entry.path)) -Filter '*.lnk').Count -eq 1) 'Failed replacement retained a temporary shortcut'
 }
 Case 'real shortcut drift after copy refuses replacement and keeps the concurrent customization' {
  $plan=Plan drift;$entry=$plan.shortcuts[0];Write-Link $entry
  $driftOwner=Join-Path $root 'drift-owner';[IO.Directory]::CreateDirectory($driftOwner)|Out-Null
  foreach($name in @('InstallTools.psm1','DistributionTools.psm1','BundleTools.psm1')){[IO.File]::Copy((Join-Path $owner $name),(Join-Path $driftOwner $name))}
  $file=Join-Path $driftOwner 'InstallTools.psm1';$source=[IO.File]::ReadAllText($file)
  $anchor='# Change only an empty legacy icon on a copy of the original link;'
  Check ($source.Split($anchor).Count -eq 2) 'Shortcut publication boundary changed; update the drift witness explicitly'
  # An independent actor edits the original real link at the actual production
  # copy/replacement boundary; the publishing operation and COM remain real.
  $arrival=@'
$actor=New-Object -ComObject WScript.Shell
try{$changed=$actor.CreateShortcut($entry.path);$changed.Description='Concurrent launch note';$changed.Save()}finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($actor)}
'@
  [IO.File]::WriteAllText($file,$source.Replace($anchor,($arrival+"`n"+$anchor)))
  Import-Module $file -Force -DisableNameChecking
  try{$failed=$false;try{Publish-InstallHostEntries $plan '3.0.0'}catch{$failed=$_.Exception.Message -match 'install_shortcut_changed:'};Check $failed 'Concurrent change was overwritten or returned success';$after=Read-Link $entry.path;Check ($after.description -ceq 'Concurrent launch note') 'Concurrent customization was lost';Check ($after.icon_location -in @('',',0')) 'Drift refusal still replaced the icon';Check (-not [IO.File]::Exists($plan.registry)) 'Drift refusal published registration';Check (@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($entry.path)) -Filter '*.lnk').Count -eq 1) 'Drift refusal retained a temporary shortcut'}
  finally{Import-Module (Join-Path $owner 'InstallTools.psm1') -Force -DisableNameChecking}
 }
 $results|ConvertTo-Json -Depth 8
 if(@($results|Where-Object status -eq fail).Count){exit 1}
}finally{Remove-Item -LiteralPath $root -Recurse -Force}
