using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Lodestar.Loader;

internal static class NativeFinishChecks
{
    private static void Check(bool condition, string message)
    { if (!condition) throw new InvalidOperationException(message); }
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    private static CliResult Success(string operation, object data) => new(true,
        Json(new { v = 5, ok = true, operation, data, more = false, next = Array.Empty<string>() }),
        null, "OK", 0, "", 1);
    internal static string ReceiptId(string instance, string epoch, string requestId) =>
        "mutation-receipt:" + Convert.ToHexString(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new[] { instance, epoch, requestId }))).ToLowerInvariant();

    internal static JsonObject MutationResponse(FrozenMutation frozen, bool okay = true, bool replayed = false) =>
        JsonNode.Parse(JsonSerializer.Serialize(new { v = 5, ok = okay, operation = frozen.OperationId,
            revision = 6, database_instance_id = frozen.DatabaseInstanceId, database_epoch = frozen.DatabaseEpoch,
            request = okay ? (object)new { id = frozen.RequestId, replayed, committed_revision = 6 }
                : new { id = frozen.RequestId }, more = false, next = Array.Empty<string>(),
            receipt_id = okay ? ReceiptId(frozen.DatabaseInstanceId, frozen.DatabaseEpoch, frozen.RequestId) : null,
            data = okay ? new { id = frozen.RecordId, revision = 6, data = new { name = "Changed" } } : null,
            error = okay ? null : new { code = "revision_conflict", message = "A target changed.",
                identifiers = new { request_id = frozen.RequestId, database_instance_id = frozen.DatabaseInstanceId,
                    database_epoch = frozen.DatabaseEpoch } } }))!.AsObject();

    private static async Task WithRecoveryJournalAsync(Func<LodestarService, FrozenMutation,
        Func<int>, Task> run, Func<FrozenMutation, CliResult>? mutation = null,
        Action<SaveResult>? inspectPrime = null)
    {
        await WithConfigAsync(async (root, config) => {
            File.WriteAllText(config, JsonSerializer.Serialize(Config(Guid.NewGuid().ToString("D"))));
            var runtime = await RuntimeConfig.LoadAsync(config);
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                write_basis = new { database_instance_id = "a", database_epoch = "b", targets = Array.Empty<object>() },
                input = new { mode = "update", id = "fact:x", set = new { name = "Changed" }, remove = Array.Empty<string>() } });
            var frozen = new FrozenMutation(requestId, "fact:x", runtime, "a", "b", bytes,
                Path.Combine(root, "pending", requestId));
            var calls = 0;
            await using var service = new LodestarService(runtime, (call, _) => {
                if (call.OperationId == "find") return Task.FromResult(new CliResult(true,
                    Json(new { v = 5, ok = true, operation = "find", revision = 5,
                        database_instance_id = "a", database_epoch = "b", data = new { records = Array.Empty<object>() },
                        more = false, next = Array.Empty<string>() }), null, "OK", 0, "", 1));
                calls++;
                return Task.FromResult(mutation?.Invoke(frozen) ?? new CliResult(false, null,
                    "fixture_unknown", "Fixture response was lost.", null, "", 1, true));
            }, Path.Combine(root, "pending"));
            var prime = await service.SaveAsync(frozen);
            Check(!prime.Saved && prime.RequiresRecovery && prime.MayHaveCommitted && calls == 1,
                "Unknown response did not establish an exact pending journal.");
            inspectPrime?.Invoke(prime);
            await run(service, frozen, () => calls);
        });
    }

    public static async Task CancelledUncertaintyPublicationAsync()
    {
        await WithRecoveryJournalAsync(async (_, frozen, _) => {
            var path = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
            File.Delete(path);
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            var retain = typeof(LodestarService).GetMethod("RetainFirstUncertaintyAsync",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            var task = (Task)retain.Invoke(null, [frozen,
                new CliResult(false, null, "fixture_unknown", "Unresolved dispatch.", null, "", 1, true),
                cancelled.Token, null])!;
            try { await task; throw new InvalidOperationException("Cancelled retention completed successfully."); }
            catch (OperationCanceledException) { }
            Check(!File.Exists(path), "Cancelled uncertainty write published an empty/partial final evidence file.");
            Check(!Directory.GetFiles(frozen.JournalDirectory, "response.uncertainty.json.*.tmp").Any(),
                "Cancelled uncertainty staging left owned temporary evidence behind.");
            Check(File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                "Cancelled evidence retention changed the original request.");
        });
    }

    public static async Task InterruptedUncertaintyRecoveryAsync()
    {
        foreach (var damaged in new[] { "", "{", "{\"operation\":" })
        {
            var dispatched = 0;
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var first = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
                var bytes = Encoding.UTF8.GetBytes(damaged);
                File.WriteAllBytes(first, bytes);
                var pending = service.PendingSaves().Single();
                Check(pending.ReplayEligible && pending.Issue?.Contains("preserved", StringComparison.OrdinalIgnoreCase) == true &&
                    pending.Issue.Contains("unknown", StringComparison.OrdinalIgnoreCase),
                    "Interrupted uncertainty bytes disabled exact unknown-request recovery or lost its warning: " + pending.Issue);
                var rejected = await service.RecoverAsync(frozen.RequestId);
                Check(!rejected.Saved && rejected.MayHaveCommitted && rejected.RequiresRecovery && calls() == 2 &&
                    service.PendingSaves().Single().ReplayEligible,
                    "A later rejection settled the original unknown dispatch.");
                Check(File.ReadAllBytes(first).SequenceEqual(bytes), "Recovery replaced damaged original evidence.");
                var settled = await service.RecoverAsync(frozen.RequestId);
                Check(settled.Saved && !settled.RequiresRecovery && calls() == 3 && service.PendingSaves().Count == 0,
                    "Matching authoritative receipt did not settle the exact interrupted request: " + settled.Error);
                Check(File.ReadAllBytes(first).SequenceEqual(bytes) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Receipt reconciliation changed original evidence or request bytes.");
            }, frozen => ++dispatched switch {
                1 => new(false, null, "fixture_unknown", "Response was lost.", null, "", 1, true),
                2 => new(false, JsonSerializer.SerializeToElement(MutationResponse(frozen, false)), "revision_conflict", "A target changed.", 3, "", 1),
                _ => new(true, JsonSerializer.SerializeToElement(MutationResponse(frozen, replayed: true)), null, "OK", 0, "", 1)
            });
        }
    }

    public static async Task IncompleteEvidenceContextGuardAsync()
    {
        await WithRecoveryJournalAsync(async (service, frozen, calls) => {
            var contextFile = Path.Combine(frozen.JournalDirectory, "context.json");
            var context = JsonNode.Parse(File.ReadAllText(contextFile))!.AsObject();
            context["prior_outcome_unknown"] = false;
            File.WriteAllText(contextFile, context.ToJsonString());
            var first = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
            File.WriteAllBytes(first, []);
            Check(!service.PendingSaves().Single().ReplayEligible && !(await service.RecoverAsync(frozen.RequestId)).Saved && calls() == 1,
                "Incomplete evidence bypassed an explicit non-unknown context.");
            context["prior_outcome_unknown"] = true;
            File.WriteAllText(contextFile, context.ToJsonString());
            foreach (var bytes in new[] { new byte[] { 0xff }, Encoding.UTF8.GetBytes("{\"v\":5,\"v\":5}") })
            {
                File.WriteAllBytes(first, bytes);
                Check(!service.PendingSaves().Single().ReplayEligible && !(await service.RecoverAsync(frozen.RequestId)).Saved && calls() == 1,
                    "Invalid UTF-8 or duplicate structured evidence bypassed provenance guards.");
                Check(File.ReadAllBytes(first).SequenceEqual(bytes), "Blocked evidence was rewritten.");
            }
        });
    }

    public static async Task SyntheticMarkerIdentityAsync()
    {
        await WithRecoveryJournalAsync(async (service, frozen, calls) => {
            var first = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
            var original = File.ReadAllBytes(first);
            var matching = JsonNode.Parse(original)!.AsObject();
            Check(matching["request_id"]?.GetValue<string>() == frozen.RequestId &&
                matching["database_instance_id"]?.GetValue<string>() == frozen.DatabaseInstanceId &&
                matching["database_epoch"]?.GetValue<string>() == frozen.DatabaseEpoch &&
                matching["request_sha256"]?.GetValue<string>() == Convert.ToHexString(SHA256.HashData(frozen.ExactRequestUtf8)).ToLowerInvariant(),
                "Fresh synthetic marker has no exact request/store/hash diagnostic identity.");
            var pending = service.PendingSaves().Single();
            Check(pending.ReplayEligible && pending.Issue?.Contains("Fixture response was lost.") == true,
                "Matching synthetic diagnostic lost its own original guidance.");
            foreach (var field in new[] { "request_id", "database_instance_id", "database_epoch", "request_sha256" })
            foreach (var mode in new[] { "foreign", "missing", "invalid" })
            {
                var altered = JsonNode.Parse(original)!.AsObject();
                if (mode == "missing") altered.Remove(field);
                else altered[field] = mode == "foreign" ? JsonValue.Create("foreign") : JsonValue.Create(17);
                var bytes = Encoding.UTF8.GetBytes(altered.ToJsonString());
                File.WriteAllBytes(first, bytes);
                pending = service.PendingSaves().Single();
                Check(!pending.ReplayEligible && pending.Issue?.Contains(frozen.RequestId) == true &&
                    pending.Issue.Contains("request.json") && pending.Issue.Contains("context.json"),
                    "Invalid synthetic provenance lacks current frozen reconciliation guidance: " + pending.Issue);
                var blocked = await service.RecoverAsync(frozen.RequestId);
                Check(!blocked.Saved && blocked.RequiresRecovery && blocked.MayHaveCommitted && calls() == 1 &&
                    File.ReadAllBytes(first).SequenceEqual(bytes),
                    "Invalid synthetic identity dispatched, settled, or changed its evidence.");
            }
            File.WriteAllBytes(first, original);
            Check(service.PendingSaves().Single().ReplayEligible, "Original matching marker cannot be read again.");
        });
    }

    public static async Task LegacyMarkerGuidanceAsync()
    {
        var dispatched = 0;
        await WithRecoveryJournalAsync(async (service, frozen, calls) => {
            var first = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
            var copied = JsonSerializer.SerializeToUtf8Bytes(new { operation = "put", code = "foreign_timeout",
                message = "WRONG_GUIDANCE_FROM_ANOTHER_REQUEST", mayHaveCommitted = true });
            File.WriteAllBytes(first, copied);
            var pending = service.PendingSaves().Single();
            Check(pending.ReplayEligible && pending.Issue?.Contains("WRONG_GUIDANCE_FROM_ANOTHER_REQUEST") != true &&
                pending.Issue?.Contains("foreign_timeout") != true && pending.Issue?.Contains("unverified", StringComparison.OrdinalIgnoreCase) == true &&
                pending.Issue.Contains(frozen.RequestId) && pending.Issue.Contains("request.json") && pending.Issue.Contains("context.json"),
                "Copied same-operation legacy guidance is attributed to current request: " + pending.Issue);
            var rejected = await service.RecoverAsync(frozen.RequestId);
            Check(!rejected.Saved && rejected.MayHaveCommitted && rejected.RequiresRecovery && calls() == 2 &&
                rejected.Error?.Contains("WRONG_GUIDANCE_FROM_ANOTHER_REQUEST") != true && service.PendingSaves().Single().ReplayEligible,
                "Legacy guidance changed conservative recovery or a later rejection settled it.");
            var settled = await service.RecoverAsync(frozen.RequestId);
            Check(settled.Saved && !settled.RequiresRecovery && calls() == 3 && service.PendingSaves().Count == 0 &&
                File.ReadAllBytes(first).SequenceEqual(copied) &&
                File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                "Legacy exact receipt recovery changed evidence, request, or settlement authority.");
        }, frozen => ++dispatched switch {
            1 => new(false, null, "fixture_unknown", "Response lost.", null, "", 1, true),
            2 => new(false, JsonSerializer.SerializeToElement(MutationResponse(frozen, false)), "revision_conflict", "A target changed.", 3, "", 1),
            _ => new(true, JsonSerializer.SerializeToElement(MutationResponse(frozen, replayed: true)), null, "OK", 0, "", 1)
        });
    }

    public static async Task ZeroRevisionDeliveryReportAsync()
    {
        await WithRecoveryJournalAsync(async (service, frozen, calls) => {
            var deliveryFile = Path.Combine(frozen.JournalDirectory, "delivery-error.json");
            var original = File.ReadAllBytes(deliveryFile);
            foreach (var filename in new[] { "delivery-error.json", "response.json" })
            {
                if (filename == "response.json") File.Move(deliveryFile, Path.Combine(frozen.JournalDirectory, filename));
                var pending = service.PendingSaves().Single();
                Check(!pending.CommitReported && pending.CommittedRevision is null,
                    "Zero revision delivery report was presented as an admitted commit.");
                Check(pending.ReplayEligible == (filename == "response.json"),
                    "Invalid delivery status or deliberate corrupt-cache recovery had the wrong eligibility.");
                var recovered = await service.RecoverAsync(frozen.RequestId);
                Check(!recovered.Saved && recovered.MayHaveCommitted && recovered.RequiresRecovery &&
                    calls() == (filename == "response.json" ? 2 : 1),
                    "Invalid delivery report cleared uncertainty or bypassed its recovery guard.");
                Check(File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, filename)).SequenceEqual(original) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Zero revision rejection changed original report/request bytes.");
            }
        }, frozen => {
            var response = MutationResponse(frozen, false);
            response["revision"] = 0;
            response["error"]!["code"] = "response_delivery_failed";
            response["error"]!["identifiers"]!["committed_revision"] = 0;
            response["error"]!["identifiers"]!["receipt_id"] = ReceiptId(frozen.DatabaseInstanceId, frozen.DatabaseEpoch, frozen.RequestId);
            return new(false, JsonSerializer.SerializeToElement(response), "response_delivery_failed", "Delivery failed.", 5, "", 1, true);
        }, inspectPrime: result => Check(result.Error?.Contains("commit at revision 0", StringComparison.Ordinal) != true,
            "Fresh zero revision delivery report falsely claimed an admitted commit at revision 0."));
    }

    public static async Task CorruptUncertaintyContextAsync()
    {
        foreach (var value in new[] { "\"true\"", "null", "{}", "[]" })
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var contextFile = Path.Combine(frozen.JournalDirectory, "context.json");
                var context = JsonNode.Parse(await File.ReadAllTextAsync(contextFile))!.AsObject();
                context["prior_outcome_unknown"] = JsonNode.Parse(value);
                var bytes = Encoding.UTF8.GetBytes(context.ToJsonString());
                await File.WriteAllBytesAsync(contextFile, bytes);
                var pending = service.PendingSaves().Single();
                Check(!pending.ReplayEligible && pending.Issue is not null,
                    "Malformed uncertainty state was admitted for replay.");
                var outcome = await service.SaveAsync(frozen);
                Check(!outcome.Saved && outcome.MayHaveCommitted && outcome.RequiresRecovery && calls() == 1,
                    "Malformed uncertainty state threw or cleared the unresolved outcome.");
                Check(File.ReadAllBytes(contextFile).SequenceEqual(bytes) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Malformed context or original request was rewritten.");
            });
    }

    public static async Task CorruptCachedResponsesAsync()
    {
        foreach (var name in new[] { "minimal-success", "minimal-error", "malformed", "version", "operation",
            "request", "instance", "epoch", "more", "next", "revision", "replayed", "committed-revision",
            "receipt", "record", "foreign-error" })
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var response = MutationResponse(frozen);
                switch (name) {
                    case "version": response["v"] = 4; break;
                    case "operation": response["operation"] = "decision.set"; break;
                    case "request": response["request"]!["id"] = "ll-foreign"; break;
                    case "instance": response["database_instance_id"] = "other"; break;
                    case "epoch": response["database_epoch"] = "other"; break;
                    case "more": response["more"] = true; break;
                    case "next": response["next"] = 1; break;
                    case "revision": response["revision"] = -1; break;
                    case "replayed": response["request"]!["replayed"] = "true"; break;
                    case "committed-revision": response["request"]!["committed_revision"] = 7; break;
                    case "receipt": response["receipt_id"] = "mutation-receipt:foreign"; break;
                    case "record": response["data"]!["id"] = "fact:foreign"; break;
                    case "foreign-error": response = MutationResponse(frozen, false); response["request"]!["id"] = "ll-foreign"; break;
                }
                var responseBytes = Encoding.UTF8.GetBytes(name switch {
                    "minimal-success" => "{\"ok\":true}", "minimal-error" => "{\"ok\":false}",
                    "malformed" => "{", _ => response.ToJsonString()
                });
                var responsePath = Path.Combine(frozen.JournalDirectory, "response.json"); File.WriteAllBytes(responsePath, responseBytes);
                var contextPath = Path.Combine(frozen.JournalDirectory, "context.json"); var context = File.ReadAllBytes(contextPath);
                var pending = service.PendingSaves().SingleOrDefault(item => item.RequestId == frozen.RequestId);
                Check(pending is not null && pending.ReplayEligible && pending.Issue is not null,
                    name + " cached response erased the journal or poisoned validated exact recovery.");
                var saved = await service.SaveAsync(frozen);
                Check(!saved.Saved && saved.MayHaveCommitted && saved.RequiresRecovery && calls() == 1,
                    name + " cached response falsely settled or dispatched a mutation.");
                var replay = await service.RecoverAsync(frozen.RequestId);
                Check(!replay.Saved && replay.RequiresRecovery && replay.MayHaveCommitted && calls() == 2,
                    name + " corrupt response blocked validated exact replay or lost uncertainty.");
                Check(File.ReadAllBytes(responsePath).SequenceEqual(responseBytes) &&
                    File.ReadAllBytes(contextPath).SequenceEqual(context) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    name + " cached failure changed retained exact journal bytes.");
            });
    }

    public static async Task MatchingCachedResponsesAsync()
    {
        foreach (var (okay, replayed, changed) in new[] { (true, false, true), (true, false, false),
            (true, true, true), (false, false, false) })
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var response = MutationResponse(frozen, okay, replayed);
                if (okay && !changed) response["data"]!["revision"] = 4;
                var path = Path.Combine(frozen.JournalDirectory, "response.json");
                var bytes = (replayed ? Encoding.UTF8.GetPreamble() : Array.Empty<byte>())
                    .Concat(Encoding.UTF8.GetBytes(response.ToJsonString())).ToArray(); File.WriteAllBytes(path, bytes);
                Check(service.PendingSaves().Any(item => item.RequestId == frozen.RequestId) == !okay,
                    "Matching receipt did not settle, or later rejection erased prior uncertainty.");
                var saved = await service.SaveAsync(frozen);
                Check(saved.Saved == okay && saved.MayHaveCommitted == !okay && saved.RequiresRecovery == !okay && calls() == 1,
                    "Matching cached success/error was rejected or re-dispatched.");
                Check(File.ReadAllBytes(path).SequenceEqual(bytes), "Matching response was overwritten.");
            });
    }

    public static async Task FreshResponseIdentityAsync()
    {
        foreach (var name in new[] { "request", "operation", "store", "receipt", "flags" })
            await WithRecoveryJournalAsync((service, frozen, calls) => {
                var item = service.PendingSaves().SingleOrDefault(row => row.RequestId == frozen.RequestId);
                Check(item is not null && item.ReplayEligible && calls() == 1,
                    name + " fresh foreign response hid a journal or poisoned exact recovery.");
                return Task.CompletedTask;
            }, frozen => {
                var body = MutationResponse(frozen);
                if (name == "request") body["request"]!["id"] = "ll-foreign";
                if (name == "operation") body["operation"] = "pending.drop";
                if (name == "store") body["database_epoch"] = "foreign";
                if (name == "receipt") body["receipt_id"] = "mutation-receipt:foreign";
                return new(name != "flags", JsonSerializer.SerializeToElement(body), null, "OK", 0, "", 1);
            });
    }

    public static Task ReplayBusySourceAsync()
    {
        var source = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(source, "lodestar.mjs"))) source = Directory.GetParent(source)?.FullName ?? throw new Exception("Source not found.");
        var code = File.ReadAllText(Path.Combine(source, "desktop", "Lodestar.Loader", "MainWindow.xaml.cs"));
        var replay = code[code.IndexOf("private async void ReplayClicked", StringComparison.Ordinal)..
            code.IndexOf("private async void RefreshCapabilitiesClicked", StringComparison.Ordinal)];
        Check(replay.Contains("_saving = true;") && replay.IndexOf("_saving = true;", StringComparison.Ordinal) < replay.IndexOf("await ", StringComparison.Ordinal),
            "Replay does not acquire the shared mutation guard before awaiting.");
        Check(replay.Contains("var service = _service;") && replay.Contains("service.RecoverAsync(") &&
            replay.Contains("_service != service") && replay.Contains("_closingAfterSave") && replay.Contains("_disposed") && replay.Contains("_shutdownStarted"),
            "Replay lacks original-service/disposed completion guards.");
        Check(replay[replay.IndexOf("finally", StringComparison.Ordinal)..].Contains("_saving = false;"), "Replay guard is not released in finally.");
        Check(replay.Contains("SelectRuntimeButton.IsEnabled = SelectRuntimeTopButton.IsEnabled = false;"), "Replay does not disable runtime selection.");
        var navigation = code[code.IndexOf("private bool CanLeaveDraft()", StringComparison.Ordinal)..];
        Check(navigation.IndexOf("if (_saving", StringComparison.Ordinal) < navigation.IndexOf("if (!_editing)", StringComparison.Ordinal),
            "Non-editor navigation bypasses the mutation guard.");
        return Task.CompletedTask;
    }

    public static async Task CorruptCacheRecoversWithReceiptAsync()
    {
        foreach (var corrupt in new[] { "{\"ok\":true}", "{", "{\"ok\":false}" })
        {
            var dispatched = 0;
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var path = Path.Combine(frozen.JournalDirectory, "response.json");
                File.WriteAllText(path, corrupt); var oldBytes = File.ReadAllBytes(path);
                var before = await service.SaveAsync(frozen);
                Check(!before.Saved && before.RequiresRecovery && calls() == 1,
                    "Ordinary Save trusted/replayed unverified cached bytes.");
                var recovered = await service.RecoverAsync(frozen.RequestId);
                Check(recovered.Saved && !recovered.RequiresRecovery && calls() == 2 &&
                    !service.PendingSaves().Any(item => item.RequestId == frozen.RequestId),
                    "Authoritative exact replay did not resolve an invalid cached response.");
                var snapshots = Directory.GetFiles(frozen.JournalDirectory, "response-unverified-*.json");
                Check(snapshots.Any(file => File.ReadAllBytes(file).SequenceEqual(oldBytes)),
                    "Confirmed recovery discarded corrupt response evidence.");
                Check(File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Confirmed recovery changed the exact original request.");
                var cached = await service.SaveAsync(frozen);
                Check(cached.Saved && calls() == 2,
                    "Settled recovered response was not reused without dispatch: " + cached.Error);
            }, frozen => ++dispatched == 1 ? new(false, null, "fixture_unknown", "lost", null, "", 1, true)
                : new(true, JsonSerializer.SerializeToElement(MutationResponse(frozen, replayed: true)), null, "OK", 0, "", 1));
        }
    }

    public static async Task SemanticUnknownJournalAsync()
    {
        foreach (var code in new[] { "database_commit_outcome_unknown", "database_rollback_failed", "database_connection_cleanup_failed" })
        foreach (var absentIdentity in new[] { false, true })
        {
            var action = "Inspect the original request, receipt and current state before any replay.";
            var writes = 0;
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var responsePath = Path.Combine(frozen.JournalDirectory, "response.json");
                var savedResponse = File.ReadAllBytes(responsePath);
                var pending = service.PendingSaves().Single();
                Check(pending.ReplayEligible && !pending.CommitReported && pending.Issue?.Contains(action) == true &&
                    pending.Issue?.Contains("rejected", StringComparison.OrdinalIgnoreCase) != true,
                    "Semantic uncertainty was presented as rejection or lost core recovery: " + pending.Issue);
                var cached = await service.SaveAsync(frozen);
                Check(!cached.Saved && cached.MayHaveCommitted && cached.RequiresRecovery && calls() == 1 &&
                    cached.Error?.Contains(action) == true, "Cached semantic response settled or replayed without explicit recovery.");
                Check(File.ReadAllBytes(responsePath).SequenceEqual(savedResponse), "Cached semantic response bytes changed.");
                var replay = await service.RecoverAsync(frozen.RequestId);
                Check(!replay.Saved && replay.MayHaveCommitted && replay.RequiresRecovery && calls() == 2,
                    "Later definite rejection settled the semantic unknown attempt.");
                Check(service.PendingSaves().Single().RequestId == frozen.RequestId &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory,"request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Pending journal or exact request disappeared after later rejection.");
                await using var reopened = new LodestarService(frozen.Runtime, Path.GetDirectoryName(frozen.JournalDirectory));
                var reopenedPending = reopened.PendingSaves().Single();
                Check(reopenedPending.Issue?.Contains(action) == true && reopenedPending.Issue.Contains(code),
                    "Reopened Recovery lost the original semantic error/action after later rejection: " + reopenedPending.Issue);
                var firstPath = Path.Combine(frozen.JournalDirectory,"response.uncertainty.json");
                Check(File.ReadAllBytes(firstPath).SequenceEqual(savedResponse), "First uncertainty response bytes changed.");
            }, frozen => {
                var response = MutationResponse(frozen, false);
                if (++writes == 1) {
                    response["error"]!["code"] = code;
                    response["error"]!["message"] = "The transaction outcome requires reconciliation.";
                    response["error"]!["action"] = action;
                    response["error"]!["identifiers"]!["committed"] = code == "database_connection_cleanup_failed"
                        ? JsonValue.Create(true) : JsonValue.Create("unknown");
                    response["next"] = new JsonArray(action);
                    if (absentIdentity) {
                        response.Remove("request"); response["database_instance_id"] = null; response["database_epoch"] = null;
                        response["error"]!["identifiers"]!.AsObject().Remove("request_id");
                        response["error"]!["identifiers"]!.AsObject().Remove("database_instance_id");
                        response["error"]!["identifiers"]!.AsObject().Remove("database_epoch");
                    }
                }
                return CliTransport.ParseRecordedMutation(new("put", ["put"], frozen.Runtime,
                    TimeSpan.FromSeconds(1), true), JsonSerializer.SerializeToElement(response));
            }, inspectPrime: result => Check(result.Error?.Contains(action) == true,
                "Fresh semantic uncertainty did not expose core recovery action."));
        }
    }

    public static async Task SemanticProvenanceFailureAsync()
    {
        foreach (var failure in new[] { "directory", "foreign", "version", "operation", "instance", "epoch", "request", "identifier-instance", "identifier-epoch", "receipt", "marker-extra", "marker-operation" })
        {
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var response = Path.Combine(frozen.JournalDirectory,"response.json");
                var before = File.ReadAllBytes(response);
                var first = Path.Combine(frozen.JournalDirectory,"response.uncertainty.json");
                if (failure == "directory") { if (File.Exists(first)) File.Delete(first); Directory.CreateDirectory(first); }
                else {
                    using var original = JsonData.ParseDocument(before);
                    var foreign = JsonNode.Parse(original.RootElement.GetRawText())!.AsObject();
                    switch (failure) {
                        case "version": foreign["v"] = 999; break;
                        case "operation": foreign["operation"] = "get"; break;
                        case "instance": foreign["database_instance_id"] = "foreign"; break;
                        case "epoch": foreign["database_epoch"] = "foreign"; break;
                        case "request": foreign["request"]!["id"] = "ll-foreign"; break;
                        case "identifier-instance": foreign["error"]!["identifiers"]!["database_instance_id"] = "foreign"; break;
                        case "identifier-epoch": foreign["error"]!["identifiers"]!["database_epoch"] = "foreign"; break;
                        case "receipt": foreign["error"]!["identifiers"]!["receipt_id"] = "foreign"; break;
                        case "marker-extra": foreign = JsonNode.Parse("{\"operation\":\"put\",\"code\":\"timeout\",\"message\":\"Lost response\",\"mayHaveCommitted\":true,\"request_id\":\"ll-foreign\"}")!.AsObject(); break;
                        case "marker-operation": foreign = JsonNode.Parse("{\"operation\":\"get\",\"code\":\"timeout\",\"message\":\"Lost response\",\"mayHaveCommitted\":true}")!.AsObject(); break;
                        default: foreign["error"]!["identifiers"]!["request_id"] = "ll-foreign"; break;
                    }
                    File.WriteAllText(first,foreign.ToJsonString());
                }
                var attempted = await service.RecoverAsync(frozen.RequestId);
                Check(!attempted.Saved && attempted.MayHaveCommitted && attempted.RequiresRecovery && calls() == 1,
                    "Invalid first-uncertainty provenance did not block replay before dispatch: " + attempted.Error);
                Check(File.ReadAllBytes(response).SequenceEqual(before) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory,"request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Provenance failure replaced latest response or changed exact request.");
                Check(attempted.Error?.Contains("uncertainty", StringComparison.OrdinalIgnoreCase) == true,
                    "Provenance failure has no actionable named guidance.");
            }, frozen => {
                var error = MutationResponse(frozen,false);error["error"]!["code"]="database_commit_outcome_unknown";
                error["error"]!["identifiers"]!["committed"]="unknown";
                return CliTransport.ParseRecordedMutation(new("put",["put"],frozen.Runtime,TimeSpan.FromSeconds(1),true),
                    JsonSerializer.SerializeToElement(error));
            });
        }
        await WithRecoveryJournalAsync(async (service, frozen, calls) => {
            var latest = Path.Combine(frozen.JournalDirectory,"response.json");
            Check(File.Exists(latest), "Failed first-uncertainty retention lost the fresh core response.");
            using var document = JsonData.ParseDocument(File.ReadAllBytes(latest));
            Check(JsonData.String(document.RootElement.GetProperty("error"),"code") == "database_commit_outcome_unknown" &&
                calls() == 1 && File.ReadAllBytes(Path.Combine(frozen.JournalDirectory,"request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                "Failed retention changed core response or exact request.");
        }, frozen => {
            Directory.CreateDirectory(Path.Combine(frozen.JournalDirectory,"response.uncertainty.json"));
            var error = MutationResponse(frozen,false);error["error"]!["code"]="database_commit_outcome_unknown";
            return CliTransport.ParseRecordedMutation(new("put",["put"],frozen.Runtime,TimeSpan.FromSeconds(1),true),
                JsonSerializer.SerializeToElement(error));
        }, inspectPrime: result => Check(result.Error?.Contains("uncertainty", StringComparison.OrdinalIgnoreCase) == true,
            "Fresh failed retention lost its named actionable failure."));
    }

    public static async Task TransportUnknownJournalAsync()
    {
        foreach (var observedExit in OperatingSystem.IsWindows() ? new[] { 1, 9, -1073741819 } : new[] { 1, 9 })
        {
            var dispatched = 0;
            byte[]? originalResponse = null;
            const string action = "Read the current basis and reconcile the exact original request before any new write.";
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var pending = service.PendingSaves().Single();
                Check(pending.ReplayEligible && !pending.CommitReported && pending.Issue?.Contains(action) == true &&
                    pending.Issue.Contains("revision_conflict"), "Live exit uncertainty lost the core error/action: " + pending.Issue);
                var firstFile = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
                var firstBytes = File.ReadAllBytes(firstFile);
                using (var marker = JsonData.ParseDocument(firstBytes))
                    Check(marker.RootElement.TryGetProperty("mayHaveCommitted", out var unknown) && unknown.GetBoolean(),
                        "An exit-free core envelope was substituted for the observed process uncertainty.");
                Check(Directory.GetFiles(frozen.JournalDirectory, "response-unverified-*.json")
                    .Any(path => File.ReadAllBytes(path).SequenceEqual(originalResponse!)), "Original observed response bytes were dropped.");
                var cached = await service.SaveAsync(frozen);
                Check(!cached.Saved && cached.MayHaveCommitted && cached.RequiresRecovery && calls() == 1,
                    "Cached ordinary envelope falsely settled the live process failure or redispatched it.");
                var rejection = await service.RecoverAsync(frozen.RequestId);
                Check(!rejection.Saved && rejection.MayHaveCommitted && rejection.RequiresRecovery && calls() == 2,
                    "Later rejection erased an earlier observed process uncertainty.");
                await using var reopened = new LodestarService(frozen.Runtime, Path.GetDirectoryName(frozen.JournalDirectory));
                var after = reopened.PendingSaves().Single();
                Check(after.ReplayEligible && after.Issue?.Contains(action) == true && after.Issue.Contains("revision_conflict") &&
                    File.ReadAllBytes(firstFile).SequenceEqual(firstBytes) &&
                    File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(frozen.ExactRequestUtf8),
                    "Reopen lost the first uncertainty, original action or exact request.");
                var resolved = await service.RecoverAsync(frozen.RequestId);
                Check(resolved.Saved && !resolved.RequiresRecovery && !resolved.MayHaveCommitted && calls() == 3 &&
                    !service.PendingSaves().Any(), "Matching exact receipt replay did not settle the journal.");
            }, frozen => {
                var response = MutationResponse(frozen, false);
                response["error"]!["action"] = action;
                var recorded = CliTransport.ParseRecordedMutation(new("put", ["put"], frozen.Runtime,
                    TimeSpan.FromSeconds(5), true), JsonSerializer.SerializeToElement(response));
                Check(recorded.Code == "revision_conflict" && !recorded.MayHaveCommitted && recorded.ExitCode is null,
                    "Saved ordinary error invented a process exit or lost its original classification.");
                if (++dispatched != 1)
                    return dispatched == 2
                        ? new(false, JsonSerializer.SerializeToElement(response), "revision_conflict", "Rejected. Action: " + action, 3, "", 1)
                        : new(true, JsonSerializer.SerializeToElement(MutationResponse(frozen, replayed: true)), null, "OK", 0, "", 1);
                originalResponse = Encoding.UTF8.GetBytes(response.ToJsonString());
                var script = Path.Combine(Path.GetDirectoryName(frozen.JournalDirectory)!, "observed-exit.mjs");
                File.WriteAllText(script, "process.stderr.write(" + JsonSerializer.Serialize(response.ToJsonString()) +
                    ",()=>{process.exitCode=" + observedExit + ";});");
                var actualRuntime = frozen.Runtime with { NodePath = TestNodeRuntime.Resolve(), CliPath = script };
                var transport = new CliTransport();
                try { return transport.ExecuteAsync(new("put", ["put"], actualRuntime,
                    TimeSpan.FromSeconds(5), true)).GetAwaiter().GetResult(); }
                finally { transport.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
            }, inspectPrime: result => Check(result.Cli?.Code == "protocol_error" && result.Cli.ExitCode == observedExit &&
                result.Cli.MayHaveCommitted && result.Error?.Contains(action) == true,
                "Live unsupported-exit result did not preserve transport uncertainty and core action: " + result.Error));
        }
    }

    public static async Task LaterRejectionRetainsUnknownAsync()
    {
        foreach (var code in new[] { "database_busy", "project_binding_conflict", "revision_conflict", "request_conflict" })
        {
            var dispatched = 0;
            await WithRecoveryJournalAsync(async (service, frozen, calls) => {
                var result = await service.RecoverAsync(frozen.RequestId);
                Check(!result.Saved && result.MayHaveCommitted && result.RequiresRecovery && calls() == 2,
                    code + " rejection falsely resolved an earlier lost response.");
                Check(service.PendingSaves().Single().RequestId == frozen.RequestId,
                    code + " replay rejection erased earlier uncertainty.");
                var repeated = await service.SaveAsync(frozen);
                Check(!repeated.Saved && repeated.MayHaveCommitted && repeated.RequiresRecovery && calls() == 2,
                    code + " cached later rejection falsely settled or dispatched.");
            }, frozen => {
                if (++dispatched == 1) return new(false, null, "fixture_unknown", "lost", null, "", 1, true);
                var error = MutationResponse(frozen, false); error["error"]!["code"] = code;
                return new(false, JsonSerializer.SerializeToElement(error), code, "Rejected", 2, "", 1);
            });
        }
    }

    public static Task InitialRejectionIsSettledAsync() => WithConfigAsync(async (root, config) => {
        File.WriteAllText(config, JsonSerializer.Serialize(Config(Guid.NewGuid().ToString("D"))));
        var runtime = await RuntimeConfig.LoadAsync(config);
        var id = "ll-" + Guid.NewGuid().ToString("D");
        var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = id,
            input = new { mode = "update", id = "fact:x", set = new { name = "Changed" }, remove = Array.Empty<string>() } });
        var frozen = new FrozenMutation(id, "fact:x", runtime, "a", "b", body, Path.Combine(root, "pending", id));
        var writes = 0;
        await using var service = new LodestarService(runtime, (call, _) => {
            if (call.OperationId == "find") return Task.FromResult(new CliResult(true,
                Json(new { v = 5, ok = true, operation = "find", revision = 5, database_instance_id = "a",
                    database_epoch = "b", data = new { records = Array.Empty<object>() }, more = false, next = Array.Empty<string>() }),
                null, "OK", 0, "", 1));
            writes++;
            return Task.FromResult(new CliResult(false, JsonSerializer.SerializeToElement(MutationResponse(frozen, false)),
                "revision_conflict", "A target changed.", 2, "", 1));
        }, Path.Combine(root, "pending"));
        foreach (var attempt in new[] { 1, 2 }) {
            var outcome = await service.SaveAsync(frozen);
            Check(!outcome.Saved && !outcome.MayHaveCommitted && !outcome.RequiresRecovery && writes == 1 &&
                !service.PendingSaves().Any(), "Initial definitive rejection did not remain settled/actionable: " + outcome.Error);
        }
    });

    public static async Task GatedReplayAsync()
    {
        foreach (var cancelled in new[] { false, true })
            await WithRecoveryJournalAsync(async (_, frozen, _) => {
                var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                using var cancellation = new CancellationTokenSource();
                await using var recovery = new LodestarService(frozen.Runtime, async (call, token) => {
                    if (call.OperationId == "find") return new CliResult(true,
                        Json(new { v = 5, ok = true, operation = "find", revision = 5,
                            database_instance_id = "a", database_epoch = "b", data = new { records = Array.Empty<object>() },
                            more = false, next = Array.Empty<string>() }), null, "OK", 0, "", 1);
                    entered.TrySetResult(); await release.Task.WaitAsync(token);
                    return new CliResult(true, JsonSerializer.SerializeToElement(MutationResponse(frozen, replayed: true)),
                        null, "OK", 0, "", 1);
                }, Path.GetDirectoryName(frozen.JournalDirectory));
                var pending = recovery.RecoverAsync(frozen.RequestId, cancellation.Token);
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                Check(!pending.IsCompleted && recovery.PendingSaves().Single().RequestId == frozen.RequestId,
                    "Gated replay did not retain an unresolved original request during dispatch.");
                var body = File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json"));
                Check(body.SequenceEqual(frozen.ExactRequestUtf8), "Gated replay changed frozen bytes.");
                if (cancelled) cancellation.Cancel(); else release.TrySetResult();
                var result = await pending;
                Check(result.RequestId == frozen.RequestId && result.Saved == !cancelled &&
                    (cancelled ? result.MayHaveCommitted && result.RequiresRecovery : !result.RequiresRecovery),
                    "Gated replay lost the original request outcome or cancellation uncertainty.");
                Check(File.ReadAllBytes(Path.Combine(frozen.JournalDirectory, "request.json")).SequenceEqual(body),
                    "Replay completion/cancellation changed exact request bytes.");
                if (cancelled) Check(recovery.PendingSaves().Single().RequestId == frozen.RequestId,
                    "Cancelled replay erased the journal.");
            });
    }
    private static object Descriptor(string type, object[] choices, string binding = "option") => new {
        id = "probe", argv = new[] { "probe" }, effect = "read", summary = "Probe",
        context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
        parameters = new[] { new { name = "choice", binding, flag = "--choice", required = true,
            schema = new { type, @enum = choices } } }
    };

    private static async Task<JsonElement> CurrentFindDescriptorAsync()
    {
        var source = AppContext.BaseDirectory;
        while (!File.Exists(Path.Combine(source, "lodestar.mjs")))
            source = Directory.GetParent(source)?.FullName ?? throw new Exception("Current core source was not found.");
        var node = TestNodeRuntime.Resolve();
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(source, "lodestar.mjs")); start.ArgumentList.Add("--help");
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try { await process.WaitForExitAsync(deadline.Token); }
        catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw; }
        Check(process.ExitCode == 0, "Current CLI help failed: " + await stderr);
        using var help = JsonDocument.Parse(await stdout);
        return help.RootElement.GetProperty("data").GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("id").GetString() == "find").Clone();
    }

    private static async Task CheckReadAsync(JsonElement descriptor, Dictionary<string, string?> values,
        string[]? expected)
    {
        var calls = new List<CliInvocation>();
        await using var service = new LodestarService(new("c", "g", "n", "m", "d", "f"), (call, _) => {
            if (call.OperationId == "help") return Task.FromResult(Success("help", new {
                capability_version = 1, operations = new[] { descriptor } }));
            calls.Add(call); return Task.FromResult(Success(call.OperationId, new { }));
        });
        var operation = (await service.DiscoverAsync()).Operations.Single();
        Check(operation.CanRunGenericRead, "Find descriptor was unavailable: " + operation.UnavailableReason);
        if (expected is null) {
            try { await service.RunReadAsync(operation, values); throw new Exception("Invalid constraint dispatched."); }
            catch (ArgumentException) { }
            Check(calls.Count == 0, "Invalid constraint reached dispatch.");
        }
        else {
            await service.RunReadAsync(operation, values);
            Check(calls.Count == 1 && calls.Single().Arguments.SequenceEqual(expected),
                "Read did not dispatch exactly once with its described argv.");
        }
    }

    public static async Task FindBooleanTextAsync()
    {
        var find = await CurrentFindDescriptorAsync();
        foreach (var query in new[] { "false", "true" })
            await CheckReadAsync(find, new() { ["query"] = query }, ["find", "--", query]);
        await CheckReadAsync(find, new() { ["query"] = "false", ["all"] = "false" }, ["find", "--", "false"]);
    }

    public static async Task ConstraintControlsAsync()
    {
        var find = await CurrentFindDescriptorAsync();
        await CheckReadAsync(find, new() { ["query"] = "true" }, ["find", "--", "true"]);
        await CheckReadAsync(find, new() { ["all"] = "true" }, ["find", "--all"]);
        await CheckReadAsync(find, new() { ["all"] = "false" }, null);
        await CheckReadAsync(find, new() { ["query"] = "true", ["all"] = "true" }, null);
        await CheckReadAsync(find, new(), null);
        var atMost = JsonNode.Parse(find.GetRawText())!.AsObject();
        atMost["constraints"]![0]!["kind"] = "at_most_one";
        var descriptor = JsonSerializer.SerializeToElement(atMost);
        await CheckReadAsync(descriptor, new() { ["all"] = "false" }, ["find"]);
        await CheckReadAsync(descriptor, new() { ["all"] = "true" }, ["find", "--all"]);
        await CheckReadAsync(descriptor, new() { ["query"] = "false", ["all"] = "false" }, ["find", "--", "false"]);
        await CheckReadAsync(descriptor, new() { ["query"] = "false", ["all"] = "true" }, null);
        await CheckReadAsync(descriptor, new(), ["find"]);
    }

    public static async Task TypedEnumsAsync(string enumType)
    {
        foreach (var (type, choices, accepted, rejected, binding, expected) in new[] {
            ("string", new object[] { "true", "1", "value" }, "true", "True", "option", new[] { "probe", "--choice", "true" }),
            ("integer", new object[] { -2, 0, 9007199254740991L }, "-2", "1", "option", new[] { "probe", "--choice", "-2" }),
            ("integer", new object[] { -2, 0, 9007199254740991L }, "9007199254740991", "9007199254740992", "option", new[] { "probe", "--choice", "9007199254740991" }),
            ("boolean", new object[] { false, true }, "false", "0", "option", new[] { "probe", "--choice", "false" }),
            ("boolean", new object[] { true }, "True", "false", "flag", new[] { "probe", "--choice" }),
            ("boolean", new object[] { false }, "false", "true", "flag", new[] { "probe" })
        }.Where(row => row.Item1 == enumType))
        {
            var calls = new List<CliInvocation>();
            await using var service = new LodestarService(new("c", "g", "n", "m", "d", "f"), (call, _) => {
                if (call.OperationId == "help") return Task.FromResult(Success("help", new {
                    capability_version = 1, operations = new[] { Descriptor(type, choices, binding) } }));
                calls.Add(call); return Task.FromResult(Success(call.OperationId, new { }));
            });
            var operation = (await service.DiscoverAsync()).Operations.Single();
            Check(operation.CanRunGenericRead, $"{type} enum was unavailable: {operation.UnavailableReason}");
            await service.RunReadAsync(operation, new Dictionary<string, string?> { ["choice"] = accepted });
            Check(calls.Count == 1 && calls[0].Arguments.SequenceEqual(expected), $"{type} enum lost exact argv.");
            foreach (var input in new[] { rejected, "", "--output" })
            {
                try { await service.RunReadAsync(operation, new Dictionary<string, string?> { ["choice"] = input });
                    throw new InvalidOperationException($"{type} enum accepted invalid input {input}."); }
                catch (ArgumentException) { }
                Check(calls.Count == 1, $"{type} invalid enum reached dispatch.");
            }
        }
    }

    public static async Task UnsafeEnumsAsync()
    {
        var descriptions = new[] {
            Descriptor("integer", new object[] { "1" }), Descriptor("integer", new object[] { 1.5 }),
            Descriptor("integer", new object[] { 9007199254740992L }),
            Descriptor("integer", new object[] { -9007199254740992L }),
            Descriptor("integer", new object[] { long.MaxValue }),
            Descriptor("boolean", new object[] { "true" }), Descriptor("string", new object[] { true }),
            Descriptor("string", Array.Empty<object>()), Descriptor("object", new object[] { "value" })
        };
        foreach (var descriptor in descriptions)
        {
            var calls = 0;
            await using var service = new LodestarService(new("c", "g", "n", "m", "d", "f"), (call, _) => {
                if (call.OperationId == "help") return Task.FromResult(Success("help", new {
                    capability_version = 1, operations = new[] { descriptor } }));
                calls++; return Task.FromResult(Success(call.OperationId, new { }));
            });
            var operation = (await service.DiscoverAsync()).Operations.Single();
            Check(!operation.CanRunGenericRead, "Unsafe or unknown enum schema was admitted.");
            try { await service.RunReadAsync(operation, new Dictionary<string, string?> { ["choice"] = "1" });
                throw new Exception("Unavailable enum was executed."); }
            catch (InvalidOperationException) { }
            Check(calls == 0, "Unavailable enum reached dispatch.");
        }
    }

    private static async Task WithConfigAsync(Func<string, string, Task> run)
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-native-finish-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            File.WriteAllText(Path.Combine(root, "node"), "node fixture");
            File.WriteAllText(Path.Combine(root, "probe.mjs"), "fixture");
            File.WriteAllText(Path.Combine(root, "db"), "database fixture");
            var config = Path.Combine(root, "interfaces.json");
            await run(root, config);
        }
        finally { Directory.Delete(root, true); }
    }
    private static object Config(string generation) => new {
        v = 1, generation, runtime = new { node = "node", cli = "probe.mjs", database = "db" },
        ui = new { theme = "user-theme", project_sort = "custom", last_project_id = "project:kept" },
        extension = new { nested = new[] { "retained", "verbatim" } }
    };

    public static Task ConfigPreservationAsync() => WithConfigAsync(async (root, path) => {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(Config(Guid.NewGuid().ToString("D")));
        File.WriteAllBytes(path, bytes);
        var initial = await RuntimeConfig.LoadAsync(path);
        var pending = Path.Combine(root, "pending", "ll-kept"); Directory.CreateDirectory(pending);
        var context = JsonSerializer.SerializeToUtf8Bytes(new { config = initial.ConfigPath,
            generation = initial.Generation, fingerprint = initial.Fingerprint, extra = "keep" });
        var contextPath = Path.Combine(pending, "context.json"); File.WriteAllBytes(contextPath, context);
        var requestPath = Path.Combine(pending, "request.json"); File.WriteAllText(requestPath, "exact request");
        var reloaded = await LodestarService.LoadRuntimeAsync(path);
        Check(reloaded == initial, "Read-only reload rotated runtime generation or fingerprint.");
        Check(File.ReadAllBytes(path).SequenceEqual(bytes), "Reload rewrote user UI or extension config fields.");
        Check(File.ReadAllBytes(contextPath).SequenceEqual(context) && File.ReadAllText(requestPath) == "exact request",
            "Reload changed pending journal bytes.");
        File.WriteAllText(path, JsonSerializer.Serialize(new { v = 1, generation = initial.Generation,
            runtime = new { node = "node", cli = "probe.mjs", database = "db" } }));
        Check(await RuntimeConfig.LoadAsync(path) == initial, "Omitting inert extras changed runtime identity.");
    });

    public static Task GenerationContractAsync() => WithConfigAsync(async (_, path) => {
        foreach (var generation in new[] { Guid.NewGuid().ToString("D"), "ABCDEF01-2345-6789-ABCD-EF0123456789" }) {
            File.WriteAllText(path, JsonSerializer.Serialize(Config(generation)));
            Check((await RuntimeConfig.LoadAsync(path)).Generation == generation, "Valid shared UUID was rejected.");
        }
        foreach (var generation in new[] { Guid.Empty.ToString("D"), "abcdef01-2345-0789-abcd-ef0123456789",
            "abcdef01-2345-6789-0bcd-ef0123456789", Guid.NewGuid().ToString("N"), "malformed" }) {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(Config(generation)); File.WriteAllBytes(path, bytes);
            try { await RuntimeConfig.LoadAsync(path); throw new Exception("Invalid shared UUID was accepted: " + generation); }
            catch (InvalidDataException) { }
            Check(File.ReadAllBytes(path).SequenceEqual(bytes), "Invalid config was rewritten.");
        }
    });
}
