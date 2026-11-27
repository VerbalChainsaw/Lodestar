using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Lodestar.Loader;

internal static class AdversarialLoaderChecks
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static string Node() => TestNodeRuntime.Resolve();

    public static async Task PendingPreflightRetainsPriorOutcome()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-preflight-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var cli = Path.Combine(root, "lodestar.mjs"); File.WriteAllText(cli, "export {};");
            var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
            var config = Path.Combine(root, "interfaces.json");
            File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1,
                generation = Guid.NewGuid().ToString("D"),
                runtime = new { node = Node(), cli, database = db }, loader = "Lodestar.Loader.exe" }));
            var runtime = await RuntimeConfig.LoadAsync(config);
            var pending = Path.Combine(root, "pending");
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var journal = Path.Combine(pending, requestId);
            Directory.CreateDirectory(journal);
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:x", set = new { name = "Changed" },
                    remove = Array.Empty<string>() } });
            var requestFile = Path.Combine(journal, "request.json");
            File.WriteAllBytes(requestFile, body);
            File.WriteAllText(Path.Combine(journal, "context.json"), JsonSerializer.Serialize(new {
                request_id = requestId, record_id = "fact:x", config = runtime.ConfigPath,
                generation = runtime.Generation, fingerprint = runtime.Fingerprint,
                database = runtime.DatabasePath, database_instance_id = "a", database_epoch = "b",
                operation = "put", request_sha256 = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant()
            }));
            var frozen = new FrozenMutation(requestId, "fact:x", runtime, "a", "b", body, journal);
            var calls = 0;
            Task<CliResult> Unsent(CliInvocation _, CancellationToken __)
            {
                calls++;
                throw new Exception("Preflight dispatched a child.");
            }
            await using (var drifted = new LodestarService(runtime with { Generation = "changed" }, Unsent, pending))
            {
                var result = await drifted.SaveAsync(frozen);
                Check(!result.Saved && result.MayHaveCommitted && result.RequiresRecovery &&
                    result.Error?.Contains("Pending saves", StringComparison.OrdinalIgnoreCase) == true,
                    "Existing pending request was classified as an ordinary unsent failure on selection drift.");
            }
            File.WriteAllText(config, "{");
            await using (var brokenConfig = new LodestarService(runtime, Unsent, pending))
            {
                var result = await brokenConfig.SaveAsync(frozen);
                Check(!result.Saved && result.MayHaveCommitted && result.RequiresRecovery &&
                    result.Error?.Contains("Pending saves", StringComparison.OrdinalIgnoreCase) == true,
                    "Existing pending request lost unknown-outcome state on config read failure.");
            }
            Check(calls == 0 && File.ReadAllBytes(requestFile).AsSpan().SequenceEqual(body),
                "Preflight changed or dispatched the saved exact request.");
            var fresh = frozen with { RequestId = "ll-" + Guid.NewGuid().ToString("D") };
            fresh = fresh with { JournalDirectory = Path.Combine(pending, fresh.RequestId) };
            await using (var freshService = new LodestarService(runtime, Unsent, pending))
            {
                var result = await freshService.SaveAsync(fresh);
                Check(!result.Saved && !result.MayHaveCommitted && !result.RequiresRecovery && calls == 0,
                    "Fresh preflight failure was classified as a prior unknown write.");
            }
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    public static async Task JournalRootFaultRetainsRecoveryList()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-root-error-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var pending = Path.Combine(root, "pending"); Directory.CreateDirectory(pending);
            var runtime = new RuntimeSelection("config", "generation", "node", "cli", "db", "fingerprint");
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var journal = Path.Combine(pending, requestId); Directory.CreateDirectory(journal);
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:x", set = new { name = "Changed" },
                    remove = Array.Empty<string>() } });
            File.WriteAllBytes(Path.Combine(journal, "request.json"), body);
            File.WriteAllText(Path.Combine(journal, "context.json"), JsonSerializer.Serialize(new {
                request_id = requestId, record_id = "fact:x", config = runtime.ConfigPath,
                generation = runtime.Generation, fingerprint = runtime.Fingerprint,
                database = runtime.DatabasePath, database_instance_id = "a", database_epoch = "b",
                operation = "put", request_sha256 = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant()
            }));
            await using var service = new LodestarService(runtime, (_, _) =>
                throw new Exception("Listing dispatched a child."), pending);
            var method = typeof(LodestarService).GetMethod("ReadPendingSaves",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            Check(method is not null, "Missing recoverable journal-root listing boundary.");
            var prior = method!.Invoke(service, [null]);
            var priorItems = prior?.GetType().GetProperty("Items")?.GetValue(prior) as IReadOnlyList<PendingSave>;
            Check(priorItems?.Count == 1 && priorItems[0].RequestId == requestId,
                "Valid prior journal was not listed before the injected root failure.");
            var throwingEnumerator = new Func<string, IEnumerable<string>>(_ =>
                throw new IOException("PRIVATE_BODY_MARKER"));
            var listing = method!.Invoke(service, [throwingEnumerator]);
            Check(listing is not null, "Journal-root error returned no listing.");
            var type = listing!.GetType();
            var error = type.GetProperty("Error")?.GetValue(listing) as string;
            var category = type.GetProperty("Category")?.GetValue(listing) as string;
            var location = type.GetProperty("JournalRoot")?.GetValue(listing) as string;
            var retained = type.GetProperty("Items")?.GetValue(listing) as IReadOnlyList<PendingSave>;
            Check(!string.IsNullOrWhiteSpace(error) && error.Contains("Pending saves") &&
                error.Contains("retry", StringComparison.OrdinalIgnoreCase) &&
                !error.Contains("PRIVATE_BODY_MARKER") && category == "journal_read_failed" &&
                location == pending && retained?.Single().RequestId == requestId,
                "Journal-root fault lost the prior list, exposed a secret, or lacked an action.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    public static async Task ConfirmedSaveRefreshFailureIsStale()
    {
        var assembly = typeof(SaveResult).Assembly;
        var outcome = assembly.GetType("Lodestar.Loader.RefreshOutcome");
        var presentation = assembly.GetType("Lodestar.Loader.SavedRefreshStatus");
        Check(outcome is not null && presentation is not null,
            "Confirmed-save refresh has no shared explicit outcome/presentation contract.");
        var describe = presentation!.GetMethod("Describe", BindingFlags.Public | BindingFlags.Static);
        Check(describe is not null, "Both editor paths need a shared post-save refresh message.");
        var frozen = new FrozenMutation("ll-" + Guid.NewGuid().ToString("D"), "fact:x",
            new RuntimeSelection("c", "g", "n", "m", "d", "f"), "a", "b", [], "pending");
        var staleAt = DateTimeOffset.Parse("2026-09-01T00:00:00Z");
        foreach (var reason in new[] { "find failed", "partial records" })
        {
            var value = Activator.CreateInstance(outcome!, false, 17L, staleAt, reason);
            var message = describe!.Invoke(null, [frozen, value]) as string;
            Check(message is not null && message.Contains(frozen.RequestId) &&
                message.Contains("Saved") && message.Contains("stale", StringComparison.OrdinalIgnoreCase) &&
                message.Contains("Refresh") && message.Contains("17") &&
                message.Contains(reason), "Confirmed write lost its stale-read warning or retry action.");
        }
        var root = Path.Combine(Path.GetTempPath(), "ll-stale-after-save-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var cli = Path.Combine(root, "lodestar.mjs"); File.WriteAllText(cli, "export {};");
            var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
            var config = Path.Combine(root, "interfaces.json");
            File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1,
                generation = Guid.NewGuid().ToString("D"),
                runtime = new { node = Node(), cli, database = db }, loader = "Lodestar.Loader.exe" }));
            var runtime = await RuntimeConfig.LoadAsync(config);
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var journal = Path.Combine(root, "pending", requestId);
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:x", set = new { name = "Changed" },
                    remove = Array.Empty<string>() } });
            var reviewed = new FrozenMutation(requestId, "fact:x", runtime, "a", "b", body, journal);
            var readFails = false;
            var writes = 0;
            await using var service = new LodestarService(runtime, (invocation, _) =>
            {
                if (invocation.OperationId == "put")
                {
                    writes++;
                    return Task.FromResult(new CliResult(true,
                        JsonSerializer.SerializeToElement(NativeFinishChecks.MutationResponse(reviewed)),
                        null, "OK", 0, "", 1));
                }
                if (readFails) return Task.FromResult(new CliResult(false, null,
                    "fixture_read_failed", "find failed", 2, "", 1));
                return Task.FromResult(new CliResult(true,
                    JsonDocument.Parse("""{"v":5,"ok":true,"operation":"find","revision":5,"database_instance_id":"a","database_epoch":"b","data":{"records":[],"record_errors":[],"complete":true},"more":false,"next":[]}""").RootElement.Clone(),
                    null, "OK", 0, "", 1));
            }, Path.Combine(root, "pending"));
            var before = await service.LoadLibraryAsync();
            Check(before.Complete && before.Error is null, "Pre-save library fixture did not complete.");
            var saved = await service.SaveAsync(reviewed);
            Check(saved.Saved && writes == 1, "Disposable save was not confirmed exactly once.");
            readFails = true;
            var stale = await service.LoadLibraryAsync();
            Check(stale.Error?.Contains("find failed") == true &&
                stale.ReadAt == before.ReadAt && stale.Revision == before.Revision,
                "Failed post-save find did not retain the dated prior snapshot.");
            var refresh = Activator.CreateInstance(outcome!, false, stale.Revision, stale.ReadAt, stale.Error);
            var notice = describe!.Invoke(null, [reviewed, refresh]) as string;
            Check(notice is not null && notice.Contains(reviewed.RequestId) &&
                notice.Contains("Saved") && notice.Contains("stale", StringComparison.OrdinalIgnoreCase) &&
                notice.Contains("Refresh") && notice.Contains("find failed") && writes == 1,
                "Confirmed save was obscured by the failed read or retried the mutation.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    public static async Task TransportFailureKeepsSafeStageAndCorrelation()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-transport-error-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
            var cli = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs");
            var badNode = Path.Combine(root, "PRIVATE_BODY_MARKER.exe");
            File.WriteAllText(badNode, "invalid binary");
            var runtime = new RuntimeSelection("config", "g", badNode, cli, db, "f");
            var diagnostics = new DiagnosticLog(Path.Combine(root, "diagnostics"));
            var constructor = typeof(CliTransport).GetConstructor(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null,
                [typeof(DiagnosticLog), typeof(Func<Process, Task>)], null);
            Check(constructor is not null, "Transport has no disposable fault/diagnostic seam.");
            async Task<CliResult> Inspect(CliTransport transport, bool mutation, bool uncertain, string stage)
            {
                await using (transport)
                {
                    var result = await transport.ExecuteAsync(new("put", ["put"],
                        mutation ? runtime with { NodePath = Node() } : runtime,
                        TimeSpan.FromSeconds(3), mutation));
                    var type = typeof(CliResult);
                    var reportedStage = type.GetProperty("FailureStage")?.GetValue(result) as string;
                    var category = type.GetProperty("FailureCategory")?.GetValue(result) as string;
                    var action = type.GetProperty("Action")?.GetValue(result) as string;
                    var correlation = type.GetProperty("CorrelationId")?.GetValue(result) as string;
                    Check(!result.Success && result.MayHaveCommitted == uncertain &&
                        reportedStage == stage && !string.IsNullOrWhiteSpace(category) &&
                        !string.IsNullOrWhiteSpace(action) && !string.IsNullOrWhiteSpace(correlation) &&
                        !result.Message.Contains("PRIVATE_BODY_MARKER") &&
                        !result.Diagnostics.Contains("PRIVATE_BODY_MARKER"),
                        "Transport lost safe stage/category/action/correlation or write certainty.");
                    return result;
                }
            }
            var launch = await Inspect((CliTransport)constructor!.Invoke([diagnostics, null]), false, false, "launch");
            Func<Process, Task> failAfterStart = _ => throw new IOException("PRIVATE_BODY_MARKER");
            var response = await Inspect((CliTransport)constructor.Invoke([diagnostics, failAfterStart]), true, true, "response");
            Check(launch.FailureCategory is "access_denied" or "invalid_executable" &&
                response.FailureCategory == "response_io_failed" &&
                launch.CorrelationId != response.CorrelationId,
                "Launch and post-dispatch stream failures collapsed to one category or correlation: " +
                launch.FailureCategory + "/" + response.FailureCategory);
            var logs = Directory.GetFiles(Path.Combine(root, "diagnostics"), "diag-*.json");
            var correlations = logs.Select(file => JsonDocument.Parse(File.ReadAllText(file))
                .RootElement.GetProperty("correlation_id").GetString()).ToArray();
            Check(logs.Length >= 2 && correlations.Contains(launch.CorrelationId) &&
                correlations.Contains(response.CorrelationId) &&
                logs.All(file => !File.ReadAllText(file).Contains("PRIVATE_BODY_MARKER")),
                "Transport diagnostic correlation was missing or leaked exception text.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    public static async Task PostCommitDeliveryFailureRetainsExactRecovery()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-delivery-error-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var cli = Path.Combine(root, "lodestar.mjs"); File.WriteAllText(cli, "export {};");
            var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
            var config = Path.Combine(root, "interfaces.json");
            File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1,
                generation = Guid.NewGuid().ToString("D"),
                runtime = new { node = Node(), cli, database = db }, loader = "Lodestar.Loader.exe" }));
            var runtime = await RuntimeConfig.LoadAsync(config);
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var pending = Path.Combine(root, "pending");
            var journal = Path.Combine(pending, requestId);
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:x", set = new { name = "Changed" },
                    remove = Array.Empty<string>() } });
            var frozen = new FrozenMutation(requestId, "fact:x", runtime, "a", "b", body, journal);
            var putCalls = 0;
            var receipt = NativeFinishChecks.ReceiptId("a", "b", requestId);
            var errorEnvelope = JsonDocument.Parse(JsonSerializer.Serialize(new { v = 5, ok = false,
                operation = "put", revision = 6, database_instance_id = "a", database_epoch = "b",
                more = false, next = Array.Empty<object>(), request = new { id = requestId },
                error = new { code = "response_delivery_failed", message = "Committed write response could not be delivered.",
                    action = "Inspect the exact saved request and receipt.", identifiers = new {
                        request_id = requestId, committed_revision = 6, receipt_id = receipt,
                        receipt_read_args = new[] { "--db", db, "get", receipt },
                        database_instance_id = "a", database_epoch = "b" } } })).RootElement.Clone();
            await using var service = new LodestarService(runtime, (invocation, _) =>
            {
                if (invocation.OperationId == "find") return Task.FromResult(new CliResult(true,
                    JsonDocument.Parse("""{"v":5,"ok":true,"operation":"find","revision":5,"database_instance_id":"a","database_epoch":"b","data":{"records":[]},"more":false,"next":[]}""").RootElement.Clone(),
                    null, "OK", 0, "", 1));
                if (invocation.OperationId == "put")
                {
                    putCalls++;
                    return Task.FromResult(new CliResult(false, errorEnvelope, "response_delivery_failed",
                        "Committed write response could not be delivered.", 5, "", 1, true));
                }
                throw new Exception("Unexpected CLI call.");
            }, pending);
            var saved = await service.SaveAsync(frozen);
            Check(!saved.Saved && saved.MayHaveCommitted && saved.RequiresRecovery &&
                saved.Error?.Contains(receipt) == true && putCalls == 1 &&
                !File.Exists(Path.Combine(journal, "response.json")) &&
                File.ReadAllBytes(Path.Combine(journal, "request.json")).AsSpan().SequenceEqual(body) &&
                service.PendingSaves().Any(item => item.RequestId == requestId),
                "Reported commit was treated as a settled save or cleared exact pending recovery.");
            var pendingItem = service.PendingSaves().Single(item => item.RequestId == requestId);
            Check(pendingItem.GetType().GetProperty("CommitReported")?.GetValue(pendingItem) is true &&
                pendingItem.GetType().GetProperty("CommittedRevision")?.GetValue(pendingItem) is 6L &&
                pendingItem.ReplayEligible,
                "Pending saves relabeled a reported committed write as an ordinary unknown outcome.");
            File.Copy(Path.Combine(journal, "delivery-error.json"),
                Path.Combine(journal, "response.json"));
            File.Delete(Path.Combine(journal, "delivery-error.json"));
            Check(service.PendingSaves().Single(item => item.RequestId == requestId).CommitReported,
                "A previous response.json delivery error disappeared from Pending saves.");

            var otherId = "ll-" + Guid.NewGuid().ToString("D");
            var otherBody = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = otherId,
                input = new { mode = "update", id = "fact:x", set = new { name = "Second" },
                    remove = Array.Empty<string>() } });
            var other = frozen with { RequestId = otherId, ExactRequestUtf8 = otherBody,
                JournalDirectory = Path.Combine(pending, otherId) };
            var mismatched = await service.SaveAsync(other);
            Check(!mismatched.Saved && mismatched.MayHaveCommitted && mismatched.RequiresRecovery &&
                service.PendingSaves().Any(item => item.RequestId == otherId && !item.ReplayEligible),
                "Mismatched reported commit identity was accepted or erased from recovery.");

            await using var transport = new CliTransport();
            var fixtureRuntime = runtime with { CliPath = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs") };
            var previous = Environment.GetEnvironmentVariable("LODESTAR_FAKE_MODE");
            Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", "delivery-failed");
            CliResult parsed;
            try { parsed = await transport.ExecuteAsync(new("put", ["put"], fixtureRuntime,
                TimeSpan.FromSeconds(3), true)); }
            finally { Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", previous); }
            Check(!parsed.Success && parsed.Code == "response_delivery_failed" &&
                parsed.MayHaveCommitted && parsed.Message.Contains("receipt:fixture"),
                "Transport parsed a postcommit response-delivery error as an ordinary rejected write.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
