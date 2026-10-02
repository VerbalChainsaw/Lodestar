LODESTAR 3 — LOADER + MANAGER

Requirements: Windows x64, Node.js 24.15.0 or newer, .NET 10 Desktop Runtime
(x64), and PowerShell 7. This framework-dependent package uses your installed
runtimes. It does not download runtimes or require administrator access.

INSTALL FOR EVERYDAY USE
1. Extract the entire verified ZIP to a separate folder.
2. Run Install.cmd. It installs for your current Windows user, checks the selected
   runtime/database and adds Start Menu entries for Loader and Manager.
3. Open Lodestar Loader or Lodestar Manager from the Start Menu. Close the app
   window to quit; Manager closes separately.

The application defaults to %LOCALAPPDATA%\Programs\Lodestar. The database defaults
to %LOCALAPPDATA%\Lodestar\lodestar.db and stays outside the application. Install
creates this absent store as part of this explicit installation. An existing
store is inspected before use. Existing interfaces.json is preserved byte-for-byte.
There is no service, autostart, PATH/environment edit, background updater or live
agent monitoring. An owned HKCU uninstall entry and Start Menu shortcuts are the
normal host changes; -DesktopShortcut explicitly adds a Loader desktop shortcut.

Inspect resolved paths without installing:
  pwsh -NoProfile -File .\Install.ps1 -Mode Plan
Select different paths:
  pwsh -NoProfile -File .\Install.ps1 -Destination "C:\Apps\Lodestar" -DatabasePath "C:\Data\lodestar.db" -NodePath "C:\Tools\node.exe"
Use paths outside application/payload/update folders for the database. The
installer rejects reparse-point paths, conflicting ownership and changed payloads.
Plan performs prerequisite checks and reads; it never initializes or migrates data.

OLDER INSTALLATIONS AND UPDATES
Close Loader, Manager and other database writers first. Extract the new release
separately, then run its Install.cmd again for an owned per-user installation.
Keep the same destination and selected database. To adopt one old portable bundle:
  pwsh -NoProfile -File .\Install.ps1 -PreviousInstallation "C:\Apps\OldLodestar"
The old bundle must validate. Its configuration and selected store are preserved;
the original portable directory remains. Unrecognized or ambiguous state is
reported for review rather than overwritten. The desktop installer does not
replace a global npm installation or activate native agent skills/hooks.

The supported schema-4 database upgrade requires an explicit option:
  pwsh -NoProfile -File .\Install.ps1 -MigrateDatabase
It retains an independently verified backup and exact migration request before
conversion. Schema 5 needs no conversion. Unknown, corrupt or future schemas are
refused with recovery guidance. Close every writer before conversion; do not copy
only a live SQLite main file while WAL data may be present.

RECOVERY AND UNINSTALL
For an interrupted owned installation or upgrade, use the extracted release:
  pwsh -NoProfile -File .\Install.ps1 -Mode Recover -Destination "C:\path\to\installed app"
Keep its receipt, exact migration request, backup, stage and previous bundle until
recovery succeeds. Recovery reconciles the recorded selection and exact request;
it does not blindly issue a new write. Application rollback does not reverse a
database conversion. Recovery artifacts sit beside the selected app/database;
errors identify their actual paths. Do not remove unknown files to pass validation.

Uninstall through Windows Installed Apps or run the installed script:
  pwsh -NoProfile -File .\Install.ps1 -Mode Uninstall -Destination "C:\path\to\installed app"
Only unchanged owned application files and registration are removed. The database,
retained configuration and recovery evidence survive. Modified/foreign files and
registration cause an explicit conflict; preserve them and follow the stated action.

PORTABLE USE
To keep an extracted bundle portable, run Setup.cmd, then Loader.cmd or Manager.cmd.
Setup selects an existing store; creating one requires -InitializeDatabase and an
explicit absent external path. It refuses to overwrite interfaces.json. Lodestar.cmd
runs the configured CLI with literal arguments. Each launcher supports --help.
For a portable update, from the new extracted release run:
  Update.cmd "C:\path\to\existing portable app"
For interrupted portable updates:
  pwsh -NoProfile -File .\Update.ps1 -Mode Recover -Destination "C:\path\to\existing portable app"
Update refuses owned installed destinations and directs them to Install, preserving
their receipt and Windows registration. Downgrades and unsupported database schemas
are refused. Keep transaction folders until recovery reports its outcome.

ERRORS AND SCRIPTED USE
Install.cmd pauses after a failure only when launched without arguments, so a
double-clicked error remains visible. Calls with arguments and the other launchers
return their exit code without waiting for a keypress. Run a failing launcher in
an existing terminal to keep its output visible. Errors name the failed stage and
next safe action. An unconfirmed write remains uncertain until receipt reconciliation.

VERIFY A DOWNLOAD
Compare the ZIP's SHA-256 with SHA256SUMS.txt from the same verified release:
  Get-FileHash .\Lodestar-3.0.0-win-x64.zip -Algorithm SHA256
Byte inventories detect changed bytes; this unsigned package has no Authenticode
publisher signature. Windows may mark downloads as coming from the Internet.
RemoteSigned policy can reject an unsigned marked script before Lodestar runs.
Verify the release and inspect its scripts/Zone.Identifier before trusting it:
  Get-Item .\Install.ps1 -Stream Zone.Identifier -ErrorAction SilentlyContinue
If you trust the verified extracted release, explicitly unblock its scripts:
  Get-ChildItem . -Recurse -File -Include *.ps1,*.psm1 | Unblock-File
No launcher changes execution policy or unblocks files automatically.

OFFICIAL PREREQUISITES
Node: https://nodejs.org/en/download
.NET Desktop Runtime: https://dotnet.microsoft.com/en-us/download/dotnet/10.0
PowerShell: https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows

Read RELEASE-NOTES.md and docs/installation.md in the source package for supported
functionality, agent setup, path transport and compatibility boundaries. Physical
power-loss durability is not certified; keep independent backups.
