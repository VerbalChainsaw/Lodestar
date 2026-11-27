using System.Text.Json;
using Lodestar.Loader;

internal static class ErrorCauseChecks
{
    private static void Check(bool value, string reason)
    {
        if (!value) throw new Exception(reason);
    }

    public static async Task AttributeCauseAsync()
    {
        if (!OperatingSystem.IsWindows()) throw new Exception("The actual invalid-name attribute witness requires Windows.");
        var root = Path.Combine(Path.GetTempPath(), "ll-fq01-attributes-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            // Invalid leaf is below our disposable root; no device or ACL operation is used.
            var pending = Path.Combine(root, "pending|invalid");
            IOException? observed = null;
            try { File.GetAttributes(pending); }
            catch (IOException error) when (error is not FileNotFoundException and not DirectoryNotFoundException) { observed = error; }
            Check(observed is not null, "Real File.GetAttributes must establish this filesystem failure before SaveAsync.");
            var runtime = new RuntimeSelection("fixture", "fixture", "fixture", "fixture", "fixture", "fixture");
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:fq01", set = new { name = "PRIVATE_REQUEST_BODY" }, remove = Array.Empty<string>() } });
            var frozen = new FrozenMutation(requestId, "fact:fq01", runtime, "a", "b", body, Path.Combine(pending, requestId));
            var dispatches = 0;
            await using var service = new LodestarService(runtime, (_, _) => {
                dispatches++; throw new Exception("Filesystem preflight must not dispatch.");
            }, pending);
            var result = await service.SaveAsync(frozen);
            Check(!result.Saved && result.MayHaveCommitted && result.RequiresRecovery && dispatches == 0,
                "Attribute inspection fault lost conservative pending certainty or sent a CLI call.");
            Check(result.Error?.Contains("This attempt was not sent", StringComparison.Ordinal) == true &&
                result.Error.Contains("IOException", StringComparison.Ordinal) &&
                result.Error.Contains(observed!.HResult.ToString("X8"), StringComparison.Ordinal) &&
                result.Error.Contains("Inspect Pending saves", StringComparison.Ordinal),
                "Attribute inspection error dropped its real bounded cause or corrective action: " + result.Error);
            Check(!result.Error!.Contains("PRIVATE_REQUEST_BODY", StringComparison.Ordinal) && result.Error.Length < 1024,
                "Attribute diagnostic exposed request bytes or was unbounded.");
            Check(frozen.ExactRequestUtf8.AsSpan().SequenceEqual(body), "Unsent frozen request changed.");
        }
        finally { Directory.Delete(root, true); }
    }

    public static async Task SecondaryRetentionCauseAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-fq01-retention-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var cli = Path.Combine(root, "lodestar.mjs"); File.WriteAllText(cli, "export {};");
            var database = Path.Combine(root, "fixture.db"); File.WriteAllText(database, "fixture");
            var config = Path.Combine(root, "interfaces.json");
            File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1, generation = Guid.NewGuid().ToString("D"),
                runtime = new { node = TestNodeRuntime.Resolve(), cli, database }, loader = "Lodestar.Loader.exe" }));
            var runtime = await RuntimeConfig.LoadAsync(config);
            var pending = Path.Combine(root, "pending");
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var journal = Path.Combine(pending, requestId);
            var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
                input = new { mode = "update", id = "fact:fq01", set = new { name = "PRIVATE_REQUEST_BODY" }, remove = Array.Empty<string>() } });
            var frozen = new FrozenMutation(requestId, "fact:fq01", runtime, "a", "b", body, journal);
            var writes = 0;
            await using var service = new LodestarService(runtime, (invocation, _) => {
                if (invocation.OperationId == "find")
                {
                    using var document = JsonDocument.Parse("""{"v":5,"ok":true,"operation":"find","revision":1,"database_instance_id":"a","database_epoch":"b","more":false,"next":[],"data":{}}""");
                    return Task.FromResult(new CliResult(true, document.RootElement.Clone(), null, "OK", 0, "", 1));
                }
                Check(invocation.OperationId == "put" && invocation.IsMutation, "Unexpected CLI leaf.");
                writes++;
                Check(File.ReadAllBytes(invocation.RequestFilePath!).AsSpan().SequenceEqual(body), "Actual dispatch lost exact request.");
                File.WriteAllText(Path.Combine(journal, "context.json"), "{malformed PRIVATE_REQUEST_BODY");
                throw new IOException("FQ01 primary transport failure");
            }, pending);
            var result = await service.SaveAsync(frozen);
            Check(writes == 1 && !result.Saved && result.MayHaveCommitted && result.RequiresRecovery && result.Cli is null,
                "Dispatched failure was settled or lost uncertainty.");
            Check(File.ReadAllBytes(Path.Combine(journal, "request.json")).AsSpan().SequenceEqual(body) &&
                !File.Exists(Path.Combine(journal, "response.json")), "Exact pending request was altered or a response was fabricated.");
            Check(File.ReadAllText(Path.Combine(journal, "context.json")) == "{malformed PRIVATE_REQUEST_BODY",
                "Failed retention replaced the malformed evidence.");
            Check(result.Error?.Contains("FQ01 primary transport failure", StringComparison.Ordinal) == true &&
                result.Error.Contains("Unknown-outcome retention failed", StringComparison.Ordinal) &&
                (result.Error.Contains("JsonException", StringComparison.Ordinal) || result.Error.Contains("InvalidDataException", StringComparison.Ordinal)) &&
                result.Error.Contains("Inspect the pending request", StringComparison.Ordinal),
                "Save dropped primary/secondary cause or recovery action: " + result.Error);
            Check(!result.Error!.Contains("PRIVATE_REQUEST_BODY", StringComparison.Ordinal) && result.Error.Length < 1024,
                "Secondary diagnostic exposed malformed/request body or was unbounded.");
            var listed = service.PendingSaves().Single();
            Check(!listed.ReplayEligible && listed.RequestId == requestId,
                "Malformed context remained eligible for automatic replay.");
        }
        finally { Directory.Delete(root, true); }
    }
}
