<#
.SYNOPSIS
Installs Lodestar Loader and Manager for the current Windows user.
.DESCRIPTION
Plan describes resolved paths without writing. Install initializes a selected absent store only as this explicit operation.
Existing interfaces.json is preserved byte-for-byte. Schema4 conversion requires -MigrateDatabase, an independent verified
backup and retained exact request. Close every database writer first. Recover reconciles retained application and database
evidence. Application rollback never rolls back a database conversion. Uninstall retains database and selected config.
No administrator access, PATH edits, service, autostart or background updater is used. Node >=24.15.0, .NET Desktop 10 x64
and PowerShell 7 are required. Run Setup.cmd for the existing portable-only configuration workflow.
.PARAMETER Destination
Application directory, default LOCALAPPDATA/Programs/Lodestar.
.PARAMETER DatabasePath
External selected database, default LOCALAPPDATA/Lodestar/lodestar.db.
.PARAMETER PreviousInstallation
One explicitly selected verified old portable bundle. Its config is preserved and original files remain intact.
.PARAMETER MigrateDatabase
Explicitly convert inspected schema4 with verified backup and saved request. Unknown or future schema is refused.
.PARAMETER TestMode
Use only with a disposable TestHostRoot. Host registration/shortcuts use file adapters; public registry is untouched.
.EXAMPLE
pwsh -NoProfile -File .\Install.ps1 -Mode Plan
.EXAMPLE
pwsh -NoProfile -File .\Install.ps1
.EXAMPLE
pwsh -NoProfile -File .\Install.ps1 -PreviousInstallation C:\Apps\OldLodestar -MigrateDatabase
#>
#requires -Version 7.0
[CmdletBinding()]
param([ValidateSet('Plan','Install','Recover','Uninstall')][string]$Mode='Install',
    [string]$Destination,[string]$DatabasePath,[string]$NodePath,[string]$PreviousInstallation,
    [switch]$MigrateDatabase,[switch]$DesktopShortcut,[switch]$TestMode,[string]$TestHostRoot,[string]$TestRegistrySuffix,
    [ValidateSet('','AfterBackup','AfterRequest','AfterMigration','BeforeSwap','AfterSwap','AfterRegistration','AfterUninstallReceipt')][string]$Fault='',[switch]$Help)
if($Help){Get-Help $PSCommandPath -Detailed;return}
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
try {
    Import-Module (Join-Path $PSScriptRoot 'InstallTools.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'DistributionTools.psm1') -Force
    Import-Module (Join-Path $PSScriptRoot 'BundleTools.psm1') -Force -DisableNameChecking
} catch { [Console]::Error.WriteLine("Install stage 'module_loading' failed: $($_.Exception.Message) Next action: use a complete verified extraction with InstallTools, DistributionTools and BundleTools; preserve retained application, configuration and database evidence."); exit 1 }
$stage='selection';$lock=$null;$selection=$null
try {
    if($Fault -and -not $TestMode){throw 'Fault injection requires explicit TestMode.'}
    $selection=Get-InstallSelection $PSScriptRoot $Destination $NodePath $DatabasePath $PreviousInstallation $TestMode $TestHostRoot $DesktopShortcut $TestRegistrySuffix
    $s=$selection;$target=$s.target;$receipt=$s.receipt
    if($Mode -eq 'Recover' -and -not $receipt){throw "install_recovery_unowned: no accepted installation receipt at '$($s.receipt_path)'. Next action: preserve remaining application files, selected configuration and store; restore the original owned receipt before Recover. For deliberate installation or portable adoption, use explicit -Mode Install with the supported selected route."}
    if($receipt -and $receipt.phase -eq 'uninstalling'){
        if($Mode -eq 'Recover'){$Mode='Uninstall'}
        elseif($Mode -eq 'Install'){throw 'install_uninstall_pending: owned uninstall is incomplete. Next action: use -Mode Plan to inspect without writing, or -Mode Recover / -Mode Uninstall to resume the recorded removal; preserve selected data.'}
    }
    $stage='payload_validation'
    $payload=if($Mode -in @('Uninstall','Recover') -and [IO.Directory]::Exists($target)){$target}else{$PSScriptRoot}
    if($Mode -eq 'Recover' -and $receipt.phase -eq 'preparing'){
        $recoveryPaths=Get-BundlePaths $target
        if([IO.Directory]::Exists($recoveryPaths.Stage)){
            # The retained candidate owns distribution metadata; an adopted
            # legacy portable target may only have its original bundle manifest.
            $candidateManifest=Join-Path $recoveryPaths.Stage 'distribution-manifest.json'
            Assert-PlainPath $candidateManifest
            if(-not $receipt.Contains('candidate_manifest_sha256') -or $receipt.candidate_manifest_sha256 -notmatch '^[0-9a-f]{64}$' -or
                -not [IO.File]::Exists($candidateManifest) -or (Get-FileHash -LiteralPath $candidateManifest).Hash -ine $receipt.candidate_manifest_sha256){throw 'install_stage_conflict: retained stage differs from the recorded candidate. Next action: preserve transaction artifacts and use the original verified candidate.'}
            Test-DistributionPayload $recoveryPaths.Stage -Configured|Out-Null
            $payload=$recoveryPaths.Stage
        }
    }
    $manifest=if($Mode -eq 'Uninstall' -and $receipt -and $receipt.phase -eq 'uninstalling'){@{version=$receipt.version;files=$receipt.inventory}}
        else{Read-StrictJsonFile (Join-Path $payload 'distribution-manifest.json') -AsHashtable -Contract distribution}
    if($Mode -in @('Install','Plan')){Test-DistributionPayload $PSScriptRoot|Out-Null;Assert-DesktopRuntime}
    if($receipt -and [version]$manifest.version -lt [version]$receipt.version){throw "install_downgrade_refused: candidate $($manifest.version), installed $($receipt.version). Next action: use the same or a newer compatible release; preserve the selected database."}
    if($Mode -in @('Install','Plan') -and [IO.Directory]::Exists($target)){
        $installed=(Read-StrictJsonFile (Join-Path $target 'core/package.json') -Contract package).version
        if([version]$manifest.version -lt [version]$installed){throw "install_downgrade_refused: candidate $($manifest.version), installed core $installed. Next action: use the same or newer compatible release."}
    }
    Assert-InstallHostEntries $s.host ($null -ne $receipt -and $receipt.phase -ne 'uninstalled')
    if($Mode -eq 'Plan'){
        @{mode='Plan';version=$manifest.version;application=$target;database=$s.database;node=$s.node;
            cli=(Join-Path $target 'core\lodestar.mjs');config=(Join-Path $target 'interfaces.json');receipt=$s.receipt_path;
            migration_request=$s.request;backup=$s.backup;host=$s.host;previous_installation=$PreviousInstallation;
            new_database=(-not [IO.File]::Exists($s.database));migration_requested=[bool]$MigrateDatabase}|ConvertTo-Json -Depth 12
        return
    }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))|Out-Null
    $lock=Enter-InstallLock $target ($Mode -eq 'Recover')
    # Freeze selection again under the actual operation lock.
    $freshReceipt=Read-InstallReceipt $target
    if(($null -eq $freshReceipt) -ne ($null -eq $receipt) -or ($freshReceipt -and $freshReceipt.id -cne $s.id)){throw 'install_selection_changed: ownership changed while acquiring the lock.'}
    $paths=Get-BundlePaths $target
    if($Mode -eq 'Uninstall'){
        $stage='uninstall_validation'
        if(-not $receipt -or $receipt.phase -notin @('registered','uninstalling')){throw 'install_unowned: Uninstall requires an owned registered receipt.'}
        if($receipt.phase -eq 'registered'){
            Test-Bundle $target|Out-Null
            if($receipt.node -ine $s.node -or $receipt.database -ine $s.database){throw 'install_selection_changed: config differs from saved installation selection. Next action: preserve both selections and reconcile with Install before uninstalling.'}
        }
        $manifestPath=Join-Path $target 'distribution-manifest.json';Assert-PlainPath $manifestPath
        $manifestExists=[IO.File]::Exists($manifestPath)
        if(-not $receipt.Contains('candidate_manifest_sha256') -or $receipt.candidate_manifest_sha256 -notmatch '^[0-9a-f]{64}$' -or
            ($manifestExists -and (Get-FileHash $manifestPath).Hash -ine $receipt.candidate_manifest_sha256) -or
            (-not $manifestExists -and $receipt.phase -ne 'uninstalling')){throw 'install_inventory_changed: remaining target distribution manifest differs from the accepted receipt. Next action: preserve all files and restore the accepted immutable inventory before uninstalling.'}
        if($receipt['inventory'] -isnot [array] -or @($receipt.inventory).Count -ne @($manifest.files).Count){throw 'install_inventory_invalid: receipt inventory is missing or changed. Next action: preserve the receipt and application; restore accepted ownership evidence.'}
        $expected=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
        foreach($entry in $receipt.inventory){
            if($entry -isnot [Collections.IDictionary] -or $entry['path'] -isnot [string] -or $entry.path.Contains('\') -or $entry.path.Split('/') -contains '..' -or
                $entry['sha256'] -notmatch '^[0-9a-f]{64}$' -or ($entry['bytes'] -isnot [long] -and $entry['bytes'] -isnot [int]) -or $entry.bytes -lt 0 -or $expected.ContainsKey($entry.path)){throw 'install_inventory_invalid: receipt entry is malformed. Next action: preserve its bytes and restore the accepted installation receipt.'}
            $expected.Add($entry.path,$entry)
        }
        foreach($entry in $manifest.files){if(-not $expected.ContainsKey($entry.path) -or $expected[$entry.path].bytes -ne $entry.bytes -or $expected[$entry.path].sha256 -cne $entry.sha256){throw 'install_inventory_changed: current inventory differs from accepted receipt. Next action: preserve application and receipt before uninstalling.'}}
        $manifest.files=@($receipt.inventory)
        $listed=@($manifest.files.path)+@('distribution-manifest.json','interfaces.json')
        foreach($file in $(if([IO.Directory]::Exists($target)){@(Get-PlainFiles $target)}else{@()})){
            $relative=[IO.Path]::GetRelativePath($target,$file).Replace('\','/')
            if($relative -notin $listed){throw "install_foreign_file: '$file'. Next action: preserve this unowned file before uninstalling."}
        }
        foreach($entry in $manifest.files){$file=Assert-Child $target (Join-Path $target $entry.path);if([IO.File]::Exists($file) -and (Get-FileHash -LiteralPath $file).Hash -ine $entry.sha256){throw "install_file_changed: '$file'. Next action: preserve modified bytes before uninstalling."}}
        Assert-NotRunning $paths
        # Retire only a proven completed transaction while its target still
        # exists. The existing owner preserves unknown/changed journals and
        # previous inventory, and resumes its own interrupted retirement.
        if([IO.File]::Exists($paths.Journal)){Invoke-BundleRetirePrevious $paths}
        $retained=$target+'.lodestar-config-retained.json';Assert-PlainPath $retained
        if([IO.File]::Exists((Join-Path $target 'interfaces.json'))){
            if([IO.File]::Exists($retained)){if((Get-FileHash $retained).Hash -ne (Get-FileHash (Join-Path $target 'interfaces.json')).Hash){throw 'install_retained_config_conflict: preserved config path is occupied.'}}
            else {[IO.File]::Copy((Join-Path $target 'interfaces.json'),$retained,$false)}
        } elseif(-not [IO.File]::Exists($retained)){throw 'install_retained_config_missing: preserve and restore selected config evidence before continuing.'}
        $receipt.phase='uninstalling';$receipt.inventory=@($manifest.files);Write-InstallJson $s.receipt_path $receipt
        if($Fault -eq 'AfterUninstallReceipt'){throw 'install_interrupted: after owned uninstall receipt; resume with -Mode Recover or -Mode Uninstall.'}
        $stage='uninstall_host_entries'
        foreach($entry in $s.host.shortcuts){if([IO.File]::Exists($entry.path)){[IO.File]::Delete($entry.path)}}
        if($s.host.registry_file){if([IO.File]::Exists($s.host.registry)){[IO.File]::Delete($s.host.registry)}}
        else {[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKey($s.host.registry,$false)}
        $stage='uninstall_application'
        if([IO.Directory]::Exists($target)){
            # The validated receipt owns these paths, not a later enumeration.
            # Recheck each remaining file so a concurrent replacement survives.
            $owned=@($receipt.inventory)+@(@{path='distribution-manifest.json';sha256=$receipt.candidate_manifest_sha256},
                @{path='interfaces.json';sha256=(Get-FileHash -LiteralPath $retained).Hash})
            $directories=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
            foreach($entry in $owned){
                $file=Assert-Child $target (Join-Path $target $entry.path)
                if([IO.Directory]::Exists($file)){throw "install_file_changed: '$file' is now a directory. Next action: preserve its contents and reconcile owned paths before resuming Uninstall."}
                if([IO.File]::Exists($file)){
                    if((Get-FileHash -LiteralPath $file).Hash -ine $entry.sha256){throw "install_file_changed: '$file' changed after ownership validation. Next action: preserve the replacement outside the application and resume this destination with Install -Mode Recover."}
                    [IO.File]::Delete($file)
                }
                $parent=[IO.Path]::GetDirectoryName($file)
                while($parent -ine $target){$null=$directories.Add($parent);$parent=[IO.Path]::GetDirectoryName($parent)}
            }
            # Delete only empty parents of sealed files. Unlisted files and even
            # empty unlisted directories keep the removal explicitly incomplete.
            try {
                foreach($directory in @($directories|Sort-Object Length -Descending)){
                    $null=Assert-Child $target $directory
                    if([IO.Directory]::Exists($directory)){[IO.Directory]::Delete($directory,$false)}
                }
                Assert-PlainPath $target;[IO.Directory]::Delete($target,$false)
            } catch {throw "install_uninstall_incomplete: retained entries under '$target': $($_.Exception.Message) Next action: preserve remaining files and directories outside the application, then run Install -Mode Recover for this destination; the saved uninstall receipt remains pending."}
        }
        $receipt.phase='uninstalled';Write-InstallJson $s.receipt_path $receipt
        Write-Host "Uninstalled owned application and host entries. Database retained: $($s.database). Configuration retained: $retained."
        return
    }
    if(-not $receipt -or $receipt.phase -eq 'uninstalled'){
        $receipt=@{v=1;product='Lodestar';id=$s.id;target=$target;node=$s.node;database=$s.database;version=$manifest.version;
            phase='preparing';host=$s.host;desktop_shortcut=$s.desktop;migration_request=$s.request;backup=$s.backup}
        Write-InstallJson $s.receipt_path $receipt
    }
    if($Mode -eq 'Recover'){
        $stage='application_recovery'
        if([IO.File]::Exists($paths.Journal)){
            $recovered=Invoke-BundleRecover $paths
            if($recovered.state -eq 'pre_swap_stage_retained'){
                if(-not $receipt.Contains('candidate_manifest_sha256') -or (Get-FileHash (Join-Path $paths.Stage 'distribution-manifest.json')).Hash -ine $receipt.candidate_manifest_sha256){throw 'install_stage_conflict: retained stage differs from the recorded candidate. Next action: preserve transaction artifacts and use the original verified candidate.'}
                Test-DistributionPayload $paths.Stage -Configured|Out-Null
                Invoke-InstallDatabase $paths.Stage $s.node $s.database $false $false '' ''|Out-Null
                Seal-BundleStage $paths|Out-Null
                Invoke-BundleSwap $paths|Out-Null
            }
        }
        if(-not [IO.Directory]::Exists($target)){throw 'install_recovery_pending: no promoted app yet. Next action: inspect retained bundle transaction and rerun Install from the verified candidate after resolving its stage.'}
        $stage='database_reconciliation'
        Test-DistributionPayload $target -Configured|Out-Null
        Invoke-InstallDatabase $target $s.node $s.database $false ($MigrateDatabase -or [IO.File]::Exists($s.request)) $s.request $s.backup|Out-Null
        Test-Bundle $target|Out-Null
        $manifest=Read-StrictJsonFile (Join-Path $target 'distribution-manifest.json') -AsHashtable -Contract distribution
    } else {
        if($PSScriptRoot -ieq $target -or $PSScriptRoot.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($PSScriptRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'install_payload_overlap: use an extracted release separate from the installed directory.'}
        $stage='database_preparation'
        Assert-NotRunning $paths
        if($PreviousInstallation){Assert-BundleProcessesIdle @([IO.Path]::GetFullPath($PreviousInstallation))}
        $receipt.phase='preparing';$receipt.candidate_manifest_sha256=(Get-FileHash (Join-Path $PSScriptRoot 'distribution-manifest.json')).Hash.ToLowerInvariant();Write-InstallJson $s.receipt_path $receipt
        Invoke-InstallDatabase $PSScriptRoot $s.node $s.database (-not [IO.File]::Exists($s.database)) ([bool]$MigrateDatabase) $s.request $s.backup $Fault|Out-Null
        # Repeat at the same manifest generation needs no bundle rewrite.
        $same=[IO.File]::Exists((Join-Path $target 'distribution-manifest.json')) -and
            (Get-FileHash (Join-Path $target 'distribution-manifest.json')).Hash -eq (Get-FileHash (Join-Path $PSScriptRoot 'distribution-manifest.json')).Hash -and
            (Get-FileHash (Join-Path $target 'bundle-manifest.json')).Hash -eq (Get-FileHash (Join-Path $PSScriptRoot 'bundle-manifest.json')).Hash
        if(-not $same){
            $stage='application_staging'
            New-BundleTransaction $paths|Out-Null;Copy-BundlePreserved $paths
            foreach($entry in $manifest.files){$from=Assert-Child $PSScriptRoot (Join-Path $PSScriptRoot $entry.path);$to=Assert-Child $paths.Stage (Join-Path $paths.Stage $entry.path);[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))|Out-Null;[IO.File]::Copy($from,$to,$true)}
            [IO.File]::Copy((Join-Path $PSScriptRoot 'distribution-manifest.json'),(Join-Path $paths.Stage 'distribution-manifest.json'),$true)
            if(-not [IO.File]::Exists((Join-Path $paths.Stage 'interfaces.json'))){
                if($s.config){[IO.File]::Copy($s.config.Path,(Join-Path $paths.Stage 'interfaces.json'),$false)}
                else {Write-InstallJson (Join-Path $paths.Stage 'interfaces.json') @{v=1;generation=[guid]::NewGuid().ToString('D');runtime=@{node=$s.node;cli='core/lodestar.mjs';database=$s.database};loader='Lodestar.Loader.exe'}}
            }
            $stage='candidate_validation'
            Test-DistributionPayload $paths.Stage -Configured|Out-Null
            Invoke-InstallDatabase $paths.Stage $s.node $s.database $false $false '' ''|Out-Null
            Seal-BundleStage $paths|Out-Null
            if($Fault -eq 'BeforeSwap'){throw 'install_interrupted: test interruption after sealing the candidate stage.'}
            $stage='application_promotion';Invoke-BundleSwap $paths|Out-Null
        }
    }
    $receipt.phase='promoted';$receipt.version=$manifest.version;$receipt.inventory=@($manifest.files);Write-InstallJson $s.receipt_path $receipt
    if($Fault -eq 'AfterSwap'){throw 'install_interrupted: test interruption after application promotion.'}
    $stage='host_registration';Publish-InstallHostEntries $s.host $receipt.version
    if($Fault -eq 'AfterRegistration'){throw 'install_interrupted: test interruption after host entry publication.'}
    $receipt.phase='registered';Write-InstallJson $s.receipt_path $receipt
    Write-Host "Installed Lodestar $($receipt.version) for this user. Application: $target. Database: $($s.database). Node: $($s.node). Loader and Manager shortcuts are verified."
} catch {
    $message="Install mode '$Mode' stage '$stage' failed: $($_.Exception.Message)"
    if($selection){$message+=" Preserve '$($selection.database)', receipt '$($selection.receipt_path)', backup '$($selection.backup)' and exact request '$($selection.request)'. Application recovery does not reverse database migration."}
    if($message -notmatch 'Next action:'){$message+=' Next action: correct the named cause; use Install -Mode Recover for this same destination to reconcile retained state before retrying.'}
    [Console]::Error.WriteLine($message);exit 1
} finally {Exit-InstallLock $lock}
