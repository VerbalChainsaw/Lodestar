# Hidden native lifecycle checks

This executable links the actual Loader App/MainWindow XAML, window handlers,
Models and Services. It exercises delayed selections and refresh completions
through one bounded dispatcher run. Selection, navigation and support cases use
in-memory CLI responses. The research review/save journey generates a disposable
SQLite fixture, uses the real configured CLI and service, invokes the actual
Review/Save handlers, and reads the saved record afterward. The executable does
not show windows or call application startup. It checks logical state and control
reachability; it does not prove rendered acceptance, accessibility or performance.

From the repository root on Windows with the existing .NET 10 SDK:

```powershell
dotnet build desktop/Lodestar.Loader.WindowTests/Lodestar.Loader.WindowTests.csproj --configuration Release --configfile desktop/Lodestar.Loader.WindowTests/NuGet.Config
dotnet desktop/Lodestar.Loader.WindowTests/bin/Release/net10.0-windows/Lodestar.Loader.dll
```

Exit 0 requires every listed invariant to pass. NuGet.Config clears package
sources; this project adds no package dependency.
