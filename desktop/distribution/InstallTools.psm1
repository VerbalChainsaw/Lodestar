Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1')
Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -DisableNameChecking

function Write-InstallJson([string]$Path,$Value) {
    Assert-PlainPath $Path
    $temporary=$Path+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value|ConvertTo-Json -Depth 40))
        $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try {$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)} finally {$stream.Dispose()}
        [IO.File]::Move($temporary,$Path,$true)
    } finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
function Read-InstallReceipt([string]$Target) {
    $file=$Target+'.lodestar-install.json'
    Assert-PlainPath $file
    if(-not [IO.File]::Exists($file)){return $null}
    try {$r=Read-StrictJsonFile $file -AsHashtable}
    catch {throw "install_receipt_conflict: '$file' is malformed. Next action: preserve its original bytes and select the exact owned installation or restore its verified receipt before retrying."}
    if($r['v'] -ne 1 -or $r['product'] -cne 'Lodestar' -or $r['target'] -ine $Target -or
        $r['id'] -isnot [string] -or $r['id'] -notmatch '^[0-9a-f-]{36}$' -or
        $r['phase'] -notin @('preparing','promoted','registered','uninstalling','uninstalled') -or
        $r['version'] -notmatch '^\d+\.\d+\.\d+$' -or $r['host'] -isnot [Collections.IDictionary]) {
        throw "install_receipt_conflict: '$file' does not prove this installation. Next action: preserve it and select the exact owned installation; do not overwrite the receipt."
    }
    return $r
}
function Get-InstallHost([string]$Target,[string]$Id,[bool]$TestMode,[string]$TestHostRoot,[bool]$DesktopShortcut,[string]$TestRegistrySuffix='') {
    $pwsh=(Get-Command pwsh.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if($TestMode){
        if(-not $TestHostRoot -or -not [IO.Path]::IsPathFullyQualified($TestHostRoot)){throw 'TestMode requires an absolute TestHostRoot; public host entries are never used.'}
        $homePath=[IO.Path]::GetFullPath($TestHostRoot);Assert-PlainPath $homePath
        $menu=$homePath
        $registry=Join-Path $homePath 'uninstall.json'
        $desktop=Join-Path $homePath 'Desktop.lnk'
    } else {
        if($TestHostRoot){throw 'TestHostRoot requires -TestMode.'}
        $menu=Join-Path ([Environment]::GetFolderPath('Programs')) 'Lodestar'
        $registry='Software\Microsoft\Windows\CurrentVersion\Uninstall\Lodestar'
        $desktop=Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Lodestar Loader.lnk'
    }
    if($TestRegistrySuffix){
        if(-not $TestMode -or $TestRegistrySuffix -notmatch '\A[0-9a-f]{32}\z'){throw 'TestRegistrySuffix requires TestMode and a fresh lowercase GUID without separators.'}
        $registry='Software\Lodestar\InstallerTests\'+$TestRegistrySuffix
    }
    $shortcuts=@(
        @{path=(Join-Path $menu 'Loader.lnk');target=$pwsh;arguments=('-NoProfile -File "'+(Join-Path $Target 'Launch.ps1')+'" -Mode Loader');working_directory=$Target},
        @{path=(Join-Path $menu 'Manager.lnk');target=$pwsh;arguments=('-NoProfile -File "'+(Join-Path $Target 'Launch.ps1')+'" -Mode Manager');working_directory=$Target})
    if($DesktopShortcut){$shortcuts+=@{path=$desktop;target=$pwsh;arguments=$shortcuts[0].arguments;working_directory=$Target}}
    foreach($entry in $shortcuts){$entry.icon_location=(Join-Path $Target 'Lodestar.Loader.exe')+',0'}
    return @{test=$TestMode;registry_file=($TestMode -and -not $TestRegistrySuffix);registry=$registry;shortcuts=$shortcuts;values=@{
        DisplayName='Lodestar Loader and Manager';Publisher='VerbalChainsaw';InstallLocation=$Target;
        LodestarInstallId=$Id;DisplayIcon=(Join-Path $Target 'Lodestar.Loader.exe');
        UninstallString=('"'+$pwsh+'" -NoProfile -File "'+(Join-Path $Target 'Install.ps1')+'" -Mode Uninstall -Destination "'+$Target+'"')}}
}
function Read-InstallRegistration($HostPlan) {
    if($HostPlan.registry_file){if([IO.File]::Exists($HostPlan.registry)){return Read-StrictJsonFile $HostPlan.registry -AsHashtable};return $null}
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($HostPlan.registry)
    if(-not $key){return $null}
    try {$values=@{};foreach($name in $key.GetValueNames()){$values[$name]=$key.GetValue($name)};return $values}finally{$key.Dispose()}
}
function Read-InstallShortcut($HostPlan,$Entry) {
    Assert-PlainPath $Entry.path
    if(-not [IO.File]::Exists($Entry.path)){return $null}
    if($HostPlan.test){try{return Read-StrictJsonFile $Entry.path -AsHashtable}catch{return @{foreign=$true}}}
    $shell=New-Object -ComObject WScript.Shell
    try {$shortcut=$shell.CreateShortcut($Entry.path);return @{target=$shortcut.TargetPath;arguments=$shortcut.Arguments;working_directory=$shortcut.WorkingDirectory;icon_location=$shortcut.IconLocation}}finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)}
}
function Assert-InstallHostEntries($HostPlan,[bool]$Owned) {
    $registration=Read-InstallRegistration $HostPlan
    if($null -ne $registration){
        if(-not $Owned -or $registration['LodestarInstallId'] -cne $HostPlan.values.LodestarInstallId){throw "install_registration_conflict: '$($HostPlan.registry)'. Next action: preserve the foreign registration and choose the original owned installation."}
        foreach($field in $registration.Keys){if($field -notin @($HostPlan.values.Keys) -and $field -cne 'DisplayVersion'){throw "install_registration_changed: unowned value '$field' at '$($HostPlan.registry)'. Next action: preserve this added value before updating or uninstalling."}}
        # A retained promoted receipt and matching install ID permit completion
        # of missing values after interrupted registration, never replacement of
        # a conflicting existing value.
        foreach($field in $HostPlan.values.Keys){if($field -eq 'DisplayVersion'){continue};if($registration.Contains($field) -and $registration[$field] -cne $HostPlan.values[$field]){throw "install_registration_changed: '$($HostPlan.registry)' field '$field'. Next action: preserve the changed entry and restore its accepted ownership before retrying."}}
    }
    foreach($entry in $HostPlan.shortcuts){
        $current=Read-InstallShortcut $HostPlan $entry
        if($null -eq $current){continue}
        if(-not $Owned -or $current['target'] -ine $entry.target -or $current['arguments'] -cne $entry.arguments -or $current['working_directory'] -ine $entry.working_directory){
            throw "install_shortcut_conflict: '$($entry.path)'. Next action: preserve this modified or foreign shortcut; choose the owned installation or an unused shortcut destination."
        }
    }
}
function Publish-InstallHostEntries($HostPlan,[string]$Version) {
    Assert-InstallHostEntries $HostPlan $true
    foreach($entry in $HostPlan.shortcuts){
        $originalHash=if([IO.File]::Exists($entry.path)){(Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash}else{$null}
        $current=Read-InstallShortcut $HostPlan $entry
        if($current -and $current.Contains('icon_location') -and
            -not [string]::IsNullOrWhiteSpace($current.icon_location) -and $current.icon_location -ne ',0'){continue}
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($entry.path))|Out-Null
        $temporary=$entry.path+'.'+[guid]::NewGuid().ToString('N')+'.lnk'
        try {
            if($current){
                [IO.File]::Copy($entry.path,$temporary,$false)
                $attributes=[IO.File]::GetAttributes($temporary)
                [IO.File]::SetAttributes($temporary,($attributes -band (-bnot [IO.FileAttributes]::ReadOnly)))
            }
            if($HostPlan.test){
                $value=if($current){$current}else{$entry};$value.icon_location=$entry.icon_location
                [IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
            }
            else {
                $shell=New-Object -ComObject WScript.Shell
                try {
                    $shortcut=$shell.CreateShortcut($temporary)
                    if(-not $current){$shortcut.TargetPath=$entry.target;$shortcut.Arguments=$entry.arguments;$shortcut.WorkingDirectory=$entry.working_directory}
                    $shortcut.IconLocation=$entry.icon_location;$shortcut.Save()
                }finally{[void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)}
            }
            if($current){
                # Change only an empty legacy icon on a copy of the original link;
                # preserve its custom fields and refuse a changed original.
                Assert-InstallHostEntries $HostPlan $true
                if(-not [IO.File]::Exists($entry.path) -or
                    (Get-FileHash -LiteralPath $entry.path -Algorithm SHA256).Hash -cne $originalHash){
                    throw "install_shortcut_changed: '$($entry.path)' changed during publication. Next action: preserve the changed shortcut and retry after its ownership and customization are reviewed."
                }
            }
            [IO.File]::Move($temporary,$entry.path,[bool]$current)
            $published=Read-InstallShortcut $HostPlan $entry
            if($published.icon_location -ine $entry.icon_location){throw "install_shortcut_unconfirmed: '$($entry.path)' icon was not confirmed. Next action: run Recover for this owned installation."}
        } finally {if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
    }
    $HostPlan.values.DisplayVersion=$Version
    if($HostPlan.registry_file){Write-InstallJson $HostPlan.registry $HostPlan.values}
    else {
        $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($HostPlan.registry)
        try {
            if($key.GetValueNames().Count -and $key.GetValue('LodestarInstallId') -cne $HostPlan.values.LodestarInstallId){throw 'install_registration_conflict: registration ownership changed during publication.'}
            $key.SetValue('LodestarInstallId',$HostPlan.values.LodestarInstallId)
            foreach($field in $HostPlan.values.Keys){$key.SetValue($field,$HostPlan.values[$field],[Microsoft.Win32.RegistryValueKind]::String)}
        } finally {$key.Dispose()}
    }
    Assert-InstallHostEntries $HostPlan $true
    $verified=Read-InstallRegistration $HostPlan
    foreach($field in $HostPlan.values.Keys){if($verified[$field] -cne $HostPlan.values[$field]){throw "install_registration_unconfirmed: '$field'. Next action: run Recover to reconcile owned registration."}}
}
function Invoke-InstallDatabase([string]$App,[string]$Node,[string]$Database,[bool]$Initialize,[bool]$Migrate,[string]$Request,[string]$Backup,[string]$Fault='') {
    $helper=Join-Path $App 'core\src\install-database.mjs'
    if(-not [IO.File]::Exists($helper)){throw "install_helper_missing: '$helper'. Next action: use the complete current release; preserve the selected database."}
    $arguments=@($helper,'--db',$Database)
    if($Initialize){$arguments+='--initialize'}
    if($Migrate){$arguments+=@('--migrate','--request',$Request,'--backup',$Backup)}
    if($Fault -in @('AfterBackup','AfterRequest','AfterMigration')){$arguments+=@('--fault',$Fault)}
    $result=Invoke-CleanNode $Node $arguments -TimeoutMs 120000
    $parsed=Read-CliEnvelope $result 'install.database' @() ($Initialize -or $Migrate)
    $reported=if($parsed.Envelope -and $parsed.Envelope['error']){$parsed.Envelope.error}else{$null}
    $jsonOptions=[Text.Json.JsonSerializerOptions]::new();$jsonOptions.MaxDepth=1024
    $coreDetails=if($reported){
        $guidance=if($reported.action -is [string]){$reported.action}else{[Text.Json.JsonSerializer]::Serialize[object]($reported.action,$jsonOptions)}
        "$($reported.code): $($reported.message) Identifiers: $([Text.Json.JsonSerializer]::Serialize[object]($reported.identifiers,$jsonOptions)) Next action: $guidance"
    }else{$parsed.Code}
    if($parsed.Kind -eq 'transport_error'){
        throw "install_database_outcome_unconfirmed: $coreDetails Next action: preserve '$Database', '$Backup' and exact request '$Request'. Run Recover with this same selection to inspect and reconcile current state before any repeated initialization or migration. Application recovery does not reverse database conversion."
    }
    if($parsed.Kind -ne 'success'){
        if($parsed.Envelope -and $parsed.Envelope['error']){
            throw $coreDetails
        }
        throw "install_database_outcome_unknown/$($parsed.Code): database operation cannot be confirmed. Next action: preserve '$Database', '$Backup' and exact request '$Request'; run Recover with the same selection before retrying. Application recovery does not reverse a database conversion."
    }
    return $parsed.Envelope.data
}
function Get-InstallSelection([string]$Payload,[string]$Destination,[string]$NodePath,[string]$DatabasePath,[string]$PreviousInstallation,
    [bool]$TestMode,[string]$TestHostRoot,[bool]$DesktopShortcut,[string]$TestRegistrySuffix='') {
    if(-not $Destination){$Destination=Join-Path $env:LOCALAPPDATA 'Programs\Lodestar'}
    if(-not [IO.Path]::IsPathFullyQualified($Destination)){throw 'Destination must be absolute.'}
    $target=[IO.Path]::GetFullPath($Destination).TrimEnd('\');Assert-PlainPath $target
    if([IO.Path]::GetPathRoot($target).TrimEnd('\') -eq $target){throw 'Destination cannot be a volume root.'}
    $payloadFull=[IO.Path]::GetFullPath($Payload).TrimEnd('\');Assert-PlainPath $payloadFull
    $receipt=Read-InstallReceipt $target
    $sourceConfig=$null
    if($PreviousInstallation){
        if(-not [IO.Path]::IsPathFullyQualified($PreviousInstallation)){throw 'PreviousInstallation must be an absolute verified bundle path.'}
        $previous=[IO.Path]::GetFullPath($PreviousInstallation).TrimEnd('\');Test-Bundle $previous|Out-Null
        $sourceConfig=Read-InterfaceConfig $previous
    }
    if([IO.Directory]::Exists($target) -and (-not $receipt -or $receipt.phase -ne 'uninstalling')){
        Test-Bundle $target|Out-Null
        if($sourceConfig){throw 'PreviousInstallation applies only to a fresh destination; existing selected configuration is authoritative.'}
        $sourceConfig=Read-InterfaceConfig $target
    }
    if($sourceConfig){
        if(($NodePath -and [IO.Path]::GetFullPath($NodePath) -ine $sourceConfig.Node) -or ($DatabasePath -and [IO.Path]::GetFullPath($DatabasePath) -ine $sourceConfig.Database)){throw 'install_selection_conflict: requested Node/database conflicts with preserved interfaces.json. Next action: use its selected paths.'}
        $NodePath=$sourceConfig.Node;$DatabasePath=$sourceConfig.Database
    } elseif($receipt) {
        if($receipt.phase -ne 'uninstalled' -and (($NodePath -and [IO.Path]::GetFullPath($NodePath) -ine $receipt.node) -or ($DatabasePath -and [IO.Path]::GetFullPath($DatabasePath) -ine $receipt.database))){throw 'install_selection_conflict: requested paths conflict with interrupted receipt.'}
        if(-not $NodePath){$NodePath=$receipt.node};if(-not $DatabasePath){$DatabasePath=$receipt.database}
        $retained=$target+'.lodestar-config-retained.json'
        if($receipt.phase -eq 'uninstalled' -and [IO.File]::Exists($retained) -and $NodePath -ieq $receipt.node -and $DatabasePath -ieq $receipt.database){
            Assert-PlainPath $retained
            $value=Read-StrictJsonFile $retained -AsHashtable -Contract configuration
            $resolve={param($value) [IO.Path]::GetFullPath($(if([IO.Path]::IsPathFullyQualified($value)){$value}else{Join-Path $target $value}))}
            if($value['runtime'] -isnot [Collections.IDictionary] -or (&$resolve $value.runtime.node) -ine $receipt.node -or (&$resolve $value.runtime.database) -ine $receipt.database){throw 'install_retained_config_conflict: retained config differs from the saved selection. Next action: preserve both and restore accepted configuration before reinstalling.'}
            $sourceConfig=[pscustomobject]@{Path=$retained;Node=$receipt.node;Database=$receipt.database}
        }
    }
    $node=Resolve-Node $NodePath
    if(-not $DatabasePath){$DatabasePath=Join-Path $env:LOCALAPPDATA 'Lodestar\lodestar.db'}
    if(-not [IO.Path]::IsPathFullyQualified($DatabasePath)){throw 'DatabasePath must be absolute.'}
    $database=[IO.Path]::GetFullPath($DatabasePath);Assert-PlainPath $database
    Assert-ExternalDatabase $database @($target,"$target.lodestar-stage","$target.lodestar-previous",$payloadFull) 'install_database_inside_app: keep the database outside app, payload and update folders.'
    $id=if($receipt){$receipt.id}else{[guid]::NewGuid().ToString('D')}
    $selectedDesktop=if($receipt -and $receipt.Contains('desktop_shortcut')){[bool]$receipt.desktop_shortcut}else{$DesktopShortcut}
    $hostPlan=Get-InstallHost $target $id $TestMode $TestHostRoot $selectedDesktop $TestRegistrySuffix
    if($receipt -and $receipt.phase -ne 'uninstalled'){
        if($receipt.host.test -ne $TestMode){throw 'install_host_conflict: test and live registration selection differ.'}
        if($receipt.host.registry -cne $hostPlan.registry -or @($receipt.host.shortcuts).Count -ne @($hostPlan.shortcuts).Count){throw 'install_host_conflict: receipt host paths differ from controlled selected destinations.'}
        for($i=0;$i -lt @($hostPlan.shortcuts).Count;$i++){
            foreach($field in @('path','target','arguments','working_directory')){
                if($receipt.host.shortcuts[$i][$field] -cne $hostPlan.shortcuts[$i][$field]){throw "install_host_conflict: receipt shortcut field '$field' escaped its controlled selection."}
            }
        }
        foreach($field in $hostPlan.values.Keys){if($receipt.host.values[$field] -cne $hostPlan.values[$field]){throw "install_host_conflict: receipt registration '$field' differs from its controlled selection."}}
    }
    return @{target=$target;node=$node;database=$database;receipt=$receipt;config=$sourceConfig;id=$id;host=$hostPlan;desktop=$selectedDesktop;
        receipt_path=($target+'.lodestar-install.json');request=($target+'.lodestar-migration.json');
        backup=($database+'.lodestar-schema4-'+$id+'.backup.db')}
}
function Enter-InstallLock([string]$Target,[bool]$Recover) {
    $file=$Target+'.lodestar-install.lock';Assert-PlainPath $file
    if([IO.File]::Exists($file)){
        $prior=Read-StrictJsonFile $file -AsHashtable
        if($prior['product'] -cne 'Lodestar' -or $prior['target'] -ine $Target -or $prior['pid'] -isnot [long]){throw "install_lock_conflict: '$file'. Next action: preserve this unrecognized lock."}
        $process=Get-Process -Id $prior.pid -ErrorAction SilentlyContinue
        if($process -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq $prior.start){throw "install_busy: process $($prior.pid) owns '$file'. Next action: wait for that installation operation to finish."}
        if(-not $Recover){throw "install_lock_stale: '$file'. Next action: run Install -Mode Recover for this exact destination."}
        $handle=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $handle.Dispose();[IO.File]::Delete($file)
    }
    $handle=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {
        $value=@{product='Lodestar';target=$Target;pid=$PID;start=(Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks.ToString()}
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($value|ConvertTo-Json -Compress));$handle.Write($bytes,0,$bytes.Length);$handle.Flush($true)
    } catch {$handle.Dispose();throw}
    return @{handle=$handle;path=$file}
}
function Exit-InstallLock($Lock){if($Lock){$Lock.handle.Dispose();if([IO.File]::Exists($Lock.path)){[IO.File]::Delete($Lock.path)}}}

Export-ModuleMember -Function Write-InstallJson,Read-InstallReceipt,Get-InstallSelection,Assert-InstallHostEntries,Publish-InstallHostEntries,
    Invoke-InstallDatabase,Enter-InstallLock,Exit-InstallLock,Read-InstallRegistration
