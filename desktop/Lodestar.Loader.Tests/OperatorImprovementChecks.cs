using System.Reflection;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lodestar.Loader;

public static class OperatorImprovementChecks
{
    public static void Require(bool value, string message) { if (!value) throw new Exception(message); }
    public static async Task<(string Root, LodestarService Service, ProjectSummary Project)> FixtureAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-operator-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var generator = Path.Combine(AppContext.BaseDirectory, "generate-fixture.mjs");
        var node = Environment.GetEnvironmentVariable("LODESTAR_TEST_NODE") ?? throw new Exception("Set LODESTAR_TEST_NODE.");
        var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(generator); start.ArgumentList.Add(root);
        using (var process = Process.Start(start)!) {
            var output = process.StandardOutput.ReadToEndAsync(); var errors = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync(); await output; Require(process.ExitCode == 0, await errors);
        }
        var runtime = await RuntimeConfig.LoadAsync(Path.Combine(root, "interfaces.json"));
        var service = new LodestarService(runtime, journalRoot: Path.Combine(root, "journal"));
        await service.DiscoverAsync(); var project = (await service.LoadLibraryAsync()).Projects.Single();
        var work = await service.ReadProjectDomainAsync(project, "work.status");
        var basis = JsonNode.Parse(work.Envelope!.Value.GetProperty("data").GetProperty("write_basis").GetRawText())!;
        const string id = "knowledge:operator-intent";
        var absent = await service.ExecuteAsync(new("get", ["get", "--", id], runtime, TimeSpan.FromSeconds(30)));
        foreach (var target in absent.Envelope!.Value.GetProperty("error").GetProperty("identifiers").GetProperty("write_basis").GetProperty("targets").EnumerateArray())
            basis["targets"]!.AsArray().Add(JsonNode.Parse(target.GetRawText()));
        var input = new { mode = "create", record = new { id, kind = "knowledge", name = "Operator intent", scope = project.Id,
            availability = "known", priority = 1, aliases = Array.Empty<string>(), links = Array.Empty<string>(), sources = Array.Empty<string>(),
            data = new { intent = new { version = 1, brief = "Capture against the selected requirement", user_reference = "Disposable operator fixture",
                boundaries = new[] { "One SQLite authority" }, non_goals = new[] { "No daemon" }, requirements = new[] {
                    new { id = "R1", text = "Capture evidence", acceptance = "Inspect the saved association" },
                    new { id = "R2", text = "Preserve unrelated work", acceptance = "Keep its context" } } },
                continuation = new { active_requirement_ids = new[] { "R1" }, next_action = "Review evidence",
                    context = new { version = 1, mission_record_ids = Array.Empty<string>(), requirements = Array.Empty<object>() } } },
            semantics = new { lifecycle = "current", context_role = "on_demand", basis = "asserted", applicability = new { project = project.Id, checkout = (string?)null } } } };
        var file = Path.Combine(root, "intent.json");
        await File.WriteAllTextAsync(file, JsonSerializer.Serialize(new { v = 5, request_id = "fixture-" + Guid.NewGuid(), write_basis = basis, input }));
        var saved = await service.ExecuteAsync(new("put", ["put", "--file", file], runtime, TimeSpan.FromSeconds(30), true, file));
        Require(saved.Success, saved.Message); return (root, service, project);
    }
    public static JsonElement Draft(string stage, string recordId, bool acceptance = false) => JsonSerializer.SerializeToElement(stage == "create" ?
        (object)new { version = 1, stage, intent_record_id = "knowledge:operator-intent", author = "Fixture operator",
            record = new { id = recordId, type = "result", name = "Observed test", body = "Focused check observed", observed_outcome = "passed",
                evidence_reference = "fixture log", limitations = "Only the focused path" } } :
        new { version = 1, stage, intent_record_id = "knowledge:operator-intent", author = "Fixture operator", record_id = recordId,
            context_target = new { kind = "requirements", requirement_ids = new[] { "R1" } } });
    public static async Task<EditReview> PrepareAsync(LodestarService service, ProjectSummary project, JsonElement draft)
    {
        var method = typeof(LodestarService).GetMethod("PrepareCaptureAsync") ?? throw new Exception("OI2 RED: production PrepareCaptureAsync is absent.");
        return await (Task<EditReview>)method.Invoke(service, [project, draft, CancellationToken.None])!;
    }
    public static async Task RunAsync()
    {
        // Baseline must fail at the production entry before fixture setup or any write.
        Require(typeof(LodestarService).GetMethod("PrepareCaptureAsync") is not null, "OI2 RED: production capture adapter is absent.");
        Require(typeof(LodestarService).GetMethod("ReadAttentionAsync") is not null, "OI2 RED: production attention adapter is absent.");
        var (root, service, project) = await FixtureAsync();
        await using (service) try {
            var before = await File.ReadAllBytesAsync(service.Runtime.DatabasePath);
            const string id = "knowledge:operator-result";
            var intentBefore = (await service.GetRecordAsync("knowledge:operator-intent")).Record!.Json.GetProperty("data").GetProperty("intent").GetRawText();
            var review = await PrepareAsync(service, project, Draft("create", id));
            Require(review.Request is not null, "Create preparation failed: " + review.Error);
            Require((await File.ReadAllBytesAsync(service.Runtime.DatabasePath)).SequenceEqual(before), "Preparation wrote the DB.");
            var frozen = review.Request!; var exact = frozen.ExactRequestUtf8.ToArray();
            Require((await service.SaveAsync(frozen)).Saved, "Create save failed.");
            Require((await service.SaveAsync(frozen)).Saved && frozen.ExactRequestUtf8.SequenceEqual(exact), "Exact replay failed.");
            var attach = await PrepareAsync(service, project, Draft("associate", id));
            Require(attach.Request is not null && (await service.SaveAsync(attach.Request)).Saved, "Fresh association failed: " + attach.Error);
            var intent = (await service.GetRecordAsync("knowledge:operator-intent")).Record!.Json.GetProperty("data");
            Require(intent.GetProperty("intent").GetRawText() == intentBefore, "Association changed intent bytes.");
            Require(!intent.TryGetProperty("acceptance", out _), "Context-only association inferred acceptance.");
            Require(intent.GetProperty("continuation").GetProperty("context").GetProperty("requirements")[0].GetProperty("record_ids")[0].GetString() == id, "R1 association missing.");
            var noop = await PrepareAsync(service, project, Draft("associate", id)); Require(noop.Request is null && noop.Error is null, "Duplicate association was not a no-op.");
            var evidenceDraft = JsonNode.Parse(Draft("associate", id).GetRawText())!;
            evidenceDraft["acceptance_result"] = new JsonObject { ["requirement_id"] = "R1", ["status"] = "unverified", ["notes"] = "Inspect the focused output" };
            var evidence = await PrepareAsync(service, project, JsonSerializer.SerializeToElement(evidenceDraft));
            Require(evidence.Request is not null, "Evidence review missing: " + evidence.Error);
            var target = await service.GetRecordAsync(id); var targetEdit = RecordEditor.Begin(target) with { Name = "Changed after evidence review" };
            var targetReview = service.ReviewEdit(target, targetEdit); Require(targetReview.Request is not null && (await service.SaveAsync(targetReview.Request)).Saved, "Concurrent evidence edit failed.");
            var conflict = await service.SaveAsync(evidence.Request!); Require(!conflict.Saved && !conflict.MayHaveCommitted, "Stale evidence basis was accepted.");
            evidence = await PrepareAsync(service, project, JsonSerializer.SerializeToElement(evidenceDraft));
            Require(evidence.Request is not null && (await service.SaveAsync(evidence.Request)).Saved, "Fresh recorded-result association failed.");
            intent = (await service.GetRecordAsync("knowledge:operator-intent")).Record!.Json.GetProperty("data");
            var supplied = intent.GetProperty("acceptance").GetProperty("results")[0];
            var observed = await service.GetRecordAsync(id);
            Require(supplied.GetProperty("status").GetString() == "unverified" && supplied.GetProperty("evidence")[0].GetProperty("revision").GetInt64() == observed.Record!.Json.GetProperty("revision").GetInt64() &&
                supplied.GetProperty("evidence")[0].GetProperty("data_sha256").GetString()!.Length == 64, "Recorded acceptance lost explicit status or exact observed evidence revision/hash.");
            var lost = true;
            await using (var uncertain = new LodestarService(service.Runtime, async (invocation, cancellation) => {
                var actual = await service.ExecuteAsync(invocation, cancellation);
                if (lost && invocation.IsMutation && actual.Success) { lost = false; return actual with { Success = false, Envelope = null, Code = "response_delivery_failed", Message = "Injected lost response after actual commit", MayHaveCommitted = true }; }
                return actual;
            }, Path.Combine(root, "uncertain"))) {
                await uncertain.DiscoverAsync(); var uncertainReview = await PrepareAsync(uncertain, project, Draft("create", "knowledge:uncertain-result"));
                Require(uncertainReview.Request is not null, uncertainReview.Error ?? "Unknown fixture preparation failed");
                var bytes = uncertainReview.Request!.ExactRequestUtf8.ToArray();
                var unknown = await uncertain.SaveAsync(uncertainReview.Request);
                Require(!unknown.Saved && unknown.MayHaveCommitted && uncertain.PendingSaves().Count == 1, "Actual committed / lost response did not retain uncertainty.");
                var committed = await service.GetRecordAsync("knowledge:uncertain-result"); var committedRevision = committed.Revision;
                var recovered = await uncertain.RecoverAsync(uncertainReview.Request.RequestId);
                Require(recovered.Saved && uncertainReview.Request.ExactRequestUtf8.SequenceEqual(bytes) &&
                    (await service.GetRecordAsync("knowledge:uncertain-result")).Revision == committedRevision, "Exact journal replay changed request bytes or repeated the creation effect.");
            }
            await using (var malformed = new LodestarService(service.Runtime, async (invocation, cancellation) => {
                var actual = await service.ExecuteAsync(invocation, cancellation);
                if (invocation.OperationId == "work.prepare-capture" && actual.Success) {
                    var body = JsonNode.Parse(actual.Envelope!.Value.GetRawText())!; body["data"]!["write_basis"]!["targets"]![0]!["expected_revision"] = "malformed";
                    return actual with { Envelope = JsonSerializer.SerializeToElement(body) };
                } return actual;
            }, Path.Combine(root, "malformed"))) {
                await malformed.DiscoverAsync(); var invalid = await PrepareAsync(malformed, project, Draft("create", "knowledge:malformed-result"));
                Require(invalid.Request is null && invalid.Error is not null && !Directory.Exists(Path.Combine(root, "malformed")), "Malformed successful preparation reached a request journal.");
            }
            var attentionMethod = typeof(LodestarService).GetMethod("ReadAttentionAsync")!;
            var attention = await (Task<CliResult>)attentionMethod.Invoke(service, [project, "knowledge:operator-intent", CancellationToken.None])!;
            Require(attention.Success && attention.Envelope!.Value.GetProperty("data").GetProperty("sections").GetProperty("context").GetProperty("state").GetString() == "observed", "Coherent attention failed: " + attention.Message);
            Require(service.Runtime.GetType().GetProperty("CoreSourceDigest")?.GetValue(service.Runtime) is string digest && digest.Length == 64, "Exact observed core digest absent.");
            Require(service.Capabilities?.ContractVersion == 5 && service.Capabilities.SchemaVersion == 5 && service.Runtime.CoreSourceBasis == "source_inventory", "Identity conflated release and contract/schema/source support.");
            await using (var unsupported = new LodestarService(service.Runtime, async (invocation, cancellation) => {
                var actual = await service.ExecuteAsync(invocation,cancellation);
                if (invocation.OperationId == "help" && actual.Success) {
                    var body = JsonNode.Parse(actual.Envelope!.Value.GetRawText())!;
                    var operations = body["data"]!["operations"]!.AsArray();
                    foreach (var operation in operations.Where(row => row?["id"]?.GetValue<string>() is "work.prepare-capture" or "work.attention").ToArray()) operations.Remove(operation);
                    return actual with { Envelope=JsonSerializer.SerializeToElement(body) };
                } return actual;
            },Path.Combine(root,"unsupported"))) {
                await unsupported.DiscoverAsync(); var unavailable = await PrepareAsync(unsupported,project,Draft("create","knowledge:unsupported"));
                Require(unavailable.Request is null && unavailable.Error == "Selected core does not support this action." &&
                    !unsupported.SupportsOperatorRead("work.attention") && (await unsupported.GetRecordAsync(id)).Record is not null,
                    "Missing additive capabilities disabled existing exact reads or admitted capture.");
            }
            var unsafeRead = await service.ReadAttentionFollowUpAsync(project,["delete","--",id]);
            Require(!unsafeRead.Success && unsafeRead.Code == "unsupported_attention_read", "Attention admitted a write route.");
        } finally { Directory.Delete(root, true); }
    }
}
