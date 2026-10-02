using System.Windows;
using System.Diagnostics;
using System.Text.Json;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;

namespace Lodestar.Loader;

public partial class App : Application
{
    private static readonly string? AppBuild = ReadAppBuild();
    private static string? _diagnosticRoot;
    public static DiagnosticLog Diagnostics { get; private set; } = new(appBuild: AppBuild);

    public App()
    {
        DispatcherUnhandledException += (_, args) =>
            LogFailure(DiagnosticOperation.DispatcherUnhandled, args.Exception, fatal: true);
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception error)
                LogFailure(DiagnosticOperation.AppUnhandled, error, args.IsTerminating);
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
            LogFailure(DiagnosticOperation.TaskUnhandled, args.Exception, fatal: false);
    }

    public static void ConfigureDiagnostics(RuntimeSelection runtime) =>
        Diagnostics = new(_diagnosticRoot, AppBuild, runtime.Fingerprint);

    public static DiagnosticWriteResult LogFailure(DiagnosticOperation operation, Exception error, bool fatal = false)
    {
        var result = Diagnostics.RecordFailure(operation, error, fatal);
        if (result.Status == DiagnosticWriteStatus.Failed)
        {
            // Logger failure is subordinate; notice delivery must never recurse or replace the primary failure.
            try
            {
                var application = Current;
                void ShowNotice()
                {
                    if (application?.MainWindow is MainWindow window) window.ShowDiagnosticNotice();
                }
                if (application?.Dispatcher.CheckAccess() == true) ShowNotice();
                else if (application is not null && !application.Dispatcher.HasShutdownStarted)
                    application.Dispatcher.BeginInvoke(new Action(ShowNotice));
            }
            catch { /* Preserve the original failure and the logger's retained failed status. */ }
        }
        return result;
    }

    private static string? ReadAppBuild()
    {
        try { return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Assembly.GetExecutingAssembly().Location))); }
        catch { return Assembly.GetExecutingAssembly().GetName().Version?.ToString(); }
    }

    protected override async void OnStartup(StartupEventArgs e)
    {
        var startupWatch = Stopwatch.StartNew();
        base.OnStartup(e);
        string? config = null, project = null, record = null, capture = null, journalRoot = null,
            diagnosticsFile = null, performanceOutput = null;
        var performanceSeconds = 0;
        var smoke = false;
        var operatorSmoke = false;
        var interactiveSmoke = false;
        for (var index = 0; index < e.Args.Length; index++)
        {
            var key = e.Args[index];
            if (key == "--smoke") { smoke = true; continue; }
            if (key == "--operator-smoke") { smoke = true; operatorSmoke = true; continue; }
            if (key == "--interactive-smoke") { interactiveSmoke = true; continue; }
            if (key is not ("--interface-config" or "--project" or "--record" or "--capture-dir" or "--journal-root" or "--diagnostics-file" or "--performance-output" or "--performance-seconds") ||
                ++index >= e.Args.Length)
            {
                MessageBox.Show("Expected --interface-config PATH [--project ID] [--record ID] [--diagnostics-file PATH]. Smoke mode also needs --capture-dir PATH.",
                    "Lodestar Loader arguments", MessageBoxButton.OK, MessageBoxImage.Error);
                Shutdown(2); return;
            }
            switch (key)
            {
                case "--interface-config": config = e.Args[index]; break;
                case "--project": project = e.Args[index]; break;
                case "--record": record = e.Args[index]; break;
                case "--capture-dir": capture = e.Args[index]; break;
                case "--journal-root": journalRoot = e.Args[index]; break;
                case "--diagnostics-file": diagnosticsFile = e.Args[index]; break;
                case "--performance-output": performanceOutput = e.Args[index]; break;
                case "--performance-seconds":
                    if (!int.TryParse(e.Args[index], out performanceSeconds) || performanceSeconds is < 0 or > 600)
                    { Shutdown(2); return; }
                    break;
            }
        }
        if (smoke && (config is null || capture is null))
        {
            MessageBox.Show("Smoke mode requires an explicit interface config and capture directory.");
            Shutdown(2); return;
        }
        if (journalRoot is not null && (!interactiveSmoke || config is null ||
            !System.IO.Path.GetFullPath(journalRoot).StartsWith(
                System.IO.Path.GetFullPath(System.IO.Path.GetDirectoryName(config)!) + System.IO.Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase)))
        {
            MessageBox.Show("Interactive smoke needs a fixture-local journal directory beside its explicit interface config.",
                "Lodestar Loader test arguments", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(2); return;
        }
        if (interactiveSmoke && journalRoot is not null)
        {
            _diagnosticRoot = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(journalRoot))!, "diagnostics");
            Diagnostics = new(_diagnosticRoot, AppBuild);
        }
        if (performanceOutput is not null)
        {
            var fixtureManifest = config is null ? "" : Path.Combine(Path.GetDirectoryName(Path.GetFullPath(config))!, "fixture-manifest.json");
            if (!interactiveSmoke || journalRoot is null || !File.Exists(fixtureManifest))
            { Shutdown(2); return; }
            using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(fixtureManifest));
            var runtime = await LodestarService.LoadRuntimeAsync(config!);
            if (manifest.RootElement.GetProperty("fixture").GetString() != "synthetic-benchmark" ||
                Path.GetFullPath(manifest.RootElement.GetProperty("database").GetString()!) != Path.GetFullPath(runtime.DatabasePath))
            { Shutdown(2); return; }
        }
        var window = new MainWindow(config ?? System.IO.Path.Combine(AppContext.BaseDirectory, "interfaces.json"),
            project, record, journalRoot);
        MainWindow = window;
        window.Show();
        try
        {
            await window.InitializeAsync();
            if (diagnosticsFile is not null)
            {
                await window.Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
                window.UpdateLayout();
                var path = System.IO.Path.GetFullPath(diagnosticsFile);
                System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
                await System.IO.File.WriteAllTextAsync(path, JsonSerializer.Serialize(
                    window.StartupDiagnostics(startupWatch.ElapsedMilliseconds),
                    new JsonSerializerOptions { WriteIndented = true }));
            }
            if (smoke)
            {
                if (operatorSmoke) await window.CaptureOperatorSmokeAsync(capture!);
                else await window.CaptureSmokeAsync(capture!);
                Shutdown(0);
            }
            if (performanceOutput is not null)
            {
                var report = await window.MeasureFixtureInteractionsAsync(performanceSeconds);
                await File.WriteAllTextAsync(Path.GetFullPath(performanceOutput), JsonSerializer.Serialize(report,
                    new JsonSerializerOptions { WriteIndented = true }));
            }
        }
        catch (Exception error)
        {
            LogFailure(DiagnosticOperation.Startup, error);
            if (smoke)
            {
                try
                {
                    System.IO.Directory.CreateDirectory(capture!);
                    await System.IO.File.WriteAllTextAsync(System.IO.Path.Combine(capture!, "smoke-error.txt"),
                        "Startup failed: " + error.GetType().FullName + Environment.NewLine +
                        "Diagnostic event: " + (Diagnostics.Latest?.EventId ?? "unavailable"));
                }
                catch { /* Preserve the first failure. */ }
                Shutdown(1);
            }
            else window.ShowStartupError(error);
        }
    }
}
