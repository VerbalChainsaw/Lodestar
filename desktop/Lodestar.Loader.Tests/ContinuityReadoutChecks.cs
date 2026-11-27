using System.Collections.Immutable;
using System.Text.Json.Nodes;
using System.Text.Json;
using Lodestar.Loader;

public static class ContinuityReadoutChecks
{
    private static readonly RuntimeSelection Runtime = new("fixture", "generation", "node", "cli", "db", "fingerprint");
    public static async Task VersionAsync()
    {
        foreach (var value in new object?[] { "3.1.0-preview+abc", null, 3, "", "   ", "v3\nforged", new { version = "3" } })
        {
            var calls = new List<CliInvocation>();
            await using var service = new LodestarService(Runtime, (invocation, _) => {
                calls.Add(invocation);
                return Task.FromResult(Reply("help", new { version = value, capability_version = 1, operations = Array.Empty<object>() }));
            }, Path.Combine(Path.GetTempPath(), "continuity-unused"));
            var capabilities = await service.DiscoverAsync();
            var expected = value is string text && text == "3.1.0-preview+abc" ? text : "Not reported";
            var health = LodestarHealth.Build(null, capabilities, null);
            Require(health.Observations.Single(o => o.Label == "Lodestar release version").Value == expected,
                "Actual help version did not reach health, or malformed version became a claim.");
            Require(health.Observations.Single(o => o.Label == "Capability contract").Value == "1" &&
                health.Observations.Single(o => o.Label == "Runtime generation").Value == "generation", "Version meanings were conflated.");
            Require(calls.Count == 1 && calls[0].Arguments.SequenceEqual(new[] { "--help" }), "Version caused an extra CLI call.");
        }
        var fail = false;
        await using var switching = new LodestarService(Runtime, (_, _) => Task.FromResult(fail
            ? new CliResult(false, null, "fixture", "Discovery failed", 1, "", 0)
            : Reply("help", new { version = "3.1.0", capability_version = 1, operations = Array.Empty<object>() })),
            Path.Combine(Path.GetTempPath(), "continuity-unused"));
        await switching.DiscoverAsync(); fail = true;
        var changed = await switching.DiscoverAsync(Runtime with { Generation = "other", CliPath = "other-cli" });
        Require(LodestarHealth.Build(null, changed, null).Observations.Single(o => o.Label == "Lodestar release version").Value == "Not reported",
            "A failed selected-runtime discovery retained the previous release.");
        var first = new TaskCompletionSource<CliResult>(); var call = 0;
        await using var concurrent = new LodestarService(Runtime, (_, _) => ++call == 1 ? first.Task : Task.FromResult(
            Reply("help", new { capability_version = 1, operations = Array.Empty<object>() })), Path.Combine(Path.GetTempPath(), "continuity-unused"));
        var older = concurrent.DiscoverAsync();
        var newer = await concurrent.DiscoverAsync(Runtime with { Generation = "new-runtime" });
        first.SetResult(Reply("help", new { version = "old-release", capability_version = 1, operations = Array.Empty<object>() }));
        await older;
        Require(concurrent.Capabilities?.Runtime.Generation == "new-runtime" && concurrent.Capabilities.ReleaseVersion is null,
            "Obsolete discovery repainted the selected runtime release.");
    }

    public static async Task ReadsAsync()
    {
        var root = Path.GetTempPath();
        var catalog = RecordProjection.ReadRecord(Json(new { id = "project:one", kind = "project", scope = "scope:one" }))!;
        var project = new ProjectSummary("project:one", "One", "active", [root], ["scope:one"], 1, 0, null, null, true, catalog);
        var calls = new List<CliInvocation>();
        await using var service = new LodestarService(Runtime, (invocation, _) => {
            calls.Add(invocation);
            return Task.FromResult(invocation.OperationId == "start"
                ? Reply("start", new { project = new { id = project.Id, scope = "scope:one", historical_scopes = Array.Empty<string>() } })
                : Reply(invocation.OperationId, new { observed = invocation.Arguments.ToArray() }));
        }, Path.Combine(Path.GetTempPath(), "continuity-unused"));
        Task<CliResult> Read(string[] args) => service.ReadContinuityAsync(project, args.ToImmutableArray());
        foreach (var args in new[] { new[] { "put", "--file", "attack" }, new[] { "get", "--db", "foreign", "--", "id" },
            new[] { "get", "--", "id", "other" }, new[] { "decision", "show", "--cwd", "foreign-root", "--", "key" } })
        {
            var before = calls.Count;
            Require(!(await Read(args)).Success && calls.Count == before, "Unsupported read dispatched a command.");
        }
        var literal = new[] { "get", "--", "--help; Ω" };
        Require((await Read(literal)).Success && calls.Last().Arguments.SequenceEqual(literal) && calls.Last().Runtime == Runtime && !calls.Last().IsMutation,
            "Literal get changed operand/runtime/effect.");
        var raw = new[] { "get", "--raw", "--", "damaged:Ω" };
        Require((await Read(raw)).Success && calls.Last().Arguments.SequenceEqual(raw) && !calls.Last().IsMutation,
            "Quarantined source raw read changed operand or effect.");
    }

    public static Task ReadoutAsync()
    {
        var data = Json(new { continuity = new { version = 1, association_mode = "explicit", active_requirement_ids = new[] { "R-last" },
            complete = false, truncated = false, records = new[] { new { id = "rejection:idle", revision = 7,
                data = new { reason = "System impact" }, semantics = new { lifecycle = "current" },
                selection = new { reasons = new[] { "orientation" }, requirement_ids = Array.Empty<string>() } } },
            decisions = new[] { new { key = "route", resolution = "current", current = new { event_id = "event:new", revision = 8, reason = "Reuse owner", status = "active", value = "One shot" } } },
            issues = new[] { new { code = "missing_context", message = "Missing research:gap", action = "Inspect gap" } },
            read_required = new[] { new { target_id = "research:gap", requirement_ids = new[] { "R-last" }, code = "missing_context", action = "Read gap", read_args = new[] { "get", "--", "research:gap" } } } } });
        var text = IntentContinuityReadout.Format(data);
        foreach (var fragment in new[] { "R-last", "System impact", "revision 7", "Reuse owner", "event:new", "research:gap", "incomplete", "delivered" })
            Require(text.Contains(fragment, StringComparison.OrdinalIgnoreCase), "Readout dropped " + fragment);
        var absent = IntentContinuityReadout.Format(Json(new { }));
        var unknown = IntentContinuityReadout.Format(Json(new { continuity = new { version = 99 } }));
        Require(absent.Contains("unknown", StringComparison.OrdinalIgnoreCase) && unknown.Contains("unknown", StringComparison.OrdinalIgnoreCase), "Legacy/unknown extension claimed coverage.");
        foreach (var malformed in new[] { "null-row", "write", "missing-read" })
        {
            var altered = JsonNode.Parse(data.GetRawText())!; altered["continuity"]!["complete"] = true;
            if (malformed == "null-row") altered["continuity"]!["records"]!.AsArray().Add((JsonNode?)null);
            else altered["continuity"]!["read_required"]![0]!["read_args"] = malformed == "write" ? JsonSerializer.SerializeToNode(new[] { "put", "--file", "attack" }) : null;
            var damaged = JsonSerializer.SerializeToElement(altered);
            Require(IntentContinuityReadout.Format(damaged).Contains("coverage: unknown", StringComparison.OrdinalIgnoreCase) &&
                IntentContinuityReadout.Reads(damaged, Path.GetTempPath()).IsEmpty, "Malformed required metadata claimed coverage or offered runnable reads.");
        }
        var bounded = JsonNode.Parse(data.GetRawText())!; bounded["continuity"]!["active_requirement_ids"] = new JsonArray();
        bounded["continuity"]!["active_requirement_ids_omitted"] = 5;
        Require(IntentContinuityReadout.Format(JsonSerializer.SerializeToElement(bounded)).Contains("IDs omitted"), "Omitted active IDs were confused with deliberate empty selection.");
        return Task.CompletedTask;
    }
    public static Task DepthsAsync()
    {
        var rows = Enumerable.Range(0, 12000).Select(index => Json(new { id = "R" + index, parent_id = index == 0 ? null : "R" + (index - 1) })).Reverse().ToArray();
        var depths = IntentContinuityReadout.RequirementDepths(rows);
        Require(depths.Count == rows.Length && depths["R11999"] == 11999 && depths["R0"] == 0, "Deep reverse chain lost depth or order identity.");
        var branching = new[] { Json(new { id = "leaf", parent_id = "root" }), Json(new { id = "other", parent_id = "root" }), Json(new { id = "root" }) };
        var branchDepths = IntentContinuityReadout.RequirementDepths(branching);
        Require(branchDepths["leaf"] == 1 && branchDepths["other"] == 1 && branchDepths["root"] == 0, "Shared ancestor depth changed.");
        var cycle = IntentContinuityReadout.RequirementDepths([Json(new { id = "a", parent_id = "b" }), Json(new { id = "b", parent_id = "a" })]);
        Require(cycle.Count == 2 && cycle.Values.All(depth => depth < 2), "Malformed cycle did not remain bounded.");
        return Task.CompletedTask;
    }
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    private static CliResult Reply(string operation, object data) => new(true, Json(new { v = 5, ok = true, operation,
        data, revision = 7, more = false, next = Array.Empty<object>() }), null, "OK", 0, "", 0);
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
}
