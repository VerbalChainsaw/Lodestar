using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace Lodestar.Loader;

// Operation names are code-owned. Never add record IDs, arguments, paths, or user text here.
public enum DiagnosticOperation
{
    Startup, AppUnhandled, DispatcherUnhandled, TaskUnhandled, CapabilityDiscovery,
    LibraryLoad, ProjectLoad, RecordRead, HistoryRead, GenericRead, Save, Recovery,
    RuntimeSelection, ManagerLaunch, Shutdown, Doctor
}

public enum DiagnosticWriteStatus { Written, SkippedCancellation, Failed }
public enum DiagnosticAvailability { Available, Empty, Unavailable }

public sealed record DiagnosticLogStatus(DiagnosticAvailability Availability,
    DiagnosticSummary? Summary, DiagnosticWriteStatus? LastWriteStatus)
{
    public string? Notice => Availability == DiagnosticAvailability.Unavailable
        ? "Local diagnostics unavailable. Inspect the diagnostics folder in Connection and retry; the original operation outcome is unchanged."
        : LastWriteStatus == DiagnosticWriteStatus.Failed
            ? "Local diagnostic recording failed. Inspect the diagnostics folder in Connection and retry; the original operation outcome is unchanged."
            : null;
}

public sealed record DiagnosticSummary(DateTimeOffset Timestamp, string EventId,
    DiagnosticOperation Operation, bool Fatal, string ExceptionType, string Path);

public sealed record DiagnosticWriteResult(DiagnosticWriteStatus Status, DiagnosticSummary? Summary)
{
    public string? Path => Summary?.Path;
}

/// <summary>Writes only code-selected scalar evidence. Logging never handles the original exception.</summary>
public sealed class DiagnosticLog
{
    private const string Owner = "Lodestar.Loader.DiagnosticLog";
    private const int MaxEventBytes = 8192;
    private const int MaxLockWaitMilliseconds = 3000;
    private static readonly object Gate = new();
    private readonly string _root;
    private readonly string? _appBuild;
    private readonly string? _coreBuild;
    private readonly int _maxFiles;
    private readonly long _maxTotalBytes;
    private DiagnosticSummary? _latest;
    private DiagnosticWriteStatus? _lastWriteStatus;
    public string RootPath => _root;

    public static string DefaultRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Lodestar Loader", "diagnostics");

    public DiagnosticLog(string? root = null, string? appBuild = null, string? coreBuild = null,
        int maxFiles = 32, long maxTotalBytes = 262144)
    {
        _root = root ?? DefaultRoot;
        _appBuild = SafeBuild(appBuild);
        _coreBuild = SafeBuild(coreBuild);
        _maxFiles = Math.Clamp(maxFiles, 1, 128);
        _maxTotalBytes = Math.Clamp(maxTotalBytes, 2048, 1048576);
    }

    public DiagnosticSummary? Latest
    {
        get => Status.Summary;
    }

    public DiagnosticLogStatus Status
    {
        get { lock (Gate) return ReadStatus(); }
    }

    public DiagnosticWriteResult RecordFailure(DiagnosticOperation operation, Exception exception,
        bool fatal, Guid? correlationId = null)
    {
        if (exception is null || !Enum.IsDefined(operation))
            return FinishWrite(DiagnosticWriteStatus.Failed, null);
        if (exception is OperationCanceledException)
            return new(DiagnosticWriteStatus.SkippedCancellation, null);

        lock (Gate)
        {
            string? temporary = null;
            var temporaryCreated = false;
            try
            {
                var root = CheckedRoot(create: true);
                var timestamp = DateTimeOffset.UtcNow;
                var eventId = Guid.NewGuid().ToString("N");
                var fileName = "diag-" + timestamp.ToString("yyyyMMddTHHmmssfffZ", CultureInfo.InvariantCulture) +
                    "-" + eventId + ".json";
                var path = Path.Combine(root, fileName);
                var type = SafeType(exception.GetType());
                var record = new
                {
                    schema = 1,
                    owner = Owner,
                    at_utc = timestamp,
                    event_id = eventId,
                    correlation_id = correlationId?.ToString("N"),
                    operation = operation.ToString(),
                    fatal,
                    app_build = _appBuild,
                    core_build = _coreBuild,
                    exception_type = type,
                    hresult = exception.HResult,
                    stack_methods = SafeFrames(exception)
                };
                var bytes = JsonSerializer.SerializeToUtf8Bytes(record);
                if (bytes.Length > MaxEventBytes || bytes.Length > _maxTotalBytes)
                    return FinishWrite(DiagnosticWriteStatus.Failed, null);

                using var rootLock = AcquireRootLock(root);
                var owned = OwnedFiles(root);
                var total = owned.Sum(file => file.Length);
                while (owned.Count >= _maxFiles || total + bytes.Length > _maxTotalBytes)
                {
                    if (owned.Count == 0) return FinishWrite(DiagnosticWriteStatus.Failed, null);
                    var oldest = owned[0];
                    // Recheck the exact direct child immediately before deleting it.
                    if (!IsOwnedFile(root, oldest.FullName)) return FinishWrite(DiagnosticWriteStatus.Failed, null);
                    File.Delete(oldest.FullName);
                    total -= oldest.Length;
                    owned.RemoveAt(0);
                }

                temporary = Path.Combine(root, "diag-" + eventId + ".tmp");
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                    FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    temporaryCreated = true;
                    stream.Write(bytes);
                    stream.Flush(flushToDisk: true);
                }
                File.Move(temporary, path);
                temporary = null;
                _latest = new(timestamp, eventId, operation, fatal, type, path);
                return FinishWrite(DiagnosticWriteStatus.Written, _latest);
            }
            catch
            {
                // Diagnostics are subordinate to the caller's original failure path.
                return FinishWrite(DiagnosticWriteStatus.Failed, null);
            }
            finally
            {
                if (temporaryCreated && temporary is not null)
                {
                    try { File.Delete(temporary); } catch { /* Exact temporary file only. */ }
                }
            }
        }
    }

    private DiagnosticWriteResult FinishWrite(DiagnosticWriteStatus status, DiagnosticSummary? summary)
    {
        lock (Gate) _lastWriteStatus = status;
        return new(status, summary);
    }

    private string CheckedRoot(bool create)
    {
        var root = Path.GetFullPath(_root);
        if (create) Directory.CreateDirectory(root);
        var attributes = File.GetAttributes(root);
        if ((attributes & FileAttributes.ReparsePoint) != 0 || (attributes & FileAttributes.Directory) == 0)
            throw new IOException("Diagnostic root is not a direct local directory.");
        return root;
    }

    private static FileStream AcquireRootLock(string root)
    {
        // Keep this direct child across runs: deleting it could split concurrent lockers.
        var path = Path.Combine(root, ".lodestar-diagnostic.lock");
        var wait = Stopwatch.StartNew();
        while (true)
        {
            FileStream stream;
            try
            {
                stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite,
                    FileShare.None);
            }
            catch (IOException) when (wait.ElapsedMilliseconds < MaxLockWaitMilliseconds)
            {
                Thread.Sleep(25);
                continue;
            }

            try
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Diagnostic lock is a reparse point.");
                return stream;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
    }

    private DiagnosticLogStatus ReadStatus()
    {
        string root;
        try
        {
            root = CheckedRoot(create: false);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { return new(DiagnosticAvailability.Empty, null, _lastWriteStatus); }
        catch { return new(DiagnosticAvailability.Unavailable, _latest, _lastWriteStatus); }

        try
        {
            // Read availability must observe inspection failures, even after a successful write/read.
            // Retention separately keeps the fail-closed ownership wrapper below.
            var latestPath = Directory.EnumerateFiles(root, "diag-*.json", SearchOption.TopDirectoryOnly)
                .Where(path => InspectOwnership(root, path))
                .OrderBy(path => Path.GetFileName(path), StringComparer.Ordinal)
                .LastOrDefault();
            var summary = latestPath is null ? null : ReadSummary(latestPath);
            if (latestPath is not null && summary is null)
                return new(DiagnosticAvailability.Unavailable, _latest, _lastWriteStatus);
            _latest = summary;
            return new(summary is null ? DiagnosticAvailability.Empty : DiagnosticAvailability.Available,
                summary, _lastWriteStatus);
        }
        catch { return new(DiagnosticAvailability.Unavailable, _latest, _lastWriteStatus); }
    }

    private static List<FileInfo> OwnedFiles(string root) =>
        Directory.EnumerateFiles(root, "diag-*.json", SearchOption.TopDirectoryOnly)
            .Where(path => IsOwnedFile(root, path))
            .Select(path => new FileInfo(path))
            .OrderBy(file => file.Name, StringComparer.Ordinal)
            .ToList();

    private static bool IsOwnedFile(string root, string path)
    {
        try { return InspectOwnership(root, path); }
        catch { return false; }
    }

    private static bool InspectOwnership(string root, string path)
    {
        var full = Path.GetFullPath(path);
        if (!string.Equals(Path.GetDirectoryName(full), root, StringComparison.OrdinalIgnoreCase)) return false;
        var name = Path.GetFileName(full);
        if (name.Length != 62 || !name.StartsWith("diag-", StringComparison.Ordinal) ||
            !name.EndsWith(".json", StringComparison.Ordinal)) return false;
        var id = name.Substring(25, 32);
        if (!Guid.TryParseExact(id, "N", out _) || name[24] != '-') return false;
        if (!DateTime.TryParseExact(name.Substring(5, 19), "yyyyMMddTHHmmssfffZ",
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _)) return false;
        // A shaped candidate needs a conclusive inspection before it can be treated as absent.
        // Never follow a candidate link; the retention wrapper catches these failures as unowned.
        if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Diagnostic candidate is a reparse point.");
        var file = new FileInfo(full);
        if (file.Length <= 0 || file.Length > MaxEventBytes)
            throw new InvalidDataException("Diagnostic candidate size is invalid.");
        using var document = JsonDocument.Parse(File.ReadAllBytes(full));
        var json = document.RootElement;
        if (json.ValueKind != JsonValueKind.Object ||
            !json.TryGetProperty("owner", out var owner) || owner.ValueKind != JsonValueKind.String ||
            string.IsNullOrEmpty(owner.GetString()))
            throw new InvalidDataException("Diagnostic candidate ownership is unresolved.");
        if (owner.GetString() != Owner) return false;
        if (!json.TryGetProperty("schema", out var schema) || schema.ValueKind != JsonValueKind.Number ||
            schema.GetInt32() != 1 || !json.TryGetProperty("event_id", out var eventId) ||
            eventId.ValueKind != JsonValueKind.String || eventId.GetString() != id)
            throw new InvalidDataException("Diagnostic candidate identity is invalid.");
        return true;
    }

    private static DiagnosticSummary? ReadSummary(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            var json = document.RootElement;
            var identity = json.GetProperty("exception_type").GetString();
            if (!DateTimeOffset.TryParse(json.GetProperty("at_utc").GetString(), out var at) ||
                !Enum.TryParse<DiagnosticOperation>(json.GetProperty("operation").GetString(), out var operation) ||
                !Enum.IsDefined(operation) || !IsSafeIdentity(identity, 128))
                return null;
            return new(at, json.GetProperty("event_id").GetString()!, operation,
                json.GetProperty("fatal").GetBoolean(), identity!, path);
        }
        catch { return null; }
    }

    private static string? SafeBuild(string? candidate)
    {
        if (candidate is null || candidate.Length is < 1 or > 64) return null;
        if (candidate.Length == 64 && candidate.All(Uri.IsHexDigit)) return candidate.ToLowerInvariant();
        if (candidate.All(c => c is >= '0' and <= '9' or '.') &&
            Version.TryParse(candidate, out _)) return candidate;
        return null;
    }

    private static string SafeType(Type type)
    {
        var identity = type.FullName;
        return IsSafeIdentity(identity, 128) ? identity! : "Exception";
    }

    private static string[] SafeFrames(Exception exception)
    {
        try
        {
            return (new StackTrace(exception, false).GetFrames() ?? [])
                .Select(frame => frame.GetMethod())
                .Where(method => method?.DeclaringType?.Namespace is { } ns &&
                    (ns == "Lodestar.Loader" || ns.StartsWith("Lodestar.Loader.", StringComparison.Ordinal)))
                .Select(method => method!.DeclaringType!.FullName + "." + method.Name)
                .Where(identity => IsSafeIdentity(identity, 160))
                .Take(6).ToArray()!;
        }
        catch { return []; }
    }

    private static bool IsSafeIdentity(string? value, int limit) =>
        value is { Length: > 0 } && value.Length <= limit &&
        value.All(c => c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '.' or '_' or '+' or '`' or '<' or '>');
}
