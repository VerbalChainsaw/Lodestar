using System.Text.Json;
using Lodestar.Loader;

public static class LiteralReadChecks
{
    public static async Task RunAsync()
    {
        var failures = new List<string>();
        foreach (var (name, run) in new (string, Func<Task>)[] {
            ("record/history/raw", RecordReadsAsync), ("verified intent", IntentReadsAsync) })
        {
            try { await run(); }
            catch (Exception error) { failures.Add(name + ": " + error.Message); }
        }
        Require(failures.Count == 0, string.Join("\n", failures));
    }

    private static async Task RecordReadsAsync()
    {
        foreach (var id in new[] { "--help", "--all", "-h", "-v", "knowledge:ordinary" })
        {
            var fixture = new ReadFixture(id);
            await using var service = fixture.Service();
            var current = await service.GetRecordAsync(id);
            Require(current.Error is null && current.Record?.Id == id,
                $"Current record {id} was not returned: {current.Error}");
            var history = await service.GetHistoryAsync(id);
            Require(history.Error is null && JsonData.String(history.RawRecord!.Value, "id") == id &&
                history.History.Length == 1, $"History for {id} changed identity or read mode.");
            var raw = await service.GetRawAsync(id);
            Require(raw.Error is null && JsonData.String(raw.RawRecord!.Value, "id") == id,
                $"Raw read for {id} changed identity.");
            Require(fixture.Reads.Count == 3 && fixture.Reads.All(read => !read.IsMutation),
                "A direct read became a mutation or was omitted.");
        }
    }

    private static async Task IntentReadsAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-literal-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (var id in new[] { "--help", "--all", "-h", "-v", "knowledge:ordinary" })
            {
                var fixture = new ReadFixture(id, root);
                await using var service = fixture.Service();
                await service.DiscoverAsync();
                var catalog = RecordProjection.ReadRecord(Parse(JsonSerializer.Serialize(new {
                    id = "project:literal", kind = "project", scope = "project:literal", data = new { roots = new[] { root } }
                })))!;
                var project = new ProjectSummary("project:literal", "Literal", "active", [root],
                    ["project:literal"], 1, 0, null, null, true, catalog);
                var checkedIntent = await service.CheckIntentAsync(project, id);
                Require(checkedIntent.Success && checkedIntent.Envelope is { } envelope &&
                    JsonData.String(envelope.GetProperty("data"), "intent_record_id") == id,
                    $"Verified intent {id} was rejected or redirected: {checkedIntent.Code}");
                var invocation = fixture.Reads.Single(read => read.OperationId == "work.check");
                Require(!invocation.IsMutation && invocation.Runtime == fixture.Runtime,
                    "Intent check changed runtime identity or effect.");
            }
        }
        finally { Directory.Delete(root); }
    }

    // Constrained independent CLI contract fixture: globals/flags are interpreted
    // before -- and every remaining token is a literal operand. Real callable
    // service paths must return the selected stored record, history/raw or intent.
    private sealed class ReadFixture(string id, string? root = null)
    {
        public RuntimeSelection Runtime { get; } = new("fixture", "generation", "node", "cli", "db", "fingerprint");
        public List<CliInvocation> Reads { get; } = [];
        public LodestarService Service() => new(Runtime, ExecuteAsync, Path.Combine(root ?? Path.GetTempPath(), "literal-unused-journal"));
        private Task<CliResult> ExecuteAsync(CliInvocation invocation, CancellationToken cancellation)
        {
            cancellation.ThrowIfCancellationRequested();
            Reads.Add(invocation);
            var args = invocation.Arguments;
            if (invocation.OperationId == "help") return Task.FromResult(Success("help", new {
                capability_version = 1, operations = new object[] { new {
                    id = "work.check", argv = new[] { "work", "check" }, effect = "read", summary = "Intent",
                    context = new { project = true, actor = false }, constraints = Array.Empty<object>(),
                    parameters = new object[] {
                        new { name = "cwd", binding = "option", flag = "--cwd", required = false, schema = new { type = "string" } },
                        new { name = "intent_record_id", binding = "positional", index = 0, required = true, schema = new { type = "string" } }
                    }
                } }
            }));
            if (invocation.OperationId == "start")
            {
                Require(args.SequenceEqual(new[] { "start", "--cwd", root! }), "Project mapping changed its exact root.");
                return Task.FromResult(Success("start", new { project = new {
                    id = "project:literal", scope = "project:literal", historical_scopes = Array.Empty<string>()
                } }));
            }
            var operands = new List<string>();
            var literal = false;
            var history = false; var raw = false; string? cwd = null;
            var leading = invocation.OperationId == "get" ? 1 : 2;
            for (var index = leading; index < args.Length; index++)
            {
                var token = args[index];
                if (!literal && token == "--") { literal = true; continue; }
                if (literal) { operands.Add(token); continue; }
                if (token == "--history") { history = true; continue; }
                if (token == "--raw") { raw = true; continue; }
                if (token == "--cwd") { cwd = args[++index]; continue; }
                Require(!token.StartsWith("--", StringComparison.Ordinal) && token is not ("-h" or "-v"),
                    $"Literal {id} became a CLI flag ({token}).");
                operands.Add(token);
            }
            Require(operands.SequenceEqual(new[] { id }), "The requested exact ID was not preserved.");
            if (invocation.OperationId == "work.check")
            {
                Require(cwd == root, "Intent check lost its verified project root.");
                return Task.FromResult(Success("work.check", new { intent_record_id = id, ready_to_review = false }));
            }
            Require(invocation.OperationId == "get", "Unexpected fixture operation.");
            if (history) return Task.FromResult(Success("get", new {
                id, current = new { raw_record = new { id, content_json = "{}" } },
                versions = new object[] { new { raw_record = new { id, content_json = "{}" } } }, write_basis = new { }
            }));
            if (raw) return Task.FromResult(Success("get", new { raw_record = new { id, content_json = "{}" }, write_basis = new { } }));
            return Task.FromResult(Success("get", new {
                id, kind = "knowledge", scope = "project:literal", availability = "known",
                semantics = new { lifecycle = "current" }, data = new { intent = new { version = 1 } }, write_basis = new { }
            }));
        }
    }

    private static CliResult Success(string operation, object data) => new(true,
        Parse(JsonSerializer.Serialize(new { v = 5, ok = true, operation, revision = 5,
            database_instance_id = "instance", database_epoch = "epoch", more = false,
            next = Array.Empty<object>(), data })), null, "OK", 0, "", 1);
    private static JsonElement Parse(string text) => JsonDocument.Parse(text).RootElement.Clone();
    private static void Require(bool condition, string message)
    { if (!condition) throw new InvalidOperationException(message); }
}
