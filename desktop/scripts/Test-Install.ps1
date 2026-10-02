#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundlePath,[switch]$KeepArtifacts,[switch]$TestRegistry,[string]$CasePattern='.',[string]$HistoricalBundle)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$source=[IO.Path]::GetFullPath($BundlePath)
$node=[IO.Path]::GetFullPath((Get-Command node -CommandType Application | Select-Object -First 1).Source)
$root=Join-Path ([IO.Path]::GetTempPath()) ('lodestar-install-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root)|Out-Null
$results=[Collections.Generic.List[object]]::new()
function Check([bool]$Value,[string]$Message) { if(-not $Value){throw $Message} }
function Case([string]$Name,[scriptblock]$Body){if($Name -notmatch $CasePattern){return};try{&$Body;$results.Add(@{name=$Name;status='pass'})}catch{$results.Add(@{name=$Name;status='fail';error=$_.Exception.Message})}}
function Fixture([string]$Name){$fixtureRoot=Join-Path $root $Name;[IO.Directory]::CreateDirectory($fixtureRoot)|Out-Null;return @{Home=$fixtureRoot;App=(Join-Path $fixtureRoot 'café & app');Db=(Join-Path $fixtureRoot 'data\selected store.db');Host=(Join-Path $fixtureRoot 'host')}}
function Run($f,[string[]]$Extra=@()){
 $payload=if($f.Contains('Payload')){$f.Payload}else{$source}
 $out=@(& pwsh -NoProfile -File (Join-Path $payload 'Install.ps1') -Destination $f.App -DatabasePath $f.Db -NodePath $node -TestMode -TestHostRoot $f.Host @Extra 2>&1)
 return @{Code=$LASTEXITCODE;Text=($out|Out-String)}
}
function Run-Cmd([string]$Directory,[string]$Command){
 $start=[Diagnostics.ProcessStartInfo]::new((Join-Path $env:SystemRoot 'System32/cmd.exe'));$start.UseShellExecute=$false;$start.CreateNoWindow=$true
 $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true;$start.WorkingDirectory=$Directory
 foreach($argument in @('/d','/v:on','/c',$Command)){$start.ArgumentList.Add($argument)}
 $process=[Diagnostics.Process]::new();$process.StartInfo=$start;$started=$false
 try{$started=$process.Start();Check $started 'Owned CMD did not start';$process.StandardInput.Close();$out=$process.StandardOutput.ReadToEndAsync();$err=$process.StandardError.ReadToEndAsync()
  Check ($process.WaitForExit(30000)) 'Owned CMD exceeded deadline';return @{Code=$process.ExitCode;Out=$out.GetAwaiter().GetResult();Err=$err.GetAwaiter().GetResult()}
 }finally{if($started -and -not $process.HasExited){$process.Kill($true);$null=$process.WaitForExit(5000)};$process.Dispose()}
}
function Old-Database($f,[string]$Schema='4') {
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($f.Db))|Out-Null
 $scriptFile=Join-Path $f.Home 'old-store.mjs'
 $script='import {DatabaseSync} from "node:sqlite"; import {pathToFileURL} from "node:url"; const {SCHEMA_V4_SQL}=await import(pathToFileURL(process.argv[2])); const db=new DatabaseSync(process.argv[3]); db.exec(SCHEMA_V4_SQL); const put=db.prepare("INSERT INTO metadata(key,value) VALUES(?,?)"); for(const [k,v] of Object.entries({schema_version:process.argv[4],created_at:"2026-09-30T00:00:00.000Z",database_instance_id:"a".repeat(64),database_revision:"0",database_epoch:"b".repeat(64)}))put.run(k,v); db.close();'
 [IO.File]::WriteAllText($scriptFile,$script)
 & $node $scriptFile (Join-Path $source 'core/src/schema.mjs') $f.Db $Schema 2>$null
 if($LASTEXITCODE -ne 0){throw 'Actual legacy DB fixture failed.'}
}
Case 'plan is read only and names selected paths' {$f=Fixture 'plan';$r=Run $f @('-Mode','Plan');Check ($r.Code -eq 0) $r.Text;$v=$r.Text|ConvertFrom-Json;Check ($v.application -eq $f.App) 'Plan omitted app';Check (-not (Test-Path $f.App)) 'Plan created app';Check (-not (Test-Path $f.Db)) 'Plan created DB'}
Case 'maintained installer runner refuses an unmatched selection' {
 $out=@(& pwsh -NoProfile -File $PSCommandPath -BundlePath $source -CasePattern 'no-case-can-match-this-discriminator' -KeepArtifacts 2>&1)
 Check ($LASTEXITCODE -ne 0) 'Empty test selection returned success'
 Check (($out|Out-String) -match 'No checks matched.*CasePattern.*Next action:') 'Empty selection lacked corrective guidance'
}
Case 'owned JSON writer write and replacement failures preserve accepted files' {
 Import-Module (Join-Path $source InstallTools.psm1) -Force -DisableNameChecking
 $f=Fixture 'json-writer';$file=Join-Path $f.Home receipt.json;Write-InstallJson $file @{state='accepted'};$before=[IO.File]::ReadAllBytes($file)
 [IO.File]::SetAttributes($file,[IO.FileAttributes]::ReadOnly)
 try{$failed=$false;try{Write-InstallJson $file @{state='replacement'}}catch{$failed=$true};Check $failed 'Actual readonly replacement did not fail';Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -eq [Convert]::ToBase64String($before)) 'Failed replacement changed accepted target'}finally{[IO.File]::SetAttributes($file,[IO.FileAttributes]::Normal)}
 $blocker=Join-Path $f.Home 'parent-file';[IO.File]::WriteAllText($blocker,'foreign parent');$failed=$false
 try{Write-InstallJson (Join-Path $blocker child.json) @{state='write'}}catch{$failed=$true};Check $failed 'Actual invalid-parent write did not fail';Check ((Get-Content $blocker -Raw) -eq 'foreign parent') 'Failed write changed parent file'
 Check (@(Get-ChildItem $f.Home -Filter '*.tmp').Count -eq 0) 'Failed writer retained temporary sprawl'
 Write-InstallJson $file @{state='replaced'};Check ((Get-Content $file -Raw|ConvertFrom-Json).state -eq 'replaced') 'Accepted JSON replacement did not succeed'
}
Case 'fresh repeat selected config and literal launch arguments' {
 $f=Fixture 'fresh';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $config=Join-Path $f.App 'interfaces.json';$hash=(Get-FileHash $config).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f;Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $config).Hash -eq $hash) 'Repeat changed config';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Repeat changed DB'
 $out=@(& pwsh -NoProfile -File (Join-Path $f.App 'Launch.ps1') -Mode Manager -DescribeOnly);$v=($out -join "`n")|ConvertFrom-Json
 Check ($v.arguments[3] -eq $config) 'Manager lost selected config'
 $out=@(& pwsh -NoProfile -File (Join-Path $f.App 'Cli.ps1') -DescribeOnly 'doctor' '--cwd' 'a & café');$v=($out -join "`n")|ConvertFrom-Json
 Check ($v.arguments[2] -eq $f.Db) 'CLI lost selected DB';Check ($v.arguments[-1] -eq 'a & café') 'CLI split argument'
 $r=Run $f @('-Mode','Uninstall');Check ($r.Code -eq 0) $r.Text;Check (Test-Path $f.Db) 'Uninstall deleted DB';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Uninstall changed DB'
}
Case 'legacy receipt without icon metadata recovers upgrades and uninstalls safely' {
 $f=Fixture 'legacy-icon-receipt';$r=Run $f @('-DesktopShortcut');Check ($r.Code -eq 0) $r.Text
 $configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $receiptPath=$f.App+'.lodestar-install.json';$receipt=Get-Content -LiteralPath $receiptPath -Raw|ConvertFrom-Json -AsHashtable
 foreach($entry in $receipt.host.shortcuts){$entry.Remove('icon_location')}
 $receipt.phase='promoted';[IO.File]::WriteAllText($receiptPath,($receipt|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))
 foreach($entry in $receipt.host.shortcuts){$link=Get-Content -LiteralPath $entry.path -Raw|ConvertFrom-Json -AsHashtable;$link.Remove('icon_location');$link.description='Preserved legacy customization';[IO.File]::WriteAllText($entry.path,($link|ConvertTo-Json -Depth 6))}
 $r=Run $f @('-Mode','Recover');Check ($r.Code -eq 0) $r.Text
 foreach($entry in $receipt.host.shortcuts){$link=Get-Content -LiteralPath $entry.path -Raw|ConvertFrom-Json -AsHashtable;Check ($link.icon_location -ieq ((Join-Path $f.App 'Lodestar.Loader.exe')+',0')) 'Recover did not brand legacy shortcut';Check ($link.description -ceq 'Preserved legacy customization') 'Recover changed legacy customization'}
 Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -ceq $configHash) 'Legacy receipt recovery changed config';Check ((Get-FileHash $f.Db).Hash -ceq $dbHash) 'Legacy receipt recovery changed store'
 $r=Run $f;Check ($r.Code -eq 0) $r.Text
 $r=Run $f @('-Mode','Uninstall');Check ($r.Code -eq 0) $r.Text
 Check ((Get-FileHash $f.Db).Hash -ceq $dbHash) 'Legacy receipt uninstall changed store';foreach($entry in $receipt.host.shortcuts){Check (-not [IO.File]::Exists($entry.path)) 'Legacy receipt uninstall left owned shortcut'}
}
foreach($kind in @('foreign-file','foreign-directory','changed-owned-file')){
 Case "uninstall preserves $kind introduced after ownership validation" {
  $f=Fixture ('late-'+$kind);$r=Run $f;Check ($r.Code -eq 0) $r.Text
  $dbHash=(Get-FileHash $f.Db).Hash
  $relative=if($kind -eq 'changed-owned-file'){'LICENSE'}elseif($kind -eq 'foreign-directory'){'late unrelated directory'}else{'late unrelated.txt'}
  $foreign=Join-Path $f.App $relative
  # Instrument a copy of the real dispatcher at its deletion boundary. Target
  # inventory remains untouched; only the unrelated actor's arrival is injected.
  $probe=Join-Path $f.Home probe;Copy-Item -LiteralPath $source -Destination $probe -Recurse
  $scriptFile=Join-Path $probe Install.ps1;$script=[IO.File]::ReadAllText($scriptFile)
  $anchor="`$stage='uninstall_application'"
  Check ($script.Split($anchor).Count -eq 2) 'Uninstall deletion boundary changed; update this witness explicitly'
  $injection=if($kind -eq 'foreign-directory'){"[IO.Directory]::CreateDirectory((Join-Path `$target '$relative'))|Out-Null"}else{"[IO.File]::WriteAllText((Join-Path `$target '$relative'),'preserve these unrelated bytes')"}
  [IO.File]::WriteAllText($scriptFile,$script.Replace($anchor,($anchor+"`n"+$injection)))
  $f.Payload=$probe;$r=Run $f @('-Mode','Uninstall');$f.Remove('Payload')
  Check (Test-Path -LiteralPath $foreign) "Uninstall erased $kind arriving after validation"
  if($kind -ne 'foreign-directory'){Check ((Get-Content -LiteralPath $foreign -Raw) -eq 'preserve these unrelated bytes') 'Uninstall altered post-validation bytes'}
  Check ($r.Code -ne 0 -and $r.Text -match '(?s)uninstall_application.*Next action:') 'Incomplete uninstall did not give stage and recovery guidance'
  Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Late ownership conflict changed database'
  $receipt=Get-Content -LiteralPath ($f.App+'.lodestar-install.json') -Raw|ConvertFrom-Json
  Check ($receipt.phase -eq 'uninstalling') 'Incomplete uninstall lost its recoverable receipt'
  Move-Item -LiteralPath $foreign -Destination (Join-Path $f.Home preserved-unrelated)
  $r=Run $f @('-Mode','Recover');Check ($r.Code -eq 0) $r.Text
  Check (-not(Test-Path -LiteralPath $f.App)) 'Owned recovery left application behind'
  Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Recovered uninstall changed database'
 }
}
Case 'setup flush failure precedes config publication and preserves selected store' {
 $f=Fixture 'setup-flush';$r=Run $f;Check ($r.Code -eq 0) $r.Text;$dbHash=(Get-FileHash $f.Db).Hash
 $probe=Join-Path $f.Home portable;Copy-Item -LiteralPath $source -Destination $probe -Recurse
 $scriptFile=Join-Path $probe Setup.ps1;$script=[IO.File]::ReadAllText($scriptFile)
 $anchor='$stream.Flush($true)';Check ($script.Split($anchor).Count -eq 2) 'Setup lacks the explicit durable flush point'
 # A deterministic I/O fault at the actual flush call, after real open/write,
 # proves publication cannot proceed and the owned temporary is cleaned.
 [IO.File]::WriteAllText($scriptFile,$script.Replace($anchor,"throw 'injected_flush_failure'"))
 $manifestPath=Join-Path $probe distribution-manifest.json;$manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
 $entry=$manifest.files|Where-Object {$_.path -eq 'Setup.ps1'};Check ($null -ne $entry) 'Setup absent from payload inventory'
 $entry.bytes=([IO.FileInfo]$scriptFile).Length;$entry.sha256=(Get-FileHash $scriptFile).Hash.ToLowerInvariant()
 [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 12))
 $out=@(& pwsh -NoProfile -File $scriptFile -NodePath $node -DatabasePath $f.Db 2>&1);$code=$LASTEXITCODE;$message=$out|Out-String
 Check ($code -ne 0 -and $message -match '(?s)configuration_write.*injected_flush_failure.*Next action:') $message
 Check (-not(Test-Path -LiteralPath (Join-Path $probe interfaces.json))) 'Failed flush published config'
 Check (@(Get-ChildItem -LiteralPath $probe -Filter '.interfaces-*.tmp').Count -eq 0) 'Failed flush left temporary sprawl'
 Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Failed config flush changed selected store'
 [IO.File]::Copy((Join-Path $source Setup.ps1),$scriptFile,$true)
 $entry.bytes=([IO.FileInfo]$scriptFile).Length;$entry.sha256=(Get-FileHash $scriptFile).Hash.ToLowerInvariant()
 [IO.File]::WriteAllText($manifestPath,($manifest|ConvertTo-Json -Depth 12))
 $out=@(& pwsh -NoProfile -File $scriptFile -NodePath $node -DatabasePath $f.Db 2>&1);Check ($LASTEXITCODE -eq 0) ($out|Out-String)
 $config=Join-Path $probe interfaces.json;$configHash=(Get-FileHash $config).Hash
 $out=@(& pwsh -NoProfile -File $scriptFile -NodePath $node -DatabasePath $f.Db 2>&1);Check ($LASTEXITCODE -ne 0) 'Setup overwrote accepted config'
 Check ((Get-FileHash $config).Hash -eq $configHash) 'Repeat Setup altered accepted config'
 Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Healthy/repeated Setup changed selected store'
}
Case 'actual configured Lodestar command selects core store help and refuses overrides' {
 $f=Fixture 'actual-command';$f.App=Join-Path $f.Home 'app ! café & (literal)';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $r=Run-Cmd $f.App 'Lodestar.cmd doctor';Check ($r.Code -eq 0) ($r.Out+$r.Err);$doctor=$r.Out|ConvertFrom-Json
 Check ($doctor.operation -eq 'doctor' -and $doctor.data.healthy -eq $true -and $doctor.data.database -eq $f.Db) 'Actual CMD doctor selected another database'
 [IO.File]::WriteAllText((Join-Path $f.Home doctor.json),$r.Out)
 $r=Run-Cmd $f.App 'Lodestar.cmd --help';Check ($r.Code -eq 0 -and $r.Out -match 'doctor') ($r.Out+$r.Err)
 [IO.File]::WriteAllText((Join-Path $f.Home help.txt),$r.Out)
 $literal=Run-Cmd $f.App 'Lodestar.cmd get -- --db'
 Import-Module (Join-Path $source DistributionTools.psm1) -Force
 $parsed=Read-CliEnvelope @{ExitCode=$literal.Code;Stdout=$literal.Out;Stderr=$literal.Err} 'get' @('get','--','--db') $false
 Check ($parsed.Kind -eq 'error' -and $parsed.Envelope.error.code -eq 'record_not_found' -and $parsed.Envelope.error.identifiers.requested -eq '--db') ('Literal record identifier was intercepted: '+$literal.Out+$literal.Err)
 [IO.File]::WriteAllText((Join-Path $f.Home literal-tail.txt),($literal.Out+$literal.Err))
 $before=(Get-FileHash $f.Db).Hash
 foreach($arguments in @('--db other.db','--db=other.db','--interface-config other.json')){$r=Run-Cmd $f.App ('Lodestar.cmd doctor '+$arguments);Check ($r.Code -ne 0 -and ($r.Out+$r.Err) -match 'fixed by interfaces.json') ($r.Out+$r.Err)}
 Check ((Get-FileHash $f.Db).Hash -eq $before) 'Rejected binding override changed selected data';Check (-not(Test-Path (Join-Path $f.App other.db))) 'Rejected override created another store'
 $out=@(& pwsh -NoProfile -File (Join-Path $f.App Cli.ps1) -DescribeOnly doctor);$selection=($out -join "`n")|ConvertFrom-Json
 Check ($selection.executable -eq $node -and $selection.arguments[0] -eq (Join-Path $f.App core/lodestar.mjs)) 'CMD did not describe selected local core'
 [IO.File]::WriteAllText((Join-Path $f.Home selection.json),($out -join "`n"))
 Write-Host ('Actual configured CMD evidence: '+$f.Home+'; Node='+$node+'; CLI='+(Join-Path $f.App core/lodestar.mjs)+'; config='+(Join-Path $f.App interfaces.json)+'; DB='+$f.Db)
}
Case 'foreign target and host collisions are preserved' {
 $f=Fixture 'collision';[IO.Directory]::CreateDirectory($f.App)|Out-Null;[IO.File]::WriteAllText((Join-Path $f.App 'foreign.txt'),'keep');$r=Run $f;Check ($r.Code -ne 0) 'Foreign target accepted';Check (Test-Path (Join-Path $f.App 'foreign.txt')) 'Foreign target erased'
 $f=Fixture 'host-collision';[IO.Directory]::CreateDirectory($f.Host)|Out-Null;[IO.File]::WriteAllText((Join-Path $f.Host 'Loader.lnk'),'foreign');$r=Run $f;Check ($r.Code -ne 0) 'Foreign shortcut accepted';Check ((Get-Content (Join-Path $f.Host 'Loader.lnk') -Raw) -eq 'foreign') 'Foreign shortcut changed';Check (-not (Test-Path $f.Db)) 'Collision created DB'
}
Case 'registration failure and promoted interruption reconcile' {
 foreach($fault in @('BeforeSwap','AfterSwap','AfterRegistration')){$f=Fixture $fault;$r=Run $f @('-Fault',$fault);Check ($r.Code -ne 0) 'Fault failed to interrupt';Check (Test-Path $f.Db) 'Fault lost DB';$hash=(Get-FileHash $f.Db).Hash;$r=Run $f @('-Mode','Recover');Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $f.Db).Hash -eq $hash) 'Recovery changed DB'}
}
Case 'explicit previous portable config is adopted unchanged' {
 $old=Fixture 'old';$r=Run $old;Check ($r.Code -eq 0) $r.Text
 $f=Fixture 'adopt';$f.Db=$old.Db;$hash=(Get-FileHash (Join-Path $old.App 'interfaces.json')).Hash
 $r=Run $f @('-PreviousInstallation',$old.App);Check ($r.Code -eq 0) $r.Text
 Check ((Get-FileHash (Join-Path $f.App 'interfaces.json')).Hash -eq $hash) 'Adopt changed config';Check ((Get-FileHash (Join-Path $old.App 'interfaces.json')).Hash -eq $hash) 'Adopt changed source'
}
Case 'newer version downgrade and altered ownership refuse' {
 $f=Fixture 'downgrade';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $receipt=$f.App+'.lodestar-install.json';$v=Get-Content $receipt -Raw|ConvertFrom-Json;$v.version='99.0.0';[IO.File]::WriteAllText($receipt,($v|ConvertTo-Json -Depth 20))
 $r=Run $f;Check ($r.Code -ne 0 -and $r.Text -match 'downgrade') 'Downgrade accepted'
}
Case 'database within app and reparse path refuse before write' {$f=Fixture 'bad-db';$f.Db=Join-Path $f.App 'data.db';$r=Run $f;Check ($r.Code -ne 0) 'Internal DB accepted';Check (-not(Test-Path $f.Db)) 'Internal DB created'}
Case 'receipt and lock collisions refuse before database mutation' {
 foreach($suffix in @('.lodestar-install.json','.lodestar-install.lock')){$f=Fixture ('owner-'+$suffix.Replace('.',''));$file=$f.App+$suffix;[IO.File]::WriteAllText($file,'foreign ownership');$r=Run $f;Check ($r.Code -ne 0) 'Foreign ownership accepted';Check ((Get-Content $file -Raw) -eq 'foreign ownership') 'Foreign ownership replaced';Check (-not(Test-Path $f.Db)) 'Ownership conflict initialized DB'}
}
Case 'owned uninstall then reinstall same destination retains selected database' {
 $f=Fixture 'reinstall';$r=Run $f;Check ($r.Code -eq 0) $r.Text;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f @('-Mode','Uninstall');Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Uninstall changed selected DB'
 $r=Run $f;Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Reinstall changed selected DB'
}
Case 'plan after interrupted owned uninstall remains read only' {
 $f=Fixture 'uninstall-plan';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $r=Run $f @('-Mode','Uninstall','-Fault','AfterUninstallReceipt');Check ($r.Code -ne 0 -and $r.Text -match 'install_interrupted') $r.Text
 $file=$f.App+'.lodestar-install.json';$receipt=Get-Content $file -Raw|ConvertFrom-Json;Check ($receipt.phase -eq 'uninstalling') 'Fault did not leave actual interrupted uninstall state'
 $receiptHash=(Get-FileHash $file).Hash;$configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash;$hostHash=(Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f @('-Mode','Plan');Check (Test-Path $f.App) 'Plan removed owned application after recorded uninstall interruption'
 Check ($r.Code -eq 0) $r.Text;$plan=$r.Text|ConvertFrom-Json;Check ($plan.mode -eq 'Plan') 'Plan resumed uninstall'
 Check ((Get-FileHash $file).Hash -eq $receiptHash) 'Plan rewrote receipt';Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Plan changed selected config'
 Check ((Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash -eq $hostHash) 'Plan deleted host entry';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Plan changed data'
}
Case 'lost receipt after genuine uninstall interruption refuses reconstruction' {
 $f=Fixture 'lost-receipt';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $r=Run $f @('-Mode','Uninstall','-Fault','AfterUninstallReceipt');Check ($r.Code -ne 0 -and $r.Text -match 'install_interrupted') $r.Text
 $receipt=$f.App+'.lodestar-install.json';$saved=Join-Path $f.Home saved-receipt.json;[IO.File]::Move($receipt,$saved)
 $retained=$f.App+'.lodestar-config-retained.json';$configHash=(Get-FileHash $retained).Hash;$dbHash=(Get-FileHash $f.Db).Hash;$hostHash=(Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash
 $r=Run $f @('-Mode','Recover');Check ($r.Code -ne 0) 'Recover reconstructed lost ownership receipt';Check (-not(Test-Path $receipt)) 'Recover wrote new ownership receipt'
 Check ((Get-FileHash $retained).Hash -eq $configHash) 'Lost receipt recovery changed retained config';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Lost receipt recovery changed store';Check ((Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash -eq $hostHash) 'Lost receipt recovery removed host'
 Write-Host ('Lost receipt refusal evidence: '+$r.Text.Trim()+' Original receipt saved at '+$saved)
}
Case 'recover without receipt and host entries refuses before ownership mutation' {
 $f=Fixture 'unowned-recover';Copy-Item -LiteralPath $source -Destination $f.App -Recurse;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($f.Db))|Out-Null
 $out=@(& pwsh -NoProfile -File (Join-Path $f.App Setup.ps1) -NodePath $node -DatabasePath $f.Db -InitializeDatabase 2>&1);Check ($LASTEXITCODE -eq 0) ($out|Out-String)
 $configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash;$dbHash=(Get-FileHash $f.Db).Hash;$manifestHash=(Get-FileHash (Join-Path $f.App distribution-manifest.json)).Hash
 $r=Run $f @('-Mode','Recover');Check ($r.Code -ne 0 -and $r.Text -match 'install_recovery_unowned') ('Recover adopted a configured portable target without evidence: '+$r.Text)
 Check (-not(Test-Path ($f.App+'.lodestar-install.json'))) 'Unowned recovery created receipt';Check (-not(Test-Path ($f.App+'.lodestar-install.lock'))) 'Unowned recovery created lock';Check (-not(Test-Path $f.Host)) 'Unowned recovery created host entries'
 Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Unowned recovery changed config';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Unowned recovery changed DB';Check ((Get-FileHash (Join-Path $f.App distribution-manifest.json)).Hash -eq $manifestHash) 'Unowned recovery changed remaining payload'
}
Case 'resumed uninstall refuses changed remaining manifest and accepts owned absence' {
 foreach($change in @('changed','absent')){
  $f=Fixture ('resume-manifest-'+$change);$r=Run $f;Check ($r.Code -eq 0) $r.Text
  $r=Run $f @('-Mode','Uninstall','-Fault','AfterUninstallReceipt');Check ($r.Code -ne 0 -and $r.Text -match 'install_interrupted') $r.Text
  $file=Join-Path $f.App distribution-manifest.json;$dbHash=(Get-FileHash $f.Db).Hash;$hostHash=(Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash
  if($change -eq 'changed'){[IO.File]::AppendAllText($file,"`n ")}else{[IO.File]::Delete($file)}
  $r=Run $f @('-Mode','Uninstall')
  if($change -eq 'changed'){
   Check ($r.Code -ne 0 -and $r.Text -match 'install_inventory_changed') 'Resumed uninstall accepted changed manifest'
   Check (Test-Path $f.App) 'Resumed uninstall erased modified application';Check ((Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash -eq $hostHash) 'Resumed refusal erased host entry'
  }else{Check ($r.Code -eq 0) $r.Text;Check (-not(Test-Path $f.App)) 'Resumed owned deletion did not finish'}
  Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Resumed uninstall changed DB'
 }
}
Case 'standalone owned update refuses stale registration and routes to installer' {
 $f=Fixture 'owned-update';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $receipt=$f.App+'.lodestar-install.json';$hash=(Get-FileHash $receipt).Hash;$configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash
 foreach($mode in @('Update','Recover')){
  $out=@(& pwsh -NoProfile -File (Join-Path $source Update.ps1) -Destination $f.App -Mode $mode 2>&1);$code=$LASTEXITCODE;$text=$out|Out-String
  Check ($code -ne 0 -and $text -match '(?s)owned_installation.*Install.ps1') $text
  Check ((Get-FileHash $receipt).Hash -eq $hash) 'Refused standalone update altered receipt';Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Refused standalone update altered config'
 }
}
Case 'new command wrappers missing scripts fail actionably without argument pause' {
 foreach($name in @('Install','Lodestar')){$folder=Join-Path $root ('cmd-'+$name);[IO.Directory]::CreateDirectory($folder)|Out-Null;$file=Join-Path $folder ($name+'.cmd');Copy-Item -LiteralPath (Join-Path $source ($name+'.cmd')) -Destination $file
  $out=@(& cmd.exe /d /c ('"'+$file+'" --help') 2>&1);$code=$LASTEXITCODE;$text=$out|Out-String;Check ($code -ne 0 -and $text -match 'Next action:') $text
 }
}
Case 'uninstall refuses rewritten target inventory claiming unrelated file' {
 $f=Fixture 'foreign-inventory';$r=Run $f;Check ($r.Code -eq 0) $r.Text;$foreign=Join-Path $f.App 'keep.txt';[IO.File]::WriteAllText($foreign,'unrelated user work')
 $file=Join-Path $f.App distribution-manifest.json;$m=Get-Content $file -Raw|ConvertFrom-Json
 $m.files+=@{path='keep.txt';bytes=([IO.FileInfo]$foreign).Length;sha256=(Get-FileHash $foreign).Hash.ToLowerInvariant()};[IO.File]::WriteAllText($file,($m|ConvertTo-Json -Depth 20))
 $dbHash=(Get-FileHash $f.Db).Hash;$hostHash=(Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash
 $r=Run $f @('-Mode','Uninstall');Check ($r.Code -ne 0) 'Rewritten uninstall inventory accepted';Check (Test-Path $foreign) 'Uninstall erased foreign file';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Refused uninstall changed DB';Check ((Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash -eq $hostHash) 'Refused uninstall removed host entry'
}
Case 'malformed receipt inventory refuses before owned host deletion' {
 $f=Fixture 'malformed-inventory';$r=Run $f;Check ($r.Code -eq 0) $r.Text
 $file=$f.App+'.lodestar-install.json';$original=[IO.File]::ReadAllText($file);$hostHash=(Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 foreach($kind in @('missing','escape','duplicate')){
  $receipt=$original|ConvertFrom-Json
  switch($kind){missing{$receipt.inventory=$null}escape{$receipt.inventory[0].path='../unowned.txt'}duplicate{$receipt.inventory[1]=$receipt.inventory[0]}}
  [IO.File]::WriteAllText($file,($receipt|ConvertTo-Json -Depth 30));$r=Run $f @('-Mode','Uninstall')
  Check ($r.Code -ne 0 -and $r.Text -match 'install_inventory_') $r.Text;Check (Test-Path $f.App) 'Malformed receipt erased application'
  Check ((Get-FileHash (Join-Path $f.Host Loader.lnk)).Hash -eq $hostHash) 'Malformed receipt removed host entry';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Malformed receipt changed data'
 }
 [IO.File]::WriteAllText($file,$original)
}
Case 'actual reparse ancestry refuses before application or data mutation' {
 $f=Fixture 'junction';$outside=Join-Path $f.Home 'unowned';[IO.Directory]::CreateDirectory($outside)|Out-Null;$keep=Join-Path $outside keep.txt;[IO.File]::WriteAllText($keep,'keep')
 $link=Join-Path $f.Home 'junction';New-Item -ItemType Junction -Path $link -Target $outside|Out-Null;$f.App=Join-Path $link app
 $r=Run $f;Check ($r.Code -ne 0 -and $r.Text -match 'Reparse') $r.Text;Check (-not(Test-Path $f.Db)) 'Reparse ancestry initialized database';Check ((Get-Content $keep -Raw) -eq 'keep') 'Reparse ancestry changed unrelated file'
}
Case 'schema4 explicit conversion and exact request interruption recovery' {
 $f=Fixture 'schema4';Old-Database $f;$before=(Get-FileHash $f.Db).Hash
 $r=Run $f;Check ($r.Code -ne 0 -and $r.Text -match 'unsupported_schema.*schema 4') 'Legacy store did not give migration direction';Check ((Get-FileHash $f.Db).Hash -eq $before) 'Implicit conversion mutated DB'
 $r=Run $f @('-MigrateDatabase','-Fault','AfterMigration');Check ($r.Code -ne 0 -and $r.Text -match 'install_interrupted') $r.Text
 $request=$f.App+'.lodestar-migration.json';$hash=(Get-FileHash $request).Hash
 $r=Run $f @('-MigrateDatabase');Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $request).Hash -eq $hash) 'Replay replaced migration request'
 $receipt=Get-Content ($f.App+'.lodestar-install.json') -Raw|ConvertFrom-Json;Check (Test-Path $receipt.backup) 'Accepted independent backup missing'
 $f=Fixture 'schema4-backup';Old-Database $f;$r=Run $f @('-MigrateDatabase','-Fault','AfterBackup');Check ($r.Code -ne 0 -and $r.Text -match 'install_interrupted') $r.Text
 $receipt=Get-Content ($f.App+'.lodestar-install.json') -Raw|ConvertFrom-Json;$backupHash=(Get-FileHash $receipt.backup).Hash
 $r=Run $f @('-MigrateDatabase');Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash $receipt.backup).Hash -eq $backupHash) 'Interrupted backup was replaced'
}
Case 'future schema install and update refuse before promotion' {
 $f=Fixture 'future';Old-Database $f '99';$hash=(Get-FileHash $f.Db).Hash
 $r=Run $f @('-MigrateDatabase');Check ($r.Code -ne 0 -and $r.Text -match 'unsupported_schema') $r.Text;Check (-not(Test-Path $f.App)) 'Future schema promoted app';Check ((Get-FileHash $f.Db).Hash -eq $hash) 'Future DB changed'
 $old=Fixture 'future-update';Copy-Item -LiteralPath $source -Destination $old.App -Recurse;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($old.Db))|Out-Null
 $out=@(& pwsh -NoProfile -File (Join-Path $old.App Setup.ps1) -NodePath $node -DatabasePath $old.Db -InitializeDatabase 2>&1);Check ($LASTEXITCODE -eq 0) ($out|Out-String)
 Remove-Item -LiteralPath $old.Db;Old-Database $old '99';$hash=(Get-FileHash $old.Db).Hash;$configHash=(Get-FileHash (Join-Path $old.App interfaces.json)).Hash
 $out=@(& pwsh -NoProfile -File (Join-Path $source Update.ps1) -Destination $old.App 2>&1);$code=$LASTEXITCODE;$message=$out|Out-String
 Check ($code -ne 0 -and $message -match 'unsupported_schema') $message
 Check ((Get-FileHash $old.Db).Hash -eq $hash) 'Refused update changed future DB';Check ((Get-FileHash (Join-Path $old.App interfaces.json)).Hash -eq $configHash) 'Refused update changed config';Check (-not(Test-Path ($old.App+'.lodestar-stage'))) 'Future schema staged update'
}
Case 'prior payload generation upgrade keeps config and data' {
 $f=Fixture 'upgrade';$prior=Join-Path $f.Home 'older-payload';Copy-Item -LiteralPath $source -Destination $prior -Recurse
 $package=Join-Path $prior 'core/package.json';$v=Get-Content $package -Raw|ConvertFrom-Json;$v.version='2.9.0';[IO.File]::WriteAllText($package,($v|ConvertTo-Json -Depth 20))
 Import-Module (Join-Path $source 'BundleTools.psm1') -Force -DisableNameChecking;Write-BundleManifest $prior 'test:older-generation'
 $file=Join-Path $prior distribution-manifest.json;$m=Get-Content $file -Raw|ConvertFrom-Json;$m.version='2.9.0'
 foreach($entry in $m.files){$p=Join-Path $prior $entry.path;$entry.bytes=([IO.FileInfo]$p).Length;$entry.sha256=(Get-FileHash $p).Hash.ToLowerInvariant()}
 [IO.File]::WriteAllText($file,($m|ConvertTo-Json -Depth 12));$f.Payload=$prior
 $r=Run $f;Check ($r.Code -eq 0) $r.Text;$f.Remove('Payload')
 $configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f;Check ($r.Code -eq 0) $r.Text;Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Upgrade changed config';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Upgrade changed DB';Check (Test-Path ($f.App+'.lodestar-previous')) 'Upgrade lost prior generation'
}
Case 'reinstall without path overrides retains saved nondefault selection' {
 $f=Fixture 'reinstall-default';$r=Run $f;Check ($r.Code -eq 0) $r.Text;$configHash=(Get-FileHash (Join-Path $f.App interfaces.json)).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f @('-Mode','Uninstall');Check ($r.Code -eq 0) $r.Text
 $isolatedLocal=Join-Path $f.Home 'local';[IO.Directory]::CreateDirectory($isolatedLocal)|Out-Null
 $oldLocal=$env:LOCALAPPDATA
 try {$env:LOCALAPPDATA=$isolatedLocal;$out=@(& pwsh -NoProfile -File (Join-Path $source Install.ps1) -Destination $f.App -TestMode -TestHostRoot $f.Host 2>&1);$code=$LASTEXITCODE;$message=$out|Out-String}finally{$env:LOCALAPPDATA=$oldLocal}
 Check (-not(Test-Path (Join-Path $isolatedLocal 'Lodestar/lodestar.db'))) 'Reinstall initialized second default authority'
 Check ($code -eq 0) $message;$config=Get-Content (Join-Path $f.App interfaces.json) -Raw|ConvertFrom-Json
 Check ($config.runtime.database -eq $f.Db) 'Reinstall silently selected another store';Check ($config.runtime.node -eq $node) 'Reinstall silently selected another Node';Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Reinstall changed original store'
 Check (-not(Test-Path (Join-Path $isolatedLocal 'Lodestar/lodestar.db'))) 'Reinstall initialized second default authority';Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Reinstall failed to restore retained config bytes'
}
if($HistoricalBundle){Case 'actual retained prior bundle adoption preserves original records config and files' {
 $historical=[IO.Path]::GetFullPath($HistoricalBundle)
 $original=@{};foreach($file in Get-ChildItem -LiteralPath $historical -File -Recurse){$original[$file.FullName]=(Get-FileHash -LiteralPath $file.FullName).Hash}
 $f=Fixture 'historical';$prior=Join-Path $f.Home prior;Copy-Item -LiteralPath $historical -Destination $prior -Recurse
 Check ((Get-Content -LiteralPath (Join-Path $prior core/package.json) -Raw|ConvertFrom-Json).version -eq '2.2.0') 'Historical witness needs the actual retained2.2.0 core'
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($f.Db))|Out-Null
 $oldCli=Join-Path $prior core/lodestar.mjs;$out=@(& $node $oldCli --db $f.Db init 2>&1);Check ($LASTEXITCODE -eq 0) ($out|Out-String)
 $seed=Join-Path $f.Home seed-old.mjs
 [IO.File]::WriteAllText($seed,'import {pathToFileURL} from "node:url"; import path from "node:path"; const core=process.argv[2],database=process.argv[3]; const {openReadDatabase}=await import(pathToFileURL(path.join(core,"src/database.mjs"))); const {writeBasis}=await import(pathToFileURL(path.join(core,"src/records.mjs"))); const db=await openReadDatabase(database); const q={v:5,request_id:"historical-retained-record",write_basis:writeBasis(db,{projectScope:null,checkout:null,targets:[{kind:"record",id:"note:prior-retained"}]}),input:{mode:"create",record:{id:"note:prior-retained",kind:"note",name:"Prior knowledge",scope:"global",availability:"known",data:{text:"saved by actual2.2.0 core"},aliases:[],links:[],sources:[]}}}; db.close(); process.stdout.write(JSON.stringify(q));')
 $request=Join-Path $f.Home prior-request.json;$out=@(& $node $seed (Join-Path $prior core) $f.Db 2>$null);Check ($LASTEXITCODE -eq 0) 'Historical write-basis read failed'
 [IO.File]::WriteAllText($request,($out -join "`n"));$out=@(& $node $oldCli --db $f.Db put --file $request 2>&1);Check ($LASTEXITCODE -eq 0) ($out|Out-String)
 $configFile=Join-Path $prior interfaces.json;$config=Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json;$config.runtime.node=$node;$config.runtime.database=$f.Db
 [IO.File]::WriteAllText($configFile,($config|ConvertTo-Json -Depth 16));$configHash=(Get-FileHash $configFile).Hash;$dbHash=(Get-FileHash $f.Db).Hash
 $r=Run $f @('-PreviousInstallation',$prior);Check ($r.Code -eq 0) $r.Text
 Check ((Get-FileHash (Join-Path $f.App interfaces.json)).Hash -eq $configHash) 'Adoption changed selected config bytes'
 Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Adoption changed schema5 historical store'
 Check ((Get-Content -LiteralPath (Join-Path $f.App core/package.json) -Raw|ConvertFrom-Json).version -eq '3.0.0') 'Adoption did not select new core'
 $read=Run-Cmd $f.App 'Lodestar.cmd get note:prior-retained';Check ($read.Code -eq 0) ($read.Out+$read.Err)
 $record=$read.Out|ConvertFrom-Json;Check ($record.data.data.text -eq 'saved by actual2.2.0 core') 'Configured new core lost prior knowledge'
 foreach($file in $original.Keys){Check ((Get-FileHash -LiteralPath $file).Hash -eq $original[$file]) 'Historical baseline was modified'}
 Check ((Get-FileHash $configFile).Hash -eq $configHash) 'Adoption changed old selected config'
 Check ((Get-FileHash $f.Db).Hash -eq $dbHash) 'Configured read changed historical store'
}}
if($TestRegistry){Case 'explicit isolated HKCU registration and owned uninstall' {
 $f=Fixture 'hkcu';$suffix=[guid]::NewGuid().ToString('N');$keyPath='Software\Lodestar\InstallerTests\'+$suffix
 Check ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)) 'Test namespace already exists'
 $r=Run $f @('-TestRegistrySuffix',$suffix);Check ($r.Code -eq 0) $r.Text
 $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)
 try {Check ($key.GetValue('InstallLocation') -eq $f.App) 'Actual HKCU selection differs'}finally{$key.Dispose()}
 $r=Run $f @('-Mode','Uninstall','-TestRegistrySuffix',$suffix);Check ($r.Code -eq 0) $r.Text
 Check ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)) 'Owned test key remained';Check (Test-Path $f.Db) 'Actual registration uninstall deleted data'
}}
try {
 if($results.Count -eq 0){throw "No checks matched CasePattern '$CasePattern'. Next action: use '.' to run all checks or select part of a maintained case name; no installation check was executed."}
 $results|ConvertTo-Json -Depth 6
 if(@($results|Where-Object {$_.status -eq 'fail'}).Count){throw "Installer tests failed. Artifacts: $root"}
} finally {if(-not $KeepArtifacts -and -not @($results|Where-Object {$_.status -eq 'fail'}).Count){Remove-Item -LiteralPath $root -Recurse -Force}}
