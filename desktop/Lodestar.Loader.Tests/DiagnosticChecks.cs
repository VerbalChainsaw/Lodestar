using System.Text.Json;

namespace Lodestar.Loader;

public static class DiagnosticChecks
{
    public static Task AvailabilityAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-fq02-diagnostics-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var blocked = Path.Combine(root, "blocked"); File.WriteAllText(blocked, "sentinel");
            var logger = new DiagnosticLog(blocked);
            var original = new InvalidOperationException("PRIMARY_FAKE_SECRET");
            Check(logger.RecordFailure(DiagnosticOperation.Save, original, false).Status == DiagnosticWriteStatus.Failed,
                "Actual blocked diagnostic root did not reject the write.");
            Check(logger.Latest is null && File.ReadAllText(blocked) == "sentinel", "Blocked read changed evidence.");
            var statusProperty = typeof(DiagnosticLog).GetProperty("Status");
            string? Field(DiagnosticLog log, string name) => statusProperty?.GetValue(log)?.GetType().GetProperty(name)?.GetValue(statusProperty.GetValue(log))?.ToString();
            Check(Field(logger, "Availability") == "Unavailable" && Field(logger, "LastWriteStatus") == "Failed" &&
                Field(logger, "Notice")?.Contains("Inspect", StringComparison.Ordinal) == true,
                "Actual blocked root lacks a persistent unavailable/actionable diagnostic observer.");
            var reader = new DiagnosticLog(blocked); _ = reader.Latest;
            Check(Field(reader, "Availability") == "Unavailable" && Field(reader, "Notice") is not null,
                "Actual failed latest read was labeled as no event.");
            var empty = Path.Combine(root, "empty"); Directory.CreateDirectory(empty);
            var emptyLog = new DiagnosticLog(empty); _ = emptyLog.Latest;
            Check(Field(emptyLog, "Availability") == "Empty" && Field(emptyLog, "Notice") is null,
                "True empty directory was mislabeled unavailable.");
            Check(logger.RecordFailure(DiagnosticOperation.Save, new OperationCanceledException(), false).Status == DiagnosticWriteStatus.SkippedCancellation &&
                Field(logger, "LastWriteStatus") == "Failed", "Cancellation concealed a prior diagnostic failure.");
            File.Delete(blocked); Directory.CreateDirectory(blocked);
            Check(Field(logger, "Notice") is not null, "A readable empty root erased the failed-write fact before successful retry.");
            var written = logger.RecordFailure(DiagnosticOperation.Save, original, false);
            Check(written.Status == DiagnosticWriteStatus.Written && Field(logger, "Availability") == "Available" &&
                Field(logger, "LastWriteStatus") == "Written" && Field(logger, "Notice") is null,
                "Successful actual write did not recover diagnostic availability.");
            Check(!File.ReadAllText(written.Path!).Contains("PRIMARY_FAKE_SECRET", StringComparison.Ordinal),
                "Logger persisted primary exception text.");
            ReadInspectionStates(root);
            return Task.CompletedTask;
        }
        finally { Directory.Delete(root, true); }
    }

    private static void ReadInspectionStates(string root)
    {
        var failures = new List<string>();
        void Observe(bool condition, string message)
        {
            if (!condition) failures.Add(message);
        }
        const string firstName = "diag-20260930T120000000Z-0123456789abcdef0123456789abcdef.json";
        const string laterName = "diag-20260930T120001000Z-fedcba9876543210fedcba9876543210.json";
        const string firstBytes = "{\"schema\":1,\"owner\":\"Lodestar.Loader.DiagnosticLog\",\"event_id\":\"0123456789abcdef0123456789abcdef\",\"at_utc\":\"2026-09-30T12:00:00Z\",\"operation\":\"Save\",\"fatal\":false,\"exception_type\":\"System.InvalidOperationException\"}";
        const string laterBytes = "{\"schema\":1,\"owner\":\"Lodestar.Loader.DiagnosticLog\",\"event_id\":\"fedcba9876543210fedcba9876543210\",\"at_utc\":\"2026-09-30T12:00:01Z\",\"operation\":\"Save\",\"fatal\":false,\"exception_type\":\"System.InvalidOperationException\"}";

        var malformedRoot = Path.Combine(root, "malformed-summary");
        Directory.CreateDirectory(malformedRoot);
        var malformedPath = Path.Combine(malformedRoot, firstName);
        var malformedBytes = firstBytes.Replace("2026-09-30T12:00:00Z", "invalid-time", StringComparison.Ordinal);
        File.WriteAllText(malformedPath, malformedBytes);
        var malformed = new DiagnosticLog(malformedRoot).Status;
        Observe(malformed.Availability == DiagnosticAvailability.Unavailable && malformed.Summary is null &&
            malformed.Notice?.Contains("Inspect", StringComparison.Ordinal) == true,
            "Present schema-owned event with malformed summary was labeled empty.");
        Observe(File.ReadAllText(malformedPath) == malformedBytes,
            "Status inspection changed malformed owned bytes.");

        var lockedRoot = Path.Combine(root, "denied-read");
        Directory.CreateDirectory(lockedRoot);
        var lockedPath = Path.Combine(lockedRoot, firstName);
        File.WriteAllText(lockedPath, firstBytes);
        var lockedLog = new DiagnosticLog(lockedRoot);
        using (var exclusive = new FileStream(lockedPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var denied = false;
            try { _ = File.ReadAllBytes(lockedPath); }
            catch (IOException) { denied = true; }
            Check(denied, "Exclusive fixture did not actually deny a diagnostic read.");
            var status = lockedLog.Status;
            Observe(status.Availability == DiagnosticAvailability.Unavailable && status.Notice is not null,
                "Actually unreadable diagnostic candidate was labeled empty.");
        }
        Observe(lockedLog.Status.Availability == DiagnosticAvailability.Available &&
            lockedLog.Status.Summary?.Path == lockedPath && File.ReadAllText(lockedPath) == firstBytes,
            "Readable diagnostic did not recover after releasing the exclusive fixture.");

        var cachedRoot = Path.Combine(root, "cached-latest");
        Directory.CreateDirectory(cachedRoot);
        var firstPath = Path.Combine(cachedRoot, firstName);
        var laterPath = Path.Combine(cachedRoot, laterName);
        File.WriteAllText(firstPath, firstBytes);
        var cachedLog = new DiagnosticLog(cachedRoot);
        Check(cachedLog.Status.Availability == DiagnosticAvailability.Available &&
            cachedLog.Status.Summary?.Path == firstPath, "Independent good event did not populate summary.");
        File.WriteAllText(laterPath, laterBytes);
        using (var exclusive = new FileStream(laterPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            var status = cachedLog.Status;
            Observe(status.Availability == DiagnosticAvailability.Unavailable && status.Notice is not null &&
                status.Summary?.Path == firstPath, "Cached summary hid a newly unreadable latest candidate.");
        }
        Observe(cachedLog.Status.Availability == DiagnosticAvailability.Available &&
            cachedLog.Status.Summary?.Path == laterPath && File.ReadAllText(laterPath) == laterBytes,
            "Recovered inspection did not select the actual latest independent event.");

        var foreignRoot = Path.Combine(root, "foreign-only");
        Directory.CreateDirectory(foreignRoot);
        var foreignPath = Path.Combine(foreignRoot, firstName);
        var foreignBytes = firstBytes.Replace("Lodestar.Loader.DiagnosticLog", "Foreign.Owner", StringComparison.Ordinal);
        File.WriteAllText(foreignPath, foreignBytes);
        var foreign = new DiagnosticLog(foreignRoot).Status;
        Observe(foreign.Availability == DiagnosticAvailability.Empty && foreign.Notice is null &&
            File.ReadAllText(foreignPath) == foreignBytes, "Readable foreign bytes changed availability or were modified.");

        var unresolvedFixtures = new (string Label, string Bytes)[]
        {
            ("zero", ""),
            ("oversized", firstBytes + new string(' ', 8193)),
            ("unsupported-schema", firstBytes.Replace("\"schema\":1", "\"schema\":2", StringComparison.Ordinal)),
            ("missing-owner", firstBytes.Replace("\"owner\":\"Lodestar.Loader.DiagnosticLog\",", "", StringComparison.Ordinal)),
            ("missing-id", firstBytes.Replace("\"event_id\":\"0123456789abcdef0123456789abcdef\",", "", StringComparison.Ordinal)),
            ("mismatched-id", firstBytes.Replace("0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210", StringComparison.Ordinal)),
            ("invalid-json", "{")
        };
        foreach (var fixture in unresolvedFixtures)
        {
            var folder = Path.Combine(root, "unresolved-" + fixture.Label);
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, firstName);
            File.WriteAllText(path, fixture.Bytes);
            var status = new DiagnosticLog(folder).Status;
            Observe(status.Availability == DiagnosticAvailability.Unavailable && status.Summary is null &&
                status.Notice?.Contains("Inspect", StringComparison.Ordinal) == true,
                "Unresolved shaped " + fixture.Label + " event was labeled empty.");
            Observe(File.ReadAllText(path) == fixture.Bytes, "Status changed unresolved " + fixture.Label + " bytes.");
            var writer = new DiagnosticLog(folder, maxFiles: 1, maxTotalBytes: 4096);
            for (var index = 0; index < 2; index++)
                Check(writer.RecordFailure(DiagnosticOperation.Save, new InvalidOperationException(), false).Status ==
                    DiagnosticWriteStatus.Written, "Unresolved ownership prevented bounded valid event retention.");
            Observe(File.ReadAllText(path) == fixture.Bytes,
                "Retention modified or deleted unresolved " + fixture.Label + " bytes.");
        }
        foreach (var fixture in unresolvedFixtures.Take(2))
        {
            var folder = Path.Combine(root, "cached-size-" + fixture.Label);
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, firstName);
            File.WriteAllText(path, firstBytes);
            var logger = new DiagnosticLog(folder);
            var good = logger.Status.Summary;
            Check(good?.Path == path, "Known-size-change fixture did not cache independent good bytes.");
            File.WriteAllText(path, fixture.Bytes);
            var status = logger.Status;
            Observe(status.Availability == DiagnosticAvailability.Unavailable && status.Summary == good &&
                status.Notice is not null, "Known event resized to " + fixture.Label + " concealed uncertainty.");
            Observe(File.ReadAllText(path) == fixture.Bytes, "Status changed resized " + fixture.Label + " bytes.");
            File.WriteAllText(path, firstBytes);
            Observe(logger.Status.Availability == DiagnosticAvailability.Available && logger.Status.Notice is null,
                "Known event did not recover after restoring valid bytes.");
        }
        var unsupportedPath = Path.Combine(foreignRoot, "diag-unsupported.json");
        File.WriteAllText(unsupportedPath, "unverified sentinel");
        Observe(new DiagnosticLog(foreignRoot).Status.Availability == DiagnosticAvailability.Empty &&
            File.ReadAllText(unsupportedPath) == "unverified sentinel" && File.ReadAllText(foreignPath) == foreignBytes,
            "Unsupported name or confirmed foreign owner changed empty status or preserved bytes.");
        Check(failures.Count == 0, string.Join(Environment.NewLine, failures));
    }

    public static Task RunAsync()
    {
        var temporary = Path.GetFullPath(Path.GetTempPath());
        var root = Path.Combine(temporary, "lodestar-diagnostic-check-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            RedactsSensitiveException(root);
            BoundsNestedException(root);
            RetainsOnlyOwnedFiles(root);
            HandlesConcurrentCalls(root);
            DoesNotMaskOriginalFailure(root);
            AssertNoSecretsAcrossFiles(root);
            return Task.CompletedTask;
        }
        finally
        {
            // The only recursive cleanup in these checks is the exact generated fixture.
            if (root.StartsWith(temporary.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase)) Directory.Delete(root, recursive: true);
        }
    }

    private static void RedactsSensitiveException(string root)
    {
        var folder = Path.Combine(root, "redaction");
        var token = "FAKE_SECRET_TOKEN_8f7bc53a";
        var path = @"C:\private\case\payload.json";
        var database = @"C:\private\store\lodestar.sqlite";
        var arguments = "--args-file C:/private/cli-arguments.json";
        var json = "{\"record\":\"private-payload\"}";
        var app = "2.4.1.0";
        var core = new string('a', 64);
        var logger = new DiagnosticLog(folder, app, core);
        Exception failure;
        try { ThrowSensitive(token + path + database + arguments + json); throw new Exception("unreachable"); }
        catch (InvalidOperationException error) { failure = error; }
        failure.Data["credential"] = token;
        failure.Data[path] = json;
        var written = logger.RecordFailure(DiagnosticOperation.LibraryLoad, failure, fatal: false,
            correlationId: Guid.Parse("01234567-89ab-cdef-0123-456789abcdef"));
        Check(written.Status == DiagnosticWriteStatus.Written && written.Path is not null,
            "Sensitive fixture was not logged.");
        Check(written.Summary?.Operation == DiagnosticOperation.LibraryLoad &&
            written.Summary.ExceptionType == typeof(InvalidOperationException).FullName &&
            written.Summary.Fatal == false, "Safe summary lost operation or exception identity.");
        var files = Directory.GetFiles(folder, "diag-*.json");
        Check(files.Length == 1, "Expected one redacted diagnostic file.");
        var text = File.ReadAllText(files[0]);
        foreach (var secret in new[] { token, path, database, arguments, json, "private-payload", "credential",
            "INNER_FAKE_SECRET" })
            Check(!text.Contains(secret, StringComparison.Ordinal), "Sensitive exception content leaked.");
        using var document = JsonDocument.Parse(text);
        var entry = document.RootElement;
        Check(entry.GetProperty("operation").GetString() == "LibraryLoad" &&
            entry.GetProperty("app_build").GetString() == app &&
            entry.GetProperty("core_build").GetString() == core &&
            entry.GetProperty("exception_type").GetString() == typeof(InvalidOperationException).FullName &&
            entry.GetProperty("hresult").ValueKind == JsonValueKind.Number &&
            entry.GetProperty("stack_methods").GetArrayLength() is > 0 and <= 6,
            "Allowlisted identity or bounded stack methods missing.");
        Check(logger.Latest?.Path == files[0] && new DiagnosticLog(folder).Latest?.Path == files[0],
            "Latest diagnostic summary is unavailable after reopening the log root.");
        var invalidBuild = new DiagnosticLog(Path.Combine(root, "invalid-build"),
            appBuild: token, coreBuild: path);
        var invalid = invalidBuild.RecordFailure(DiagnosticOperation.Startup, failure, fatal: true);
        Check(invalid.Status == DiagnosticWriteStatus.Written, "Invalid-build fixture did not write.");
        var invalidText = File.ReadAllText(invalid.Path!);
        Check(!invalidText.Contains(token, StringComparison.Ordinal) &&
            !invalidText.Contains(path, StringComparison.Ordinal), "Unvalidated build identity leaked.");
        var overridden = logger.RecordFailure(DiagnosticOperation.Save,
            new SensitiveException("MESSAGE_FAKE_SECRET"), fatal: false);
        Check(overridden.Status == DiagnosticWriteStatus.Written &&
            !File.ReadAllText(overridden.Path!).Contains("TOSTRING_FAKE_SECRET", StringComparison.Ordinal) &&
            !File.ReadAllText(overridden.Path!).Contains("MESSAGE_FAKE_SECRET", StringComparison.Ordinal),
            "Custom exception text leaked.");
    }

    private static void ThrowSensitive(string message)
    {
        throw new InvalidOperationException(message,
            new ApplicationException("INNER_FAKE_SECRET_3d1e"));
    }

    private sealed class SensitiveException(string message) : Exception(message)
    {
        public override string ToString() => "TOSTRING_FAKE_SECRET";
    }

    private static void BoundsNestedException(string root)
    {
        var folder = Path.Combine(root, "nested");
        Exception error = new InvalidOperationException("DEEPEST_FAKE_SECRET");
        for (var index = 0; index < 300; index++)
            error = new ApplicationException("NESTED_FAKE_SECRET_" + index + new string('X', 1000), error);
        var logger = new DiagnosticLog(folder);
        var result = logger.RecordFailure(DiagnosticOperation.RecordRead, error, fatal: true);
        Check(result.Status == DiagnosticWriteStatus.Written, "Large exception was not logged.");
        var file = new FileInfo(result.Path!);
        Check(file.Length <= 8192 && !File.ReadAllText(file.FullName).Contains("FAKE_SECRET",
            StringComparison.Ordinal), "Nested exception output was unbounded or contained message text.");
    }

    private static void RetainsOnlyOwnedFiles(string root)
    {
        var folder = Path.Combine(root, "retention");
        Directory.CreateDirectory(folder);
        var sentinel = Path.Combine(folder, "keep-me.json");
        File.WriteAllText(sentinel, "unrelated sentinel");
        var lookalike = Path.Combine(folder, "diag-20260928T120000000Z-0123456789abcdef0123456789abcdef.json");
        File.WriteAllText(lookalike, "not owned");
        var logger = new DiagnosticLog(folder, maxFiles: 3, maxTotalBytes: 4096);
        for (var index = 0; index < 8; index++)
            Check(logger.RecordFailure(DiagnosticOperation.GenericRead,
                new InvalidOperationException("SECRET_" + index), fatal: false).Status ==
                DiagnosticWriteStatus.Written, "Retention fixture write failed.");
        var owned = Directory.GetFiles(folder, "diag-*.json")
            .Where(file => file != lookalike).ToArray();
        Check(owned.Length == 3, "Owned diagnostic file count did not retain exactly three.");
        Check(owned.Sum(file => new FileInfo(file).Length) <= 4096,
            "Owned diagnostic byte budget was exceeded.");
        Check(File.ReadAllText(sentinel) == "unrelated sentinel" &&
            File.ReadAllText(lookalike) == "not owned", "Retention deleted an unrelated file.");
    }

    private static void HandlesConcurrentCalls(string root)
    {
        var folder = Path.Combine(root, "concurrent");
        var logger = new DiagnosticLog(folder, maxFiles: 64, maxTotalBytes: 262144);
        var writes = Enumerable.Range(0, 40).Select(index => Task.Run(() =>
            logger.RecordFailure(DiagnosticOperation.ProjectLoad,
                new InvalidOperationException("SECRET_CONCURRENT_" + index), fatal: false))).ToArray();
        Task.WaitAll(writes);
        Check(writes.All(task => task.Result.Status == DiagnosticWriteStatus.Written),
            "Concurrent diagnostic write failed.");
        var files = Directory.GetFiles(folder, "diag-*.json");
        Check(files.Length == 40 && files.Select(Path.GetFileName).Distinct().Count() == 40,
            "Concurrent events were lost or overwritten.");
        foreach (var file in files)
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(file));
            Check(document.RootElement.GetProperty("operation").GetString() == "ProjectLoad" &&
                !File.ReadAllText(file).Contains("SECRET_CONCURRENT", StringComparison.Ordinal),
                "Concurrent event is malformed or contains message text.");
        }
    }

    private static void DoesNotMaskOriginalFailure(string root)
    {
        var blockedRoot = Path.Combine(root, "file-instead-of-directory");
        File.WriteAllText(blockedRoot, "sentinel");
        var logger = new DiagnosticLog(blockedRoot);
        var original = new InvalidOperationException("ORIGINAL_FAKE_SECRET");
        Exception? caught = null;
        try
        {
            try { throw original; }
            catch (Exception error)
            {
                Check(logger.RecordFailure(DiagnosticOperation.AppUnhandled, error, fatal: true).Status ==
                    DiagnosticWriteStatus.Failed, "Unwritable root did not report failure.");
                throw;
            }
        }
        catch (Exception error) { caught = error; }
        Check(ReferenceEquals(caught, original) && File.ReadAllText(blockedRoot) == "sentinel",
            "Diagnostic failure masked the original exception or modified the sentinel.");
        var cancellationRoot = Path.Combine(root, "cancellation");
        var canceled = new DiagnosticLog(cancellationRoot).RecordFailure(DiagnosticOperation.Startup,
            new OperationCanceledException("SECRET_CANCEL"), fatal: true);
        Check(canceled.Status == DiagnosticWriteStatus.SkippedCancellation &&
            !Directory.Exists(cancellationRoot), "Cancellation was persisted as a crash.");
    }

    private static void AssertNoSecretsAcrossFiles(string root)
    {
        foreach (var file in Directory.EnumerateFiles(root, "*.json", SearchOption.AllDirectories))
        {
            var text = File.ReadAllText(file);
            foreach (var marker in new[] { "FAKE_SECRET", "SECRET_CONCURRENT", "SECRET_0",
                "private-payload", @"C:\private\", "--args-file" })
                Check(!text.Contains(marker, StringComparison.Ordinal),
                    "A sensitive fixture marker appeared in a diagnostic file.");
        }
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
