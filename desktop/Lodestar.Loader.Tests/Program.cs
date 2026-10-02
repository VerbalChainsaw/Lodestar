using System.Text.Json;
using System.Text.Json.Nodes;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Collections.Immutable;
using Lodestar.Loader;

var checks = new List<(string Name, Func<Task> Run)>();
string TestNode() => TestNodeRuntime.Resolve();
void Add(string name, Func<Task> run) => checks.Add((name, run));
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
JsonElement Parse(string text) => JsonDocument.Parse(text).RootElement.Clone();
LibraryRecord Row(string text) => RecordProjection.ReadRecord(Parse(text))!;
CliResult SuccessResult(string operation, object data, long revision = 5, bool more = false,
    object[]? next = null) => new(true, Parse(JsonSerializer.Serialize(new { v = 5, ok = true, operation,
        revision, database_instance_id = "a", database_epoch = "b", data, more, next = next ?? [] })),
        null, "OK", 0, "", 1);

Add("exact project association, global and ambiguous", () =>
{
    var p = Row("""{"id":"p","kind":"project","scope":"global","name":"Alpha","data":{"roots":["C:/a"],"status":"active"},"semantics":{"applicability":{"project":"project:p"}},"updated_at":"2026-09-01T00:00:00Z"}""");
    var q = Row("""{"id":"q","kind":"project","scope":"global","name":"Beta","data":{"roots":["C:/b"]},"semantics":{"applicability":{"project":"project:p"}}}""");
    var owned = Row("""{"id":"x","kind":"work","scope":"project:p","data":{"status":"open","completion":"old"},"updated_at":"2026-09-02T00:00:00Z"}""");
    var global = Row("""{"id":"g","kind":"note","scope":"global","data":{},"semantics":{"applicability":{"project":null}}}""");
    var projected = RecordProjection.Build([p, q], [p, q, owned, global], true);
    Check(projected.Unassigned.Any(r => r.Id == "x"), "Ambiguous same-scope ownership was assigned.");
    Check(projected.Global.Any(r => r.Id == "g"), "Null-global fact was assigned to a project.");
    var single = RecordProjection.Build([p], [p, owned, global], true);
    Check(single.Projects.Single().CurrentRecordCount == 1, "Exact owned count is wrong.");
    Check(single.Projects.Single().RecordedOpenWorkCount == 1, "Recorded open work was lost.");
    Check(single.Projects.Single().LatestRecordId == "x", "Latest current timestamp was wrong.");
    LibrarySnapshot Snapshot((ImmutableArray<ProjectSummary> Projects, ImmutableArray<LibraryRecord> Global,
        ImmutableArray<LibraryRecord> Unassigned) projection, ImmutableArray<LibraryRecord> rows) =>
        new(projection.Projects, rows, projection.Global, projection.Unassigned, "a", "b", 1,
            DateTimeOffset.UtcNow, true, rows.Length, [], []);
    var snapshot = Snapshot(single, [p, owned, global]);
    var rows = RecordProjection.AssociatedRecords(snapshot, single.Projects.Single());
    Check(rows.Select(r => r.Id).SequenceEqual(new[] { "p", "x" }), "Association membership/order changed.");
    Check(rows == RecordProjection.AssociatedRecords(snapshot, single.Projects.Single()),
        "Repeated project reads rebuilt the association instead of reusing the snapshot projection.");
    var ambiguous = Snapshot(projected, [p, q, owned, global]);
    Check(RecordProjection.AssociatedRecords(ambiguous, projected.Projects.First(r => r.Id == "p"))
        .Select(r => r.Id).SequenceEqual(new[] { "p" }), "Shared scope became assigned.");
    return Task.CompletedTask;
});

Add("ordinary shallow edit and protected project fields", () =>
{
    var record = Row("""{"id":"n","kind":"note","scope":"global","name":"Note","availability":"known","priority":2,"data":{"a":1,"b":{"old":true}},"semantics":{"lifecycle":"current"}}""");
    var baseline = new RecordSnapshot(record, Parse("""{"database_instance_id":"a","database_epoch":"b","project_scope":null,"checkout":null,"targets":[]}"""), null, [], "a", "b", 3, DateTimeOffset.UtcNow, null);
    var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
    var review = RecordEditor.Prepare(baseline, new("New", "stale", 3, """{"b":{"new":true},"c":3}"""), runtime, "C:/pending");
    Check(review.Request is not null, review.Error ?? "No frozen request.");
    var request = JsonDocument.Parse(review.Request!.ExactRequestUtf8).RootElement;
    var input = request.GetProperty("input");
    Check(input.GetProperty("set").GetProperty("data").GetProperty("b").GetProperty("new").GetBoolean(), "Nested replacement missing.");
    Check(input.GetProperty("remove")[0].GetString() == "a", "Explicit removal missing.");
    Check(input.GetProperty("set").GetProperty("name").GetString() == "New", "Name change missing.");
    var project = Row("""{"id":"p","kind":"project","scope":"global","name":"Project","availability":"known","priority":0,"data":{"roots":["C:/a"],"description":"old"}}""");
    var rejected = RecordEditor.Prepare(baseline with { Record = project }, new("Project", "known", 0,
        """{"roots":["C:/other"],"description":"new"}"""), runtime, "C:/pending");
    Check(rejected.Request is null && rejected.Error!.Contains("catalog"), "Project root edit was allowed.");
    return Task.CompletedTask;
});

Add("editor distinguishes absent, null and protected catalog fields", () =>
{
    var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
    var row = Row("""{"id":"n","kind":"note","scope":"global","data":{},"availability":"known","priority":0}""");
    var baseline = new RecordSnapshot(row, Parse("{}"), null, [], "a", "b", 1, DateTimeOffset.UtcNow, null);
    var edit = RecordEditor.Prepare(baseline, new("", "known", 0, "{\"new\":null}"), runtime, "C:/pending");
    Check(edit.Request is not null, "Unnamed record or new null field cannot be edited: " + edit.Error);
    var body = JsonDocument.Parse(edit.Request!.ExactRequestUtf8).RootElement;
    Check(body.GetProperty("input").GetProperty("set").GetProperty("data").GetProperty("new").ValueKind == JsonValueKind.Null,
        "New null-valued member was dropped.");
    var project = Row("""{"id":"p","kind":"project","scope":"global","name":"P","data":{"catalog_old":null}}""");
    foreach (var data in new[] { "{}", "{\"catalog_old\":null,\"catalog_new\":null}" })
    {
        var rejected = RecordEditor.Prepare(baseline with { Record = project }, new("P", null, null, data), runtime, "C:/pending");
        Check(rejected.Request is null && rejected.Error?.Contains("catalog") == true,
            "Protected null-member presence change was allowed.");
    }
    return Task.CompletedTask;
});

Add("transport contract, warnings, diagnostic exit, errors and failures", async () =>
{
    var node = TestNode();
    Check(File.Exists(node), "Node fixture executable missing.");
    var root = Path.Combine(Path.GetTempPath(), "ll-check-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var cli = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs");
        Check(File.Exists(cli), "Fake CLI was not copied to output.");
        var runtime = new RuntimeSelection("test", "g", node, cli, db, "f");
        await using var transport = new CliTransport();
        async Task<CliResult> Go(string op, string mode, bool mutation = false, int timeout = 3)
        {
            var previous = Environment.GetEnvironmentVariable("LODESTAR_FAKE_MODE");
            Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", mode);
            try { return await transport.ExecuteAsync(new(op, [.. op.Split('.')], runtime,
                TimeSpan.FromSeconds(timeout), mutation)); }
            finally { Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", previous); }
        }
        Check((await Go("get", "success")).Success, "Valid stdout envelope failed.");
        var warning = await Go("get", "warning");
        Check(warning.Success && warning.Diagnostics.Contains("ExperimentalWarning"), "Stderr warning lost.");
        var error = await Go("get", "error");
        Check(!error.Success && error.Code == "fixture_error" && error.Envelope is not null, "Structured stderr error lost.");
        var exit4 = await Go("doctor", "exit4");
        Check(exit4.Success && exit4.ExitCode == 4, "Diagnostic exit 4 was treated as failure.");
        Check((await Go("get", "bad")).Code == "protocol_error", "Malformed output passed.");
        Check((await Go("get", "duplicate")).Code == "protocol_error", "Duplicate envelopes passed.");
        Check((await Go("get", "overflow")).Code == "output_overflow", "Oversized output passed.");
        var timeout = await Go("put", "timeout", mutation: true, timeout: 1);
        Check(timeout.Code == "timeout" && timeout.MayHaveCommitted, "Mutation timeout was treated as rollback.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("shared contract-5 protocol cases", async () =>
{
    var node = TestNode();
    var root = Path.Combine(Path.GetTempPath(), "ll-protocol-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var cli = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs");
        var cases = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
            "cli-protocol-cases.json"))).RootElement.GetProperty("cases");
        Console.WriteLine($"Shared protocol fixtures: {cases.GetArrayLength()} cases.");
        var runtime = new RuntimeSelection("test", "g", node, cli, db, "f");
        await using var transport = new CliTransport();
        foreach (var entry in cases.EnumerateArray())
        {
            var id = entry.GetProperty("id").GetString()!;
            var operation = entry.GetProperty("operation").GetString()!;
            var effect = entry.GetProperty("effect").GetString();
            var expected = entry.GetProperty("expect");
            var arguments = entry.GetProperty("args").EnumerateArray().Select(a => a.GetString()!).ToArray();
            var previous = Environment.GetEnvironmentVariable("LODESTAR_FAKE_MODE");
            Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", "case:" + id);
            CliResult result;
            try { result = await transport.ExecuteAsync(new(operation, [.. arguments], runtime,
                TimeSpan.FromSeconds(3), effect != "read")); }
            finally { Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", previous); }
            var kind = result.Success ? "success" : result.MayHaveCommitted &&
                effect != "read" ? "transport_error" : result.Envelope is not null ? "error" : "transport_error";
            Check(kind == expected.GetProperty("kind").GetString(), id + ": wrong kind " + kind);
            if (expected.TryGetProperty("code", out var code))
                Check(result.Code == code.GetString() || (result.Code == "protocol_error" &&
                    kind == "transport_error"), id + ": wrong code " + result.Code);
            if (expected.TryGetProperty("mayHaveCommitted", out var uncertain))
                Check(result.MayHaveCommitted == uncertain.GetBoolean(), id + ": wrong write outcome");
            if (expected.TryGetProperty("mayHaveCommitted", out var write) && write.GetBoolean())
                Check(result.Message.Contains("outcome is unknown", StringComparison.OrdinalIgnoreCase) &&
                    result.Message.Contains("saved request", StringComparison.OrdinalIgnoreCase),
                    id + ": recovery guidance missing");
            if (expected.TryGetProperty("reportedErrorCode", out var reportedCode))
                Check(result.Envelope is { } reported &&
                    reported.GetProperty("error").GetProperty("code").GetString() == reportedCode.GetString(),
                    id + ": reported commit error was discarded");
            if (kind == "error")
            {
                var error = result.Envelope!.Value.GetProperty("error");
                var action = expected.TryGetProperty("action", out var expectedAction) ? expectedAction.GetString()! :
                    "Read the current basis and resolve the saved request.";
                Check(error.GetProperty("action").GetString() == action,
                    id + ": action lost");
                Check(error.GetProperty("identifiers").GetProperty("request_id").GetString() == "ll-fixture",
                    id + ": request ID lost");
                Check(result.Message.Contains(action, StringComparison.Ordinal) &&
                    result.Message.Contains("ll-fixture", StringComparison.Ordinal),
                    id + ": action or request ID absent from user guidance");
            }
            if (id.StartsWith("semantic-", StringComparison.Ordinal)) {
                var set = entry.GetProperty("set");
                Check(result.Envelope!.Value.GetProperty("error").GetRawText() == set.GetProperty("error").GetRawText() &&
                    result.Envelope.Value.GetProperty("next").GetRawText() == set.GetProperty("next").GetRawText(),
                    id + ": full semantic error/next changed");
                Check(result.Message.Contains(expected.GetProperty("action").GetString()!, StringComparison.Ordinal),
                    id + ": core semantic action absent");
            }
            if (expected.TryGetProperty("reference", out var reference))
                Check(result.Envelope!.Value.GetProperty("data").GetProperty("reference").GetString() ==
                    reference.GetString(), id + ": opaque public reference lost");
            Check(!result.Diagnostics.Contains("PRIVATE_BODY_MARKER", StringComparison.Ordinal),
                id + ": body leaked into diagnostics");
        }
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("timeout and launch exceptions omit process bodies and local paths", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-boundary-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var cli = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs");
        var runtime = new RuntimeSelection("test", "g", TestNode(), cli, db, "f");
        await using var transport = new CliTransport(new DiagnosticLog(Path.Combine(root, "diagnostics")), null);
        var previous = Environment.GetEnvironmentVariable("LODESTAR_FAKE_MODE");
        Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", "timeout-secret");
        CliResult timedOut;
        try { timedOut = await transport.ExecuteAsync(new("put", ["put"], runtime,
            TimeSpan.FromSeconds(1), true)); }
        finally { Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", previous); }
        Check(timedOut.Code == "timeout" && timedOut.MayHaveCommitted, "Dispatched timeout lost unknown-write state.");
        Check(!timedOut.Diagnostics.Contains("PRIVATE_BODY_MARKER", StringComparison.Ordinal) &&
            timedOut.Diagnostics.Contains("ExperimentalWarning", StringComparison.Ordinal),
            "Timeout leaked the child's stderr body or lost the warning type.");

        var badNode = Path.Combine(root, "bad-node-PRIVATE_BODY_MARKER.exe");
        File.WriteAllText(badNode, "not an executable");
        var failed = await transport.ExecuteAsync(new("get", ["get"],
            runtime with { NodePath = badNode }, TimeSpan.FromSeconds(3)));
        Check(failed.Code == "transport_error" && !failed.MayHaveCommitted,
            "Start exception was not classified as an unsent transport error.");
        Check(!failed.Message.Contains("PRIVATE_BODY_MARKER", StringComparison.Ordinal) &&
            failed.Message.Contains("configured Node", StringComparison.OrdinalIgnoreCase),
            "Start exception leaked a local path or lacked safe runtime guidance.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("output overflow stops an owned hung write promptly", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-overflow-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var cli = Path.Combine(AppContext.BaseDirectory, "fake-cli.mjs");
        var runtime = new RuntimeSelection("test", "g", TestNode(), cli, db, "f");
        await using var transport = new CliTransport();
        var previous = Environment.GetEnvironmentVariable("LODESTAR_FAKE_MODE");
        Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", "overflow-hang");
        CliResult result;
        try { result = await transport.ExecuteAsync(new("put", ["put"], runtime,
            TimeSpan.FromSeconds(10), true)); }
        finally { Environment.SetEnvironmentVariable("LODESTAR_FAKE_MODE", previous); }
        Check(result.Code == "output_overflow" && result.MayHaveCommitted,
            "Overflow did not retain the unknown write outcome: " + result.Code);
        Check(result.ElapsedMilliseconds < 5000,
            "Overflow left the owned child alive until the deadline: " + result.ElapsedMilliseconds);
        Check(!result.Diagnostics.Contains("PRIVATE_BODY_MARKER", StringComparison.Ordinal),
            "Overflow copied process body into diagnostics.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("transport close drains admitted work and never dispatches queued writes", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-close-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    var owned = new List<(int Id, Process Handle)>();
    var admitted = new List<Task<CliResult>>();
    Exception? primaryFailure = null;
    Task ObserveStart(Process process)
    {
        var observed = Process.GetProcessById(process.Id);
        _ = observed.SafeHandle;
        lock (owned) owned.Add((process.Id, observed));
        return Task.CompletedTask;
    }
    Task<CliResult> Track(Task<CliResult> operation) { admitted.Add(operation); return operation; }
    try
    {
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var cli = Path.Combine(root, "held.mjs");
        File.WriteAllText(cli, "import fs from 'node:fs'; fs.writeFileSync(process.argv.at(-1), 'started'); setTimeout(() => {}, 30000);");
        var runtime = new RuntimeSelection("test", "g", TestNode(), cli, db, "f");
        await using var transport = new CliTransport(null, ObserveStart);
        Task<CliResult> Go(string marker, bool write = false) => Track(transport.ExecuteAsync(
            new(write ? "put" : "get", [Path.Combine(root, marker)], runtime, TimeSpan.FromSeconds(10), write)));
        var first = Go("first"); var second = Go("second");
        var ready = Stopwatch.StartNew();
        while (!File.Exists(Path.Combine(root, "first")) || !File.Exists(Path.Combine(root, "second")))
        {
            Check(ready.Elapsed < TimeSpan.FromSeconds(5), "Controlled children did not start.");
            await Task.Delay(10);
        }
        using var callerCancellation = new CancellationTokenSource();
        var cancelled = Track(transport.ExecuteAsync(new("put", [Path.Combine(root, "cancelled-write")],
            runtime, TimeSpan.FromSeconds(10), true), callerCancellation.Token));
        callerCancellation.Cancel();
        var unsent = await cancelled;
        Check(unsent.Code == "cancelled" && !unsent.MayHaveCommitted &&
            !File.Exists(Path.Combine(root, "cancelled-write")), "Caller-cancelled queued write dispatched.");
        var queued = Go("queued-write", true);
        await transport.DisposeAsync();
        Check(first.IsCompleted && second.IsCompleted && queued.IsCompleted, "Dispose did not drain calls.");
        var result = await queued;
        await Task.WhenAll(first, second);
        Check(result.Code == "closing" && !result.MayHaveCommitted,
            "Queued write dispatched or was misclassified during close: " + result.Code + "/" + result.MayHaveCommitted);
        Check(!File.Exists(Path.Combine(root, "queued-write")), "Queued write child started.");

        await using var failing = new CliTransport(new DiagnosticLog(Path.Combine(root, "diagnostics")), null);
        var failed = await failing.ExecuteAsync(new("get", ["get"], runtime with { NodePath = db }, TimeSpan.FromSeconds(1)));
        Check(failed.Code == "transport_error" && !failed.MayHaveCommitted, "Launch failure escaped structured error handling.");

        await using var writing = new CliTransport(null, ObserveStart);
        var marker = Path.Combine(root, "dispatched-write");
        var dispatched = Track(writing.ExecuteAsync(new("put", [marker], runtime, TimeSpan.FromSeconds(10), true)));
        ready.Restart();
        while (!File.Exists(marker))
        {
            Check(ready.Elapsed < TimeSpan.FromSeconds(5), "Mutation fixture did not start.");
            await Task.Delay(10);
        }
        await writing.DisposeAsync();
        var uncertain = await dispatched;
        Check(uncertain.Code == "closing" && uncertain.MayHaveCommitted,
            "Close claimed an already-dispatched mutation was certainly unsent.");
    }
    catch (Exception error) { primaryFailure = error; throw; }
    finally
    {
        try
        {
            // Teardown observes the same operation tasks even after an assertion
            // fails; it does not replace the immediate Dispose completion check.
            await Task.WhenAll(admitted);
            var live = owned.Where(process => !process.Handle.HasExited).Select(process => process.Id).ToArray();
            Console.WriteLine($"Fixture cleanup close: primary={primaryFailure?.Message ?? "none"}, ownedPids={string.Join(',', owned.Select(process => process.Id))}, livePids={string.Join(',', live)}, root={root}");
            Check(live.Length == 0, "Owned close fixture processes survived disposal: " + string.Join(',', live));
            foreach (var process in owned) process.Handle.Dispose();
            Directory.Delete(root, recursive: true);
        }
        catch (Exception cleanupError)
        {
            Console.Error.WriteLine($"Fixture cleanup close failed: HRESULT=0x{cleanupError.HResult:X8}, primary={primaryFailure?.Message ?? "none"}");
            if (primaryFailure is not null)
                throw new AggregateException("Close test and owned fixture cleanup both failed.", primaryFailure, cleanupError);
            throw;
        }
        finally { foreach (var process in owned) process.Handle.Dispose(); }
    }
});

Add("disposable core library, edit, history and exact replay", async () =>
{
    var node = TestNode();
    var root = Path.Combine(Path.GetTempPath(), "ll core λ 🚀 " + Guid.NewGuid().ToString("N"));
    var generator = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory,
        "..", "..", "..", "generate-fixture.mjs"));
    var start = new ProcessStartInfo(node) { UseShellExecute = false, RedirectStandardOutput = true,
        RedirectStandardError = true, CreateNoWindow = true };
    start.ArgumentList.Add(generator); start.ArgumentList.Add(root);
    using (var process = Process.Start(start)!)
    {
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Check(process.ExitCode == 0, "Fixture generator failed: " + await stderr + await stdout);
    }
    try
    {
        var runtime = await RuntimeConfig.LoadAsync(Path.Combine(root, "interfaces.json"));
        await using var service = new LodestarService(runtime, Path.Combine(root, "pending"));
        var capabilities = await service.DiscoverAsync();
        Check(capabilities.Version == 1 && capabilities.Operations.Any(o => o.Id == "get"),
            "Capability handshake failed: " + capabilities.Error);
        var library = await service.LoadLibraryAsync();
        Check(library.Error is null && library.Complete, "Library incomplete: " + library.Error + " " + string.Join(' ', library.Advisories));
        var project = library.Projects.Single(p => p.Id == "project:loader-fixture");
        Check(project.CurrentRecordCount >= 2 && project.RecordedStatus == "active", "Project summary lost facts.");
        Check(library.GlobalKnowledge.Any(r => r.Id == "fact:loader-global"), "Global fact was misassigned.");
        var context = await service.ValidateProjectContextAsync(project);
        Check(context.Matched, "Fresh root mapping diverged: " + context.Error);
        var intentId = "knowledge:loader-intent";
        var missingIntent = await service.ExecuteAsync(new CliInvocation("get", ["get", intentId], runtime,
            TimeSpan.FromSeconds(30)));
        Check(missingIntent.Envelope is { } missingEnvelope &&
            missingEnvelope.GetProperty("error").GetProperty("code").GetString() == "record_not_found",
            "Disposable intent fixture was not absent.");
        var projectWork = await service.ReadProjectDomainAsync(project, "work.status");
        Check(projectWork.Success && projectWork.Envelope is not null, "Project write basis could not be read.");
        var intentBasis = JsonNode.Parse(projectWork.Envelope!.Value.GetProperty("data")
            .GetProperty("write_basis").GetRawText())!.AsObject();
        Check(intentBasis["project_scope"]!.GetValue<string>() == project.Id &&
            !string.IsNullOrWhiteSpace(intentBasis["checkout"]!.GetValue<string>()),
            "Scoped fixture create has no resolved project binding.");
        foreach (var target in missingIntent.Envelope!.Value.GetProperty("error")
            .GetProperty("identifiers").GetProperty("write_basis").GetProperty("targets").EnumerateArray())
            intentBasis["targets"]!.AsArray().Add(JsonNode.Parse(target.GetRawText()));
        var intentBody = new {
            v = 5, request_id = "loader-plan-" + Guid.NewGuid().ToString("N"), write_basis = intentBasis,
            input = new { mode = "create", record = new {
                id = intentId, kind = "knowledge", name = "Loader plan", scope = project.Id,
                availability = "known", priority = 1, aliases = Array.Empty<string>(),
                links = Array.Empty<string>(), sources = Array.Empty<string>(),
                data = new { intent = new { version = 1, brief = "Inspect supplied evidence",
                    user_reference = "Disposable native fixture", requirements = new[] {
                        new { id = "R1", text = "Read a selected plan", acceptance = "Inspect the public report" }
                    }, boundaries = Array.Empty<string>(), non_goals = Array.Empty<string>() } },
                semantics = new { lifecycle = "current", context_role = "on_demand", basis = "asserted",
                    applicability = new { project = project.Id, checkout = (string?)null } }
            } }
        };
        var intentFile = Path.Combine(root, "loader-intent-create.json");
        await File.WriteAllTextAsync(intentFile, JsonSerializer.Serialize(intentBody));
        var intentPut = await service.ExecuteAsync(new CliInvocation("put", ["put", "--file", intentFile],
            runtime, TimeSpan.FromSeconds(30), true, intentFile));
        Check(intentPut.Success, "Disposable intent record creation failed: " + intentPut.Message);
        var intentCheck = await service.CheckIntentAsync(project, intentId);
        Check(intentCheck.Success && intentCheck.Envelope is { } report &&
            report.GetProperty("operation").GetString() == "work.check" &&
            report.GetProperty("data").GetProperty("plan").GetProperty("requirements")[0]
                .GetProperty("id").GetString() == "R1" &&
            !report.GetProperty("data").GetProperty("ready_to_review").GetBoolean() &&
            report.GetProperty("data").GetProperty("delta").GetProperty("requirements")[0]
                .GetProperty("status").GetString() == "not_started",
            "Real CLI work.check did not return the recorded plan and missing-evidence delta.");
        var rejectedCheck = await service.CheckIntentAsync(project, "fact:loader-editable");
        Check(!rejectedCheck.Success && rejectedCheck.Code == "invalid_intent_selection",
            "Non-intent record reached work.check.");
        var wrongRoot = Path.Combine(Path.GetDirectoryName(root)!, "ll-unmapped-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(wrongRoot);
        var wrongContext = await service.CheckIntentAsync(project with { Roots = [wrongRoot] }, intentId);
        Directory.Delete(wrongRoot);
        Check(!wrongContext.Success && wrongContext.Code == "project_context_mismatch",
            "Mismatched project root reached work.check.");
        var baseline = await service.GetRecordAsync("fact:loader-editable");
        Check(baseline.Error is null && baseline.WriteBasis is not null, "Fresh edit basis missing.");
        var review = service.ReviewEdit(baseline, new("Editable fixture fact", "known", 1,
            """{"description":"Edited through Loader service.","nested":{"version":2},"added":true}"""));
        Check(review.Request is not null, review.Error ?? "Edit request was not frozen.");
        var saved = await service.SaveAsync(review.Request!);
        Check(saved.Saved, "Save failed: " + saved.Error + " " + saved.Cli?.Code);
        var latest = await service.GetRecordAsync("fact:loader-editable");
        Check(latest.Record?.Json.GetProperty("data").GetProperty("added").GetBoolean() == true,
            "Fresh read does not contain saved data.");
        Check(!latest.Record!.Json.GetProperty("data").TryGetProperty("notes", out _),
            "Explicit removal did not apply.");
        var history = await service.GetHistoryAsync("fact:loader-editable");
        Check(history.History.Length > 0, "No retained before-image after save.");
        Check(history.DecodedHistory.Length > 0 && history.DecodedHistory[0].StoredContent is not null &&
            history.DecodedHistory[0].ReplacingReceiptRevision > history.DecodedHistory[0].StoredRecordRevision,
            "History labels confused replacing receipt and stored record revisions.");
        var replay = await service.SaveAsync(review.Request!);
        Check(replay.Saved, "Saved response did not settle successfully: " + replay.Error);
        File.Delete(Path.Combine(review.Request!.JournalDirectory, "response.json"));
        Check(service.PendingSaves().Any(p => p.RequestId == review.Request.RequestId &&
            p.ReplayEligible && p.Issue is null), "Lost-response request is not recoverable.");
        var exactReplay = await service.RecoverAsync(review.Request.RequestId);
        Check(exactReplay.Saved, "Exact replay did not settle successfully: " + exactReplay.Error);
        var afterReplay = await service.GetRecordAsync("fact:loader-editable");
        Check(afterReplay.Revision == latest.Revision, "Exact replay applied the mutation twice.");
        File.Delete(Path.Combine(review.Request.JournalDirectory, "response.json"));
        var legacyContextFile = Path.Combine(review.Request.JournalDirectory, "context.json");
        var legacyContext = JsonNode.Parse(File.ReadAllText(legacyContextFile))!.AsObject();
        foreach (var key in new[] { "operation", "project_root", "project_id", "project_scope", "dispatch_sha256" })
            legacyContext.Remove(key);
        File.WriteAllText(legacyContextFile, legacyContext.ToJsonString());
        Check(service.PendingSaves().Any(item => item.RequestId == review.Request.RequestId &&
            item.OperationId == "put" && item.ReplayEligible) &&
            (await service.RecoverAsync(review.Request.RequestId)).Saved,
            "Existing put journal without action metadata lost exact replay.");
        var newRoot = Path.Combine(root, "operator project");
        Directory.CreateDirectory(newRoot);
        var projectReview = await service.PrepareOperatorActionAsync("project",
            new Dictionary<string, string> { ["author"] = "director", ["name"] = "Operator project",
                ["root"] = newRoot }, null);
        Check(projectReview.Request is not null, "Project preparation failed: " + projectReview.Error);
        using (var preparedBody = JsonDocument.Parse(projectReview.Request!.ExactRequestUtf8))
            Check(preparedBody.RootElement.GetProperty("actor").GetProperty("id").GetString() == "user:director" &&
                preparedBody.RootElement.GetProperty("actor").GetProperty("agent").GetString() == "human" &&
                preparedBody.RootElement.GetProperty("actor").GetProperty("session").ValueKind == JsonValueKind.Null &&
                !preparedBody.RootElement.TryGetProperty("write_basis", out _),
                "Operator action invented an agent session or used actor-less basis shorthand.");
        Check((await service.SaveAsync(projectReview.Request!)).Saved, "Operator project did not save.");
        var createdProject = await service.GetRecordAsync(projectReview.Request!.RecordId);
        Check(createdProject.Record?.Kind == "project" &&
            string.Equals(Path.GetFullPath(createdProject.Record!.Json.GetProperty("data")
                .GetProperty("roots")[0].GetString()!), newRoot, StringComparison.OrdinalIgnoreCase),
            "Created project did not retain the selected root.");
        foreach (var (action, values) in new[] {
            ("note", new Dictionary<string, string> { ["author"] = "director", ["name"] = "Daily note",
                ["body"] = "  Operator supplied note.\nSecond line λ  " }),
            ("research", new Dictionary<string, string> { ["author"] = "director", ["name"] = "Source note",
                ["source"] = "operator:reference", ["body"] = "  Quoted by operator\nλ and 🚀\n",
                ["claim"] = "Candidate claim",
                ["limitations"] = "Not fetched by Loader" }),
            ("rejection", new Dictionary<string, string> { ["author"] = "director", ["name"] = "Rejected option",
                ["subject"] = "cache", ["reason"] = "Fresh read is simpler" }) })
        {
            var prepared = await service.PrepareOperatorActionAsync(action, values, project);
            Check(prepared.Request is not null, action + " preparation failed: " + prepared.Error);
            var outcome = await service.SaveAsync(prepared.Request!);
            Check(outcome.Saved, action + " save failed: " + outcome.Error);
            var read = await service.GetRecordAsync(prepared.Request!.RecordId);
            Check(read.Record?.Kind == action && read.Record.Scope == project.Id,
                action + " did not create a scoped record.");
            if (action == "research")
                Check(read.Record!.Json.GetProperty("data").GetProperty("body").GetString() == values["body"] &&
                    read.Record.Json.GetProperty("data").GetProperty("acquisition").GetString() == "operator_supplied" &&
                    read.Record.Json.GetProperty("sources").GetArrayLength() == 0 &&
                    read.Record.Json.GetProperty("data").GetProperty("body_sha256").GetString() ==
                        Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(values["body"])))
                            .ToLowerInvariant(),
                    "Research claimed to have fetched its operator supplied source.");
        }
        var wrongRootReview = await service.PrepareOperatorActionAsync("note",
            new Dictionary<string, string> { ["author"] = "director", ["name"] = "Wrong root guard",
                ["body"] = "Do not dispatch" }, project);
        Check(wrongRootReview.Request is not null, "Guard fixture did not prepare: " + wrongRootReview.Error);
        var changedBody = JsonNode.Parse(wrongRootReview.Request!.ExactRequestUtf8)!.AsObject();
        changedBody["checkout"] = newRoot;
        var wrongRootRequest = wrongRootReview.Request with { ProjectRoot = newRoot,
            ExactRequestUtf8 = JsonSerializer.SerializeToUtf8Bytes(changedBody) };
        var wrongRootSave = await service.SaveAsync(wrongRootRequest);
        Check(!wrongRootSave.Saved && !wrongRootSave.MayHaveCommitted &&
            !File.Exists(Path.Combine(wrongRootRequest.JournalDirectory, "request.json")),
            "Rebound project root reached journal or mutation dispatch.");
        var decisionReview = await service.PrepareOperatorActionAsync("decision",
            new Dictionary<string, string> { ["author"] = "director", ["key"] = "operator-choice",
                ["value"] = "A", ["reason"] = "Explicit preference", ["reference"] = "operator statement",
                ["instruction"] = "Use A" }, project);
        Check(decisionReview.Request is not null, "Decision preparation failed: " + decisionReview.Error);
        var decisionSave = await service.SaveAsync(decisionReview.Request!);
        Check(decisionSave.Saved, "Human decision did not save: " + decisionSave.Error);
        var decisionRead = await service.ReadProjectDomainAsync(project, "decision.show", decisionKey: "operator-choice");
        Check(decisionRead.Success && decisionRead.Envelope is { } decisionEnvelope &&
            decisionEnvelope.GetProperty("data").GetProperty("facts")
            .EnumerateArray().Any(item => item.GetProperty("key").GetString() == "operator-choice"),
            "Human decision did not appear in a public decision read.");
        var selectedRoot = project.Roots.First();
        var decisionJournal = decisionReview.Request!.JournalDirectory;
        File.Delete(Path.Combine(decisionJournal, "response.json"));
        var decisionContextFile = Path.Combine(decisionJournal, "context.json");
        var originalDecisionContext = File.ReadAllText(decisionContextFile);
        var changedDecisionContext = JsonNode.Parse(originalDecisionContext)!.AsObject();
        changedDecisionContext["operation"] = "pending.drop";
        File.WriteAllText(decisionContextFile, changedDecisionContext.ToJsonString());
        var tampered = service.PendingSaves().Single(item => item.RequestId == decisionReview.Request.RequestId);
        Check(!tampered.ReplayEligible && !(await service.RecoverAsync(tampered.RequestId)).Saved,
            "Changed journal operation was replayable.");
        File.WriteAllText(decisionContextFile, originalDecisionContext);
        changedDecisionContext = JsonNode.Parse(originalDecisionContext)!.AsObject();
        changedDecisionContext["project_root"] = newRoot;
        File.WriteAllText(decisionContextFile, changedDecisionContext.ToJsonString());
        Check(!service.PendingSaves().Single(item => item.RequestId == decisionReview.Request.RequestId)
            .ReplayEligible && !(await service.RecoverAsync(decisionReview.Request.RequestId)).Saved,
            "Changed journal root was replayable.");
        File.WriteAllText(decisionContextFile, originalDecisionContext);
        Check(service.PendingSaves().Any(item => item.RequestId == decisionReview.Request.RequestId &&
            item.ReplayEligible && item.OperationId == "decision.set" && item.ProjectRoot == selectedRoot),
            "Exact decision journal lost its operation or root.");
        Check((await service.RecoverAsync(decisionReview.Request.RequestId)).Saved,
            "Exact human decision replay failed after restoring its journal.");

        var pendingId = "pending:operator-" + Guid.NewGuid().ToString("N");
        var startBasis = (await service.StartProjectAsync(selectedRoot)).Envelope!.Value
            .GetProperty("data").GetProperty("write_basis");
        var absentPending = await service.ExecuteAsync(new CliInvocation("get", ["get", pendingId],
            runtime, TimeSpan.FromSeconds(30)));
        Check(absentPending.Code == "record_not_found" && absentPending.Envelope is not null,
            "Pending seed did not get an absence basis.");
        var absenceTarget = absentPending.Envelope!.Value.GetProperty("error")
            .GetProperty("identifiers").GetProperty("write_basis").GetProperty("targets")[0];
        var seedBasis = JsonNode.Parse(startBasis.GetRawText())!.AsObject();
        seedBasis["targets"]!.AsArray().Add(JsonNode.Parse(absenceTarget.GetRawText()));
        var seedFile = Path.Combine(root, "pending-seed.json");
        File.WriteAllText(seedFile, JsonSerializer.Serialize(new { v = 5,
            request_id = "fixture-" + Guid.NewGuid().ToString("D"), write_basis = seedBasis,
            input = new { id = pendingId, text = "Deliberately resolve this item" } }));
        var seed = await service.ExecuteAsync(new CliInvocation("pending.add",
            ["pending", "add", "--cwd", selectedRoot, "--session", "fixture", "--file", seedFile],
            runtime, TimeSpan.FromSeconds(30), true, seedFile));
        Check(seed.Success, "Disposable pending seed failed: " + seed.Message);
        var retire = await service.PrepareOperatorActionAsync("retire-pending",
            new Dictionary<string, string> { ["author"] = "director", ["id"] = pendingId,
                ["reason"] = "No longer needed" }, project);
        Check(retire.Request is not null && retire.Request.OperationId == "pending.drop",
            "Pending retirement preparation failed: " + retire.Error);
        Check((await service.SaveAsync(retire.Request!)).Saved, "Pending retirement did not save.");
        var retiredRecord = await service.GetRecordAsync(pendingId);
        Check(retiredRecord.Record?.Lifecycle == "historical", "Pending retirement did not preserve a historical item.");
        File.Delete(Path.Combine(retire.Request!.JournalDirectory, "response.json"));
        Check(service.PendingSaves().Any(item => item.RequestId == retire.Request.RequestId &&
            item.OperationId == "pending.drop" && item.ReplayEligible),
            "Pending retirement journal lost its replay route.");
        Check((await service.RecoverAsync(retire.Request.RequestId)).Saved &&
            (await service.GetRecordAsync(pendingId)).Revision == retiredRecord.Revision,
            "Exact pending retirement replay changed the record twice.");
        var pendingAfter = await service.ReadProjectDomainAsync(project, "pending.list");
        Check(pendingAfter.Success && !pendingAfter.Envelope!.Value.GetProperty("data")
            .GetProperty("records").EnumerateArray().Any(row => row.GetProperty("id").GetString() == pendingId),
            "Retired pending item remains unresolved.");
        var stale = service.ReviewEdit(baseline, new("Stale name", "known", 1, baseline.Record!.Json.GetProperty("data").GetRawText()));
        Check(stale.Request is not null, "Stale fixture request was not frozen.");
        var conflict = await service.SaveAsync(stale.Request!);
        Check(!conflict.Saved && !conflict.MayHaveCommitted, "Stale basis unexpectedly saved or became uncertain.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("source-only drift blocks draft and exact pending replay", async () =>
{
    var node = TestNode();
    var root = Path.Combine(Path.GetTempPath(), "ll-drift-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(Path.Combine(root, "src"));
    try
    {
        var cli = Path.Combine(root, "lodestar.mjs");
        var module = Path.Combine(root, "src", "probe.mjs");
        var db = Path.Combine(root, "db");
        var config = Path.Combine(root, "interfaces.json");
        File.WriteAllText(cli, "import './src/probe.mjs';");
        File.WriteAllText(module, "export const value = 1;"); File.WriteAllText(db, "fixture");
        var generation = Guid.NewGuid().ToString("D");
        File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1, generation,
            runtime = new { node, cli, database = db }, loader = "Lodestar.Loader.exe" }));
        var initial = await RuntimeConfig.LoadAsync(config);
        var pending = Path.Combine(root, "pending");
        await using var service = new LodestarService(initial, pending);
        var requestId = "ll-" + Guid.NewGuid().ToString("D");
        var journal = Path.Combine(pending, requestId);
        Directory.CreateDirectory(journal);
        var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
            write_basis = new { }, input = new { mode = "update", id = "fact:x", set = new { }, remove = Array.Empty<string>() } });
        File.WriteAllBytes(Path.Combine(journal, "request.json"), body);
        File.WriteAllText(Path.Combine(journal, "context.json"), JsonSerializer.Serialize(new {
            request_id = requestId, record_id = "fact:x", config = initial.ConfigPath,
            generation = initial.Generation, fingerprint = initial.Fingerprint,
            database = initial.DatabasePath, database_instance_id = "a", database_epoch = "b",
            request_sha256 = Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant() }));
        File.WriteAllText(module, "export const value = 2;");
        var changed = await RuntimeConfig.LoadAsync(config);
        Check(changed.Fingerprint != initial.Fingerprint, "An imported src-only change did not change runtime fingerprint.");
        var frozen = new FrozenMutation(requestId, "fact:x", initial, "a", "b", body, journal);
        var save = await service.SaveAsync(frozen);
        Check(!save.Saved && save.Error!.Contains("changed"), "Draft save ignored source drift.");
        var replay = await service.RecoverAsync(requestId);
        Check(!replay.Saved && replay.Error!.Contains("changed"), "Pending replay ignored source drift.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("portable manifest verifies every core file", async () =>
{
    var node = TestNode();
    var parent = Path.Combine(Path.GetTempPath(), "ll-manifest-" + Guid.NewGuid().ToString("N"));
    var root = Path.Combine(parent, "app");
    Directory.CreateDirectory(Path.Combine(root, "core", "src"));
    try
    {
        var cli = Path.Combine(root, "core", "lodestar.mjs");
        var module = Path.Combine(root, "core", "src", "probe.mjs");
        File.WriteAllText(cli, "import './src/probe.mjs';");
        File.WriteAllText(module, "export const value = 1;");
        var db = Path.Combine(parent, "db"); File.WriteAllText(db, "fixture");
        object Entry(string relative, string file)
        {
            var bytes = File.ReadAllBytes(file);
            return new { path = relative, bytes = bytes.LongLength,
                sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant() };
        }
        File.WriteAllText(Path.Combine(root, "bundle-manifest.json"), JsonSerializer.Serialize(new {
            v = 1, files = new[] { Entry("core/lodestar.mjs", cli), Entry("core/src/probe.mjs", module) } }));
        var config = Path.Combine(root, "interfaces.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1, generation = Guid.NewGuid().ToString("D"),
            runtime = new { node, cli = "core/lodestar.mjs", database = db } }));
        await RuntimeConfig.LoadAsync(config);
        File.WriteAllText(module, "export const value = 2;");
        try { await RuntimeConfig.LoadAsync(config); throw new Exception("Changed core module passed manifest verification."); }
        catch (InvalidDataException error) { Check(error.Message.Contains("drifted"), "Wrong manifest failure: " + error.Message); }
    }
    finally { Directory.Delete(parent, recursive: true); }
});

Add("changed pending request before restart never dispatches", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-journal-" + Guid.NewGuid().ToString("N"));
    var pending = Path.Combine(root, "pending");
    var requestId = "ll-" + Guid.NewGuid().ToString("D");
    var journal = Path.Combine(pending, requestId);
    Directory.CreateDirectory(journal);
    try
    {
        var runtime = new RuntimeSelection("fixture-config", "generation", "node", "cli", "database", "fingerprint");
        var original = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
            input = new { id = "fact:x", set = new { name = "Original" } } });
        File.WriteAllBytes(Path.Combine(journal, "request.json"), original);
        File.WriteAllText(Path.Combine(journal, "context.json"), JsonSerializer.Serialize(new {
            request_id = requestId, record_id = "fact:x", config = runtime.ConfigPath,
            generation = runtime.Generation, fingerprint = runtime.Fingerprint,
            database = runtime.DatabasePath, database_instance_id = "a", database_epoch = "b",
            operation = "put", request_sha256 = Convert.ToHexString(SHA256.HashData(original)).ToLowerInvariant() }));
        File.WriteAllText(Path.Combine(journal, "request.json"),
            JsonSerializer.Serialize(new { v = 5, request_id = requestId,
                input = new { id = "fact:x", set = new { name = "Changed" } } }));
        var dispatched = 0;
        await using var restarted = new LodestarService(runtime, (_, _) => {
            dispatched++; return Task.FromResult(SuccessResult("put", new { })); }, pending);
        var recovered = await restarted.RecoverAsync(requestId);
        Check(!recovered.Saved && recovered.RequiresRecovery &&
            recovered.Error!.Contains("SHA-256") && dispatched == 0,
            "Modified journal request reached a child process.");
        File.WriteAllBytes(Path.Combine(journal, "request.json"), original);
        File.WriteAllText(Path.Combine(journal, "context.json"), JsonSerializer.Serialize(new {
            request_id = requestId, record_id = "fact:x", config = runtime.ConfigPath,
            generation = runtime.Generation, fingerprint = runtime.Fingerprint,
            database = runtime.DatabasePath, database_instance_id = "a", database_epoch = "b",
            operation = "put" }));
        var missingDigest = await restarted.RecoverAsync(requestId);
        Check(!missingDigest.Saved && missingDigest.RequiresRecovery &&
            missingDigest.Error!.Contains("SHA-256") && dispatched == 0,
            "Missing journal digest reached a child process.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("fresh journal failure is unsent while prior pending remains uncertain", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-save-error-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var node = TestNode();
        var cli = Path.Combine(root, "lodestar.mjs"); File.WriteAllText(cli, "export {};");
        var db = Path.Combine(root, "test.db"); File.WriteAllText(db, "fixture");
        var config = Path.Combine(root, "interfaces.json");
        File.WriteAllText(config, JsonSerializer.Serialize(new { v = 1, generation = Guid.NewGuid().ToString("D"),
            runtime = new { node, cli, database = db }, loader = "Lodestar.Loader.exe" }));
        var runtime = await RuntimeConfig.LoadAsync(config);
        var pending = Path.Combine(root, "pending");
        var requestId = "ll-" + Guid.NewGuid().ToString("D");
        var journal = Path.Combine(pending, requestId);
        Directory.CreateDirectory(Path.Combine(journal, "context.json"));
        var body = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = requestId,
            input = new { mode = "update", id = "fact:x", set = new { name = "Changed" },
                remove = Array.Empty<string>() } });
        var frozen = new FrozenMutation(requestId, "fact:x", runtime, "a", "b", body, journal);
        var putCalls = 0;
        await using var service = new LodestarService(runtime, (invocation, _) =>
        {
            if (invocation.OperationId == "find")
                return Task.FromResult(SuccessResult("find", new { records = Array.Empty<object>() }));
            if (invocation.OperationId == "put")
            {
                putCalls++;
                return Task.FromResult(SuccessResult("put", new { }));
            }
            throw new InvalidOperationException("Unexpected test operation: " + invocation.OperationId);
        }, pending);
        var fresh = await service.SaveAsync(frozen);
        Check(!fresh.Saved && !fresh.MayHaveCommitted && fresh.RequiresRecovery && putCalls == 0 &&
            File.Exists(Path.Combine(journal, "request.json")) &&
            fresh.Error!.Contains("not sent", StringComparison.OrdinalIgnoreCase),
            "Fresh context failure was described as a dispatched write.");
        await using var reopened = new LodestarService(runtime, (invocation, _) =>
        {
            if (invocation.OperationId == "put") putCalls++;
            return Task.FromResult(SuccessResult(invocation.OperationId, new { }));
        }, pending);
        var incomplete = reopened.PendingSaves();
        Check(incomplete.Count == 1 && incomplete[0].RequestId == requestId &&
            !incomplete[0].ReplayEligible && incomplete[0].Issue?.Contains("context") == true,
            "Reopened request-only journal disappeared from pending saves.");
        var health = LodestarHealth.Build(null, null, incomplete);
        Check(health.State == "attention" && health.Issues.Any(i => i.ActionKey == "pending-saves" &&
            i.Message.Contains("replay is blocked")),
            "Incomplete save journal disappeared from Health.");
        var blocked = await reopened.RecoverAsync(requestId);
        Check(!blocked.Saved && blocked.RequiresRecovery && blocked.Error?.Contains("replay is blocked") == true &&
            putCalls == 0,
            "Incomplete save journal was replayed or falsely marked resolved.");
        var prior = await service.SaveAsync(frozen);
        Check(!prior.Saved && prior.MayHaveCommitted && prior.RequiresRecovery && putCalls == 0 &&
            prior.Error!.Contains("prior", StringComparison.OrdinalIgnoreCase),
            "Previously pending request lost conservative uncertainty.");
        Directory.Delete(Path.Combine(journal, "context.json"));
        File.WriteAllText(Path.Combine(journal, "context.json"), "{");
        var corrupt = reopened.PendingSaves().Single();
        Check(!corrupt.ReplayEligible && corrupt.Issue is not null &&
            !(await reopened.RecoverAsync(requestId)).Saved && putCalls == 0,
            "Corrupt context was hidden or replayed.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("complete library survives partial refresh and catalog conflict restarts", async () =>
{
    var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
    var project = new { id = "project:p", kind = "project", scope = "global", name = "Project",
        updated_at = "2026-09-01T00:00:00Z", data = new { status = "active", roots = new[] { "C:/p" } },
        semantics = new { lifecycle = "current", applicability = new { project = "project:p" } } };
    var fact = new { id = "fact:p", kind = "fact", scope = "project:p", name = "Fact",
        updated_at = "2026-09-02T00:00:00Z", data = new { description = "known" } };
    var refresh = 0;
    await using (var service = new LodestarService(runtime, (invocation, _) =>
    {
        var catalog = invocation.Arguments.Contains("--kind");
        var data = catalog ? (object)new { records = new[] { project }, record_errors = Array.Empty<object>(), complete = true } :
            refresh == 0 ? new { records = new[] { project }, record_errors = Array.Empty<object>(), complete = true } :
                new { records = new[] { project }, record_errors = new[] { new { code = "invalid_stored_record",
                    message = "Broken row", identifiers = new { id = "project:broken" } } }, complete = false };
        return Task.FromResult(SuccessResult("find", data));
    }))
    {
        var first = await service.LoadLibraryAsync();
        Check(first.Complete && first.Error is null && first.Projects.Length == 1, "Baseline library did not complete.");
        refresh = 1;
        var second = await service.LoadLibraryAsync();
        Check(second.Complete && second.ReadAt == first.ReadAt && second.Revision == first.Revision &&
            second.Error?.Contains("partial") == true && second.Error.Contains("snapshot read at"),
            "Partial refresh replaced the complete dated snapshot.");
    }
    var calls = 0;
    await using var retryService = new LodestarService(runtime, (invocation, _) =>
    {
        calls++;
        if (calls == 1)
        {
            var next = new object[] { new { command = "find", args = new[] { "--all", "--kind", "project",
                "--history", "--limit", "250", "--offset", "250", "--at-revision", "5" } } };
            return Task.FromResult(SuccessResult("find", new { records = Enumerable.Range(0, 250).Select(i =>
                new { id = $"project:{i}", kind = "project", scope = "global", name = $"Project {i}", data = new { } }).ToArray(),
                record_errors = Array.Empty<object>(), complete = true }, 5, true, next));
        }
        if (calls == 2) return Task.FromResult(new CliResult(false, null, "read_revision_conflict",
            "Catalog page changed revision.", 2, "", 1));
        return Task.FromResult(SuccessResult("find", new { records = new[] { project },
            record_errors = Array.Empty<object>(), complete = true }, 6));
    });
    var catalogCallbacks = new List<LibrarySnapshot>();
    var restarted = await retryService.LoadLibraryAsync(onCatalogReady: catalogCallbacks.Add);
    Check(restarted.Complete && restarted.Error is null && restarted.Revision == 6 && calls == 4 &&
        catalogCallbacks.Count == 1 && catalogCallbacks[0].CatalogOnly && catalogCallbacks[0].Revision == 6,
        "Catalog-page revision conflict did not restart before publishing one complete catalog.");
});

Add("catalog callback precedes current scan and preserves complete refresh", async () =>
{
    var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
    var project = new { id = "project:p", kind = "project", scope = "global", name = "Project",
        data = new { status = "active" }, semantics = new { applicability = new { project = "project:p" } } };
    var fact = new { id = "fact:p", kind = "fact", scope = "project:p", name = "Fact",
        data = new { description = "known" } };
    var releaseCurrent = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var currentStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
    var refresh = false;
    var callbacks = new List<LibrarySnapshot>();
    await using var service = new LodestarService(runtime, async (invocation, _) =>
    {
        if (invocation.Arguments.Contains("--kind"))
            return SuccessResult("find", new { records = new[] { project }, complete = true,
                record_errors = Array.Empty<object>() }, 12);
        currentStarted.TrySetResult(true);
        if (!refresh) await releaseCurrent.Task;
        return SuccessResult("find", new { records = new[] { fact }, complete = !refresh,
            record_errors = refresh ? new[] { new { code = "invalid_stored_record", message = "Broken row",
                identifiers = new { id = "fact:broken" } } } : Array.Empty<object>() }, 12);
    });
    var loading = service.LoadLibraryAsync(onCatalogReady: snapshot =>
    {
        Check(service.LastCompleteLibrary is null, "Catalog callback waited for the complete library.");
        callbacks.Add(snapshot);
    });
    await currentStarted.Task.WaitAsync(TimeSpan.FromSeconds(3));
    Check(!loading.IsCompleted && callbacks.Count == 1, "Catalog was not published before current scan finished.");
    var provisional = callbacks.Single();
    Check(provisional.CatalogOnly && !provisional.Complete && provisional.Error is null &&
        provisional.Projects.Length == 1 && provisional.Records.IsEmpty &&
        provisional.GlobalKnowledge.IsEmpty && provisional.Unassigned.IsEmpty &&
        provisional.Projects[0].CurrentRecordCount == 0 && !provisional.Projects[0].AssociationComplete &&
        provisional.LoadedCount == 1 && provisional.DatabaseInstanceId == "a" &&
        provisional.DatabaseEpoch == "b" && provisional.Revision == 12 &&
        provisional.Advisories.Any(message => message.Contains("still loading")),
        "Provisional coverage or pinned catalog identity is misleading.");
    releaseCurrent.SetResult(true);
    var first = await loading;
    Check(first.Complete && !first.CatalogOnly && first.Error is null && first.LoadedCount == 2 &&
        first.Projects[0].CurrentRecordCount == 1 && first.DatabaseInstanceId == provisional.DatabaseInstanceId &&
        first.DatabaseEpoch == provisional.DatabaseEpoch && first.Revision == provisional.Revision,
        "Final scan did not replace provisional coverage with the same pinned identity.");
    var diagnostics = service.LastLibraryLoadDiagnostics;
    Check(diagnostics is not null && diagnostics.Phases.Select(phase => phase.Phase)
        .SequenceEqual(new[] { "catalog-1", "catalog-published-1", "current-1", "projected-1", "finished" }) &&
        diagnostics.Phases.Zip(diagnostics.Phases.Skip(1)).All(pair =>
            pair.First.ElapsedMilliseconds <= pair.Second.ElapsedMilliseconds) &&
        diagnostics.Phases.All(phase => phase.ManagedBytes >= 0 && phase.HeapSizeBytes >= 0 &&
            phase.FragmentedBytes >= 0 && phase.WorkingSetBytes >= 0 && phase.PrivateBytes >= 0 &&
            phase.TotalAllocatedBytes >= 0), "Bounded phase diagnostics are missing or unordered.");
    refresh = true;
    var second = await service.LoadLibraryAsync(onCatalogReady: callbacks.Add);
    Check(callbacks.Count == 1 && second.Complete && !second.CatalogOnly &&
        second.ReadAt == first.ReadAt && second.Error?.Contains("partial") == true &&
        ReferenceEquals(service.LastCompleteLibrary, first),
        "Partial refresh emitted a provisional callback or replaced the complete snapshot.");
});

Add("generic read metadata fails closed and leading dash remains positional", async () =>
{
    var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
    var descriptors = new object[] {
        new { id = "find", argv = new[] { "find" }, effect = "read", summary = "Find",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
            parameters = new[] { new { name = "query", binding = "positional", index = 0, required = true,
                schema = new { type = "string", minLength = 1 } } } },
        new { id = "unsafe.leading", argv = new[] { "find", "--output" }, effect = "read", summary = "Unsafe",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(), parameters = Array.Empty<object>() },
        new { id = "unsafe.binding", argv = new[] { "unsafe", "binding" }, effect = "read", summary = "Unsafe",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
            parameters = new[] { new { name = "target", binding = "option", flag = "--output", required = false,
                schema = new { type = "string" } } } },
        new { id = "unsafe.position", argv = new[] { "unsafe", "position" }, effect = "read", summary = "Unsafe",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
            parameters = new[] { new { name = "query", binding = "positional", index = 1, required = true,
                schema = new { type = "string" } } } },
        new { id = "unsafe.schema", argv = new[] { "unsafe", "schema" }, effect = "read", summary = "Unsafe",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
            parameters = new[] { new { name = "query", binding = "positional", index = 0, required = true,
                schema = new { type = "object" } } } },
        new { id = "find.option", argv = new[] { "find", "option" }, effect = "read", summary = "Find option",
            context = new { project = false, actor = false }, constraints = Array.Empty<object>(),
            parameters = new[] { new { name = "query", binding = "option", flag = "--query", required = true,
                schema = new { type = "string" } } } }
    };
    string[]? invoked = null;
    await using var service = new LodestarService(runtime, (invocation, _) =>
    {
        if (invocation.OperationId == "help")
            return Task.FromResult(SuccessResult("help", new { capability_version = 1, operations = descriptors }));
        invoked = invocation.Arguments.ToArray();
        return Task.FromResult(SuccessResult(invocation.OperationId, new { records = Array.Empty<object>() }));
    });
    var discovered = await service.DiscoverAsync();
    Check(discovered.Operations.Single(o => o.Id == "find").CanRunGenericRead, "Safe read was disabled.");
    foreach (var operation in discovered.Operations.Where(o => o.Id.StartsWith("unsafe")))
        Check(!operation.CanRunGenericRead && operation.UnavailableReason is not null,
            "Unsafe generic metadata became executable: " + operation.Id);
    await service.RunReadAsync(discovered.Operations.Single(o => o.Id == "find"),
        new Dictionary<string, string?> { ["query"] = "--output" });
    Check(invoked is not null && invoked.SequenceEqual(new[] { "find", "--", "--output" }),
        "Leading-dash query was not protected by the positional delimiter.");
    foreach (var value in new[] { "--output", "--db", "--args-file", "--args-stdin", "--human", "-h", "-v" })
    {
        invoked = null;
        try
        {
            await service.RunReadAsync(discovered.Operations.Single(o => o.Id == "find.option"),
                new Dictionary<string, string?> { ["query"] = value });
            throw new Exception("Global-like option value was accepted: " + value);
        }
        catch (ArgumentException) { }
        Check(invoked is null, "Global-like option value reached CLI dispatch: " + value);
    }
});

Add("project domain read uses fresh exact root and blocks stale mapping", async () =>
{
    var root = Path.Combine(Path.GetTempPath(), "ll-domain-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(root);
    try
    {
        var runtime = new RuntimeSelection("c", "g", "n", "m", "d", "f");
        var catalog = Row("""{"id":"project:p","kind":"project","scope":"global","name":"Project","data":{}}""");
        var project = new ProjectSummary("project:p", "Project", "active", [root], ["project:p"],
            0, 0, null, null, true, catalog);
        var descriptor = new { id = "work.history", argv = new[] { "work", "history" }, effect = "read",
            summary = "History", context = new { project = true, actor = false }, constraints = Array.Empty<object>(),
            parameters = new object[] {
                new { name = "cwd", binding = "option", flag = "--cwd", required = false,
                    schema = new { type = "string", minLength = 1 } },
                new { name = "limit", binding = "option", flag = "--limit", required = false,
                    schema = new { type = "integer", minimum = 1 } }
            } };
        object RevisionOnly(string id, string[] argv) => new { id, argv, effect = "read",
            summary = id, context = new { project = true, actor = false }, constraints = Array.Empty<object>(),
            parameters = new object[] { new { name = "cwd", binding = "option", flag = "--cwd",
                required = false, schema = new { type = "string", minLength = 1 } } } };
        var stale = false; var domainCalls = 0; string[]? domainArgs = null;
        await using var service = new LodestarService(runtime, (invocation, _) =>
        {
            if (invocation.OperationId == "help") return Task.FromResult(SuccessResult("help",
                new { capability_version = 1, operations = new object[] { descriptor,
                    RevisionOnly("decision.show", ["decision", "show"]),
                    RevisionOnly("handoff.history", ["handoff", "history"]) } }));
            if (invocation.OperationId == "start") return Task.FromResult(SuccessResult("start",
                new { project = new { id = stale ? "project:other" : "project:p", scope = "project:p",
                    historical_scopes = Array.Empty<string>() } }));
            domainCalls++; domainArgs = invocation.Arguments.ToArray();
            return Task.FromResult(SuccessResult(invocation.OperationId,
                new { records = Array.Empty<object>(), more = false, complete = true,
                    record_errors = Array.Empty<object>() }));
        });
        await service.DiscoverAsync();
        var current = await service.ReadProjectDomainAsync(project, "work.history", 25);
        Check(current.Success && domainCalls == 1 && domainArgs is not null &&
            domainArgs.SequenceEqual(new[] { "work", "history", "--cwd", root, "--limit", "25" }),
            "Domain read lost exact verified-root argv.");
        var decision = await service.ReadProjectDomainAsync(project, "decision.show", decisionKey: "choice");
        Check(decision.Success && domainArgs!.SequenceEqual(new[] { "decision", "show", "--cwd", root,
            "--", "choice" }), "Decision reader sent an unsupported limit option.");
        var handoff = await service.ReadProjectDomainAsync(project, "handoff.history");
        Check(handoff.Success && domainArgs!.SequenceEqual(new[] { "handoff", "history", "--cwd", root }),
            "Handoff reader sent an unsupported limit option.");
        var unsupportedLimit = await service.ReadProjectDomainAsync(project, "decision.show", 1,
            decisionKey: "choice");
        Check(!unsupportedLimit.Success && domainCalls == 3,
            "Decision reader silently accepted an unsupported limit.");
        stale = true;
        var blocked = await service.ReadProjectDomainAsync(project, "work.history", 25);
        Check(!blocked.Success && blocked.Code == "project_context_mismatch" && domainCalls == 3,
            "Rebound root still dispatched a domain read.");
    }
    finally { Directory.Delete(root, recursive: true); }
});

Add("operator readout truth and health contracts", OperatorReadoutChecks.RunAsync);
Add("continuity release version from actual discovery", ContinuityReadoutChecks.VersionAsync);
Add("continuity literal read actions reject unsafe arrays", ContinuityReadoutChecks.ReadsAsync);
Add("continuity recorded reasons and unknown coverage", ContinuityReadoutChecks.ReadoutAsync);
Add("continuity iterative deep and branching requirement depths", ContinuityReadoutChecks.DepthsAsync);
Add("bounded library continuation contracts", ContinuationChecks.RunAsync);
Add("bounded private diagnostic contracts", DiagnosticChecks.RunAsync);
Add("FQ02 real diagnostic unavailable empty and recovery states", DiagnosticChecks.AvailabilityAsync);
Add("EH02 pending preflight retains prior unknown outcome", AdversarialLoaderChecks.PendingPreflightRetainsPriorOutcome);
Add("EH05 journal root fault remains actionable", AdversarialLoaderChecks.JournalRootFaultRetainsRecoveryList);
Add("EH06 confirmed save refresh failure remains stale", AdversarialLoaderChecks.ConfirmedSaveRefreshFailureIsStale);
Add("EH07 transport failure category and correlation", AdversarialLoaderChecks.TransportFailureKeepsSafeStageAndCorrelation);
Add("EH01 native postcommit delivery retains recovery", AdversarialLoaderChecks.PostCommitDeliveryFailureRetainsExactRecovery);
Add("Q3 string enum choices dispatch and reject outside values", () => NativeFinishChecks.TypedEnumsAsync("string"));
Add("Q3 integer enum choices dispatch and reject outside values", () => NativeFinishChecks.TypedEnumsAsync("integer"));
Add("Q3 boolean enum choices dispatch and reject outside values", () => NativeFinishChecks.TypedEnumsAsync("boolean"));
Add("Q3 unknown and unsafe enum schemas remain unavailable", NativeFinishChecks.UnsafeEnumsAsync);
Add("Q4 config extras and pending context survive read-only reload", NativeFinishChecks.ConfigPreservationAsync);
Add("Q6 native config generation follows shared UUID contract", NativeFinishChecks.GenerationContractAsync);
Add("Q9 actual Find descriptor accepts boolean-looking string queries", NativeFinishChecks.FindBooleanTextAsync);
Add("Q9 exactly-one and at-most-one preserve typed boolean controls", NativeFinishChecks.ConstraintControlsAsync);
Add("RR3 corrupt cached responses preserve unknown exact journals", NativeFinishChecks.CorruptCachedResponsesAsync);
Add("DC-F5 cancelled uncertainty publication leaves no partial final evidence", NativeFinishChecks.CancelledUncertaintyPublicationAsync);
Add("DC-F5 interrupted uncertainty evidence preserves exact receipt recovery", NativeFinishChecks.InterruptedUncertaintyRecoveryAsync);
Add("DC-F5 incomplete evidence requires verified unknown context", NativeFinishChecks.IncompleteEvidenceContextGuardAsync);
Add("D3 synthetic uncertainty markers bind original diagnostic identity", NativeFinishChecks.SyntheticMarkerIdentityAsync);
Add("D3 copied legacy guidance remains unverified through exact recovery", NativeFinishChecks.LegacyMarkerGuidanceAsync);
Add("RR3 malformed uncertainty marker retains blocked exact journal", NativeFinishChecks.CorruptUncertaintyContextAsync);
Add("RR3 zero revision delivery report preserves uncertainty without fake commit", NativeFinishChecks.ZeroRevisionDeliveryReportAsync);
Add("RR3 matching receipts and rejected responses stay settled", NativeFinishChecks.MatchingCachedResponsesAsync);
Add("RR3 fresh responses bind frozen identity and result flags", NativeFinishChecks.FreshResponseIdentityAsync);
Add("RR5 replay participates in shared mutation lifecycle source contract", NativeFinishChecks.ReplayBusySourceAsync);
Add("RR5 gated service replay preserves journal during dispatch and cancellation", NativeFinishChecks.GatedReplayAsync);
Add("RR3 corrupt cache recovers through original exact request receipt", NativeFinishChecks.CorruptCacheRecoversWithReceiptAsync);
Add("RR3 later replay rejection never clears earlier unknown outcome", NativeFinishChecks.LaterRejectionRetainsUnknownAsync);
Add("SR live process uncertainty survives native journal reopen and exact receipt recovery", NativeFinishChecks.TransportUnknownJournalAsync);
Add("RL16 semantic unknown journal preserves exact request and core recovery", NativeFinishChecks.SemanticUnknownJournalAsync);
Add("RL16 semantic provenance failure preserves latest and blocks replay", NativeFinishChecks.SemanticProvenanceFailureAsync);
Add("RR3 initial definitive rejection remains settled and actionable", NativeFinishChecks.InitialRejectionIsSettledAsync);

Add("RC binding documents reject ambiguous JSON and invalid UTF8", RuntimeConfigChecks.RunAsync);
Add("CA3 portable runtime database boundaries preserve selection and bytes", RuntimePathBoundaryChecks.RunAsync);
Add("literal operator reads preserve accepted IDs", LiteralReadChecks.RunAsync);
Add("native malformed UTF8 and duplicate envelope rejection", NativeProtocolChecks.TransportBytesAsync);
Add("native malformed recorded responses remain unresolved", NativeProtocolChecks.PendingResponsesAsync);
Add("native singular project roots preserve context", NativeProtocolChecks.SingularRootsAsync);

Add("RL14 queued mutation whole-call deadline", NativeLeadChecks.QueuedDeadlineAsync);
Add("VM3 inherited response pipes obey whole-call deadline", NativeLeadChecks.PipeDeadlineAsync);
Add("RL10 actual core guarded source attestation", NativeLeadChecks.SourceAttestationAsync);
Add("FQ01 real filesystem attribute cause remains actionable", ErrorCauseChecks.AttributeCauseAsync);
Add("GAP-D1 actual cross-surface recovery", RecoveryBridgeChecks.RunAsync);
Add("GAP-D2 actual ordinary retirement", RetirementChecks.RunAsync);
Add("FQ01 real save retains primary and secondary retention causes", ErrorCauseChecks.SecondaryRetentionCauseAsync);

var failures = 0;
Add("OI2 actual core capture attention identity", OperatorImprovementChecks.RunAsync);
Add("OI2 historical attention inventory literal reads", AttentionHistoricalInventoryChecks.RunAsync);
var executed = 0;
foreach (var (name, run) in checks)
{
    var filter = Environment.GetEnvironmentVariable("LODESTAR_TEST_FILTER");
    if (!string.IsNullOrWhiteSpace(filter) && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
    executed++;
    try { await run(); Console.WriteLine("PASS " + name); }
    catch (Exception error) { failures++; Console.Error.WriteLine("FAIL " + name + ": " + error); }
}
if (executed == 0)
{
    Console.Error.WriteLine("No checks matched LODESTAR_TEST_FILTER. Clear this variable to run all checks, or choose part of a registered check name below.");
    foreach (var (name, _) in checks) Console.Error.WriteLine("  " + name);
    return 2;
}
Console.WriteLine($"{executed - failures}/{executed} passed");
return failures == 0 ? 0 : 1;
