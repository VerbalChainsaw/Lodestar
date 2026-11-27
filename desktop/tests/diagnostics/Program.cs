using System.Diagnostics;
using System.Text.Json;
using Lodestar.Loader;

const string Secret = "DIAGNOSTIC_FAKE_SECRET_72f84a";
const int Writers = 12;
const int Rounds = 5;

if (args is ["child", var childRoot, var childId])
{
    File.WriteAllText(Path.Combine(childRoot, "ready-" + childId), "ready");
    var wait = Stopwatch.StartNew();
    while (!File.Exists(Path.Combine(childRoot, "go")))
    {
        if (wait.Elapsed > TimeSpan.FromSeconds(15)) return 2;
        Thread.Sleep(5);
    }

    var result = new DiagnosticLog(childRoot, maxFiles: 1, maxTotalBytes: 2048)
        .RecordFailure(DiagnosticOperation.LibraryLoad,
            new InvalidOperationException(Secret), fatal: false);
    Console.WriteLine(result.Status);
    return result.Status == DiagnosticWriteStatus.Written ? 0 : 3;
}

if (args is not [var outputRoot])
    throw new ArgumentException("Pass a disposable fixture output root.");

var runRoot = Path.Combine(Path.GetFullPath(outputRoot), "run-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(runRoot);
var executable = Environment.ProcessPath ?? throw new InvalidOperationException("ProcessPath unavailable.");
var violations = new List<string>();

for (var round = 0; round < Rounds; round++)
{
    var root = Path.Combine(runRoot, "round-" + round);
    Directory.CreateDirectory(root);
    var sentinel = Path.Combine(root, "keep-me.txt");
    var lookalike = Path.Combine(root,
        "diag-20260928T120000000Z-0123456789abcdef0123456789abcdef.json");
    File.WriteAllText(sentinel, "unrelated sentinel");
    File.WriteAllText(lookalike, "not an owned event");
    var children = new List<Process>();
    try
    {
        for (var id = 0; id < Writers; id++)
        {
            var start = new ProcessStartInfo(executable)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.ArgumentList.Add("child");
            start.ArgumentList.Add(root);
            start.ArgumentList.Add(id.ToString());
            children.Add(Process.Start(start) ?? throw new InvalidOperationException("Child did not start."));
        }

        var readyWait = Stopwatch.StartNew();
        while (Directory.GetFiles(root, "ready-*").Length != Writers)
        {
            if (readyWait.Elapsed > TimeSpan.FromSeconds(15) || children.Any(p => p.HasExited))
                throw new TimeoutException("Children did not all reach the start barrier.");
            Thread.Sleep(5);
        }

        File.WriteAllText(Path.Combine(root, "go"), "go");
        var failedChildren = 0;
        foreach (var child in children)
        {
            if (!child.WaitForExit(15000)) throw new TimeoutException("Diagnostic child did not finish.");
            var status = child.StandardOutput.ReadToEnd().Trim();
            var error = child.StandardError.ReadToEnd().Trim();
            if (child.ExitCode != 0 || status != "Written")
            {
                failedChildren++;
                Console.WriteLine($"round={round} child={child.Id} exit={child.ExitCode} status={status} error={error}");
            }
        }

        var retained = Directory.GetFiles(root, "diag-*.json")
            .Where(path => path != lookalike).ToArray();
        var bytes = retained.Sum(path => new FileInfo(path).Length);
        Console.WriteLine($"round={round} written={Writers - failedChildren}/{Writers} retained={retained.Length} bytes={bytes}");
        if (failedChildren != 0 || retained.Length != 1 || bytes > 2048)
            violations.Add($"round {round}: child failure or count/byte budget exceeded");
        foreach (var path in retained)
        {
            var text = File.ReadAllText(path);
            using var document = JsonDocument.Parse(text);
            var json = document.RootElement;
            if (text.Contains(Secret, StringComparison.Ordinal) ||
                json.GetProperty("owner").GetString() != "Lodestar.Loader.DiagnosticLog" ||
                json.GetProperty("operation").GetString() != "LibraryLoad")
                violations.Add($"round {round}: private event contract failed");
        }
        if (File.ReadAllText(sentinel) != "unrelated sentinel" ||
            File.ReadAllText(lookalike) != "not an owned event")
            violations.Add($"round {round}: unrelated file changed");
    }
    finally
    {
        // Only child processes started and retained by this fixture may be stopped.
        foreach (var child in children)
        {
            if (!child.HasExited)
            {
                child.Kill(entireProcessTree: false);
                child.WaitForExit(5000);
            }
            child.Dispose();
        }
    }
}

var blockedRoot = Path.Combine(runRoot, "held-lock");
Directory.CreateDirectory(blockedRoot);
var lockPath = Path.Combine(blockedRoot, ".lodestar-diagnostic.lock");
var blockedLogger = new DiagnosticLog(blockedRoot);
using (var holder = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None))
{
    var elapsed = Stopwatch.StartNew();
    var blocked = blockedLogger.RecordFailure(DiagnosticOperation.LibraryLoad,
        new InvalidOperationException(Secret), fatal: false);
    elapsed.Stop();
    Console.WriteLine($"held-lock status={blocked.Status} elapsed_ms={elapsed.ElapsedMilliseconds}");
    if (blocked.Status != DiagnosticWriteStatus.Failed ||
        elapsed.Elapsed < TimeSpan.FromSeconds(1) || elapsed.Elapsed > TimeSpan.FromSeconds(5))
        violations.Add("held lock did not bound the wait and fail subordinate to the caller");
}
if (blockedLogger.RecordFailure(DiagnosticOperation.LibraryLoad,
        new InvalidOperationException(Secret), fatal: false).Status != DiagnosticWriteStatus.Written)
    violations.Add("logging did not recover after lock release");

Console.WriteLine($"violations={violations.Count} output={runRoot}");
foreach (var violation in violations) Console.Error.WriteLine(violation);
return violations.Count == 0 ? 0 : 1;
