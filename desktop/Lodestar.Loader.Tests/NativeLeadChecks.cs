using System.Diagnostics;
using System.Text.Json;
using Lodestar.Loader;

public static class NativeLeadChecks
{
    public static async Task PipeDeadlineAsync()
    {
        foreach (var mutation in new[] { false, true })
        foreach (var outcome in new[] { "complete", "timeout", "cancelled", "output_overflow", "closing" })
        {
            var inheritedPipes = outcome != "complete";
            var root = Path.Combine(Path.GetTempPath(), "ll-pipe-deadline-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            var node = TestNodeRuntime.Resolve();
            var marker = Path.Combine(root, "owned-pids.json");
            var spawnError = Path.Combine(root, "spawn-error.json");
            var ready = Path.Combine(root, "ready");
            var cli = Path.Combine(root, "finite-cli.mjs");
            var database = Path.Combine(root, "unused.db");
            File.WriteAllText(database, "Synthetic transport file; no database is opened.");
            var operation = mutation ? "put" : "get";
            var stdio = inheritedPipes ? "['ignore','inherit','inherit']" : "'ignore'";
            var childSource = "process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});process.stderr.write(Buffer.from([0xc3]));require(\"node:fs\").writeFileSync(process.argv[1],\"ready\");" +
                (outcome == "output_overflow" ? "setTimeout(()=>process.stdout.write('x'.repeat(17*1024*1024)),250);" : "") +
                "setTimeout(()=>{},5000);";
            var source = "import {spawn} from 'node:child_process';import {existsSync,writeFileSync,renameSync} from 'node:fs';" +
                "const child=spawn(process.execPath,['-e'," + JsonSerializer.Serialize(childSource) + "," +
                JsonSerializer.Serialize(ready) + "],{detached:true,windowsHide:true,stdio:" + stdio + "});" +
                "child.on('error',error=>{writeFileSync(" + JsonSerializer.Serialize(spawnError) +
                ",JSON.stringify({code:error.code,name:error.name,message:error.message}));process.exit(1);});" +
                "writeFileSync(" + JsonSerializer.Serialize(marker + ".tmp") +
                ",JSON.stringify({parent:process.pid,descendant:child.pid??null,spawnedAt:Date.now()}));renameSync(" +
                JsonSerializer.Serialize(marker + ".tmp") + "," + JsonSerializer.Serialize(marker) + ");" +
                "const wait=setInterval(()=>{if(!existsSync(" + JsonSerializer.Serialize(ready) + "))return;clearInterval(wait);" +
                "console.log(JSON.stringify({v:5,ok:true,operation:'" + operation + "',revision:null,database_instance_id:null,database_epoch:null,more:false,next:[],data:{fixture:true}}));process.exit(0);},5);";
            File.WriteAllText(cli, source);
            var runtime = new RuntimeSelection("fixture", "fixture", node, cli, database, "fixture");
            Process? parentHandle = null, descendantHandle = null;
            int parent = 0, descendant = 0;
            var transport = new CliTransport(new DiagnosticLog(Path.Combine(root, "diagnostics")), process =>
            {
                // The first launch is the finite fixture; later capacity probes use a separate CLI.
                if (parentHandle is null)
                {
                    parent = process.Id;
                    parentHandle = Process.GetProcessById(parent);
                    _ = parentHandle.SafeHandle;
                }
                return Task.CompletedTask;
            });
            using var cancellation = new CancellationTokenSource();
            var pending = transport.ExecuteAsync(new(operation, [operation], runtime,
                TimeSpan.FromMilliseconds(outcome == "timeout" ? 800 : 5000), mutation), cancellation.Token);
            Task? disposing = null;
            Exception? primaryFailure = null;
            void ReadOwners()
            {
                if (!File.Exists(marker)) return;
                using var pids = JsonDocument.Parse(File.ReadAllText(marker));
                var identity = pids.RootElement;
                if (parentHandle is null || identity.GetProperty("parent").GetInt32() != parent)
                    throw new Exception("Fixture marker does not belong to the exact observed CLI parent.");
                if (!identity.TryGetProperty("descendant", out var child) || !child.TryGetInt32(out var childId)) return;
                if (childId <= 0 || childId == parent || descendant != 0 && descendant != childId)
                    throw new Exception("Fixture descendant identity changed or is invalid.");
                descendant = childId;
                if (descendantHandle is not null) return;
                Process candidate;
                try { candidate = Process.GetProcessById(descendant); }
                catch (ArgumentException) { return; }
                try
                {
                    _ = candidate.SafeHandle;
                    var started = candidate.StartTime.ToUniversalTime();
                    var published = DateTimeOffset.FromUnixTimeMilliseconds(identity.GetProperty("spawnedAt").GetInt64()).UtcDateTime;
                    if (started < parentHandle.StartTime.ToUniversalTime() || started > published.AddMilliseconds(1))
                        throw new Exception("Fixture descendant PID was reused outside its recorded spawn interval.");
                    descendantHandle = candidate;
                }
                finally { if (descendantHandle != candidate) candidate.Dispose(); }
            }
            try
            {
                // Readiness is fixture setup, not a cold-start performance claim.
                // The actual operation deadline still includes process startup.
                while (!File.Exists(ready))
                {
                    ReadOwners();
                    if (pending.IsCompleted && !File.Exists(ready))
                    {
                        var incomplete = await pending;
                        var cause = File.Exists(spawnError) ? File.ReadAllText(spawnError) : "no spawn error recorded";
                        throw new Exception($"Fixture setup incomplete before the actual call settled: code={incomplete.Code ?? "success"}, stage={incomplete.FailureStage ?? "none"}, elapsedMs={incomplete.ElapsedMilliseconds}, parent={parent}, descendant={(descendant == 0 ? "unknown" : descendant.ToString())}, cause={cause}. Inherited-pipe behavior was not established.");
                    }
                    await Task.WhenAny(pending, Task.Delay(10));
                }
                ReadOwners();
                if (descendantHandle is null) throw new Exception("Ready fixture has no observed owned descendant handle.");
                if (outcome is "cancelled" or "closing")
                {
                    await Task.Delay(100);
                    if (outcome == "cancelled") cancellation.Cancel();
                    else disposing = transport.DisposeAsync().AsTask();
                }
                var completed = await Task.WhenAny(pending, Task.Delay(1600));
                if (completed != pending)
                    throw new Exception($"Whole-call {outcome} did not settle within 1600 ms; mutation={mutation}, inheritedPipes={inheritedPipes}, parentExited={parentHandle?.HasExited}, descendantExited={descendantHandle.HasExited}.");
                var result = await pending;
                if (parentHandle?.HasExited != true) throw new Exception("Direct CLI must have exited for this failure trajectory.");
                if (descendantHandle.HasExited) throw new Exception("Finite fixture must still be running when the result is observed.");
                if (inheritedPipes)
                {
                    if (result.Success || result.Envelope is not null || result.Code != outcome || result.MayHaveCommitted != mutation ||
                        mutation && !result.Message.Contains("write outcome is unknown", StringComparison.OrdinalIgnoreCase))
                        throw new Exception("Incomplete inherited response pipes were trusted or lost interruption/write uncertainty: " + result.Code);
                }
                else if (!result.Success || result.Envelope?.GetProperty("data").GetProperty("fixture").GetBoolean() != true)
                    throw new Exception("Closed-pipe control did not return its actual complete response.");
                if (outcome != "closing")
                {
                    var followup = Path.Combine(root, "followup.mjs");
                    File.WriteAllText(followup, "console.log(JSON.stringify({v:5,ok:true,operation:'" + operation + "',revision:null,database_instance_id:null,database_epoch:null,more:false,next:[],data:{followup:true}}));");
                    var following = await transport.ExecuteAsync(new(operation, [operation], runtime with { CliPath = followup }, TimeSpan.FromSeconds(1), mutation));
                    if (!following.Success || following.Envelope?.GetProperty("data").GetProperty("followup").GetBoolean() != true)
                        throw new Exception("Transport did not release read/mutation capacity after " + outcome);
                }
                disposing ??= transport.DisposeAsync().AsTask();
                if (await Task.WhenAny(disposing, Task.Delay(1000)) != disposing)
                    throw new Exception("Dispose did not drain completed " + outcome + " operation.");
                await disposing;
            }
            catch (Exception error) { primaryFailure = error; throw; }
            finally
            {
                try
                {
                    // Stop and settle the exact direct parent before reading its final
                    // marker: setup may have published the child after an assertion failed.
                    cancellation.Cancel();
                    await transport.DisposeAsync();
                    var settled = await pending;
                    ReadOwners();
                    if (parentHandle?.HasExited == false)
                        throw new Exception("Owned fixture parent survived transport disposal.");
                    if (descendantHandle is { HasExited: false })
                    {
                        descendantHandle.Kill();
                        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                        await descendantHandle.WaitForExitAsync(limit.Token);
                    }
                    var parentExited = parentHandle?.HasExited;
                    var descendantExited = descendantHandle?.HasExited;
                    Console.WriteLine($"Fixture cleanup pipe: outcome={outcome}, mutation={mutation}, primary={primaryFailure?.Message ?? "none"}, settledCode={settled.Code ?? "success"}, elapsedMs={settled.ElapsedMilliseconds}, parent={parent}, parentExited={parentHandle?.HasExited.ToString() ?? "unknown"}, descendant={(descendant == 0 ? "unknown" : descendant.ToString())}, descendantExited={descendantHandle?.HasExited.ToString() ?? (descendant == 0 ? "unknown" : "not present at lookup")}, root={root}");
                    // Release the observer's own OS handles after proving exit,
                    // before deleting the directory used by these processes.
                    descendantHandle?.Dispose(); parentHandle?.Dispose();
                    var cleanupWait = Stopwatch.StartNew();
                    var sharingRetries = 0;
                    while (true)
                    {
                        try { Directory.Delete(root, true); break; }
                        catch (IOException error) when (error.HResult == unchecked((int)0x80070020) && sharingRetries < 20)
                        {
                            if (sharingRetries == 0)
                                Console.WriteLine($"Fixture cleanup sharing: HRESULT=0x{error.HResult:X8}, parentExited={parentExited?.ToString() ?? "unknown"}, descendantExited={descendantExited?.ToString() ?? "unknown"}, observerHandlesClosed=True, maxDelays=20, delayMs=25, root={root}");
                            sharingRetries++;
                            await Task.Delay(25);
                        }
                    }
                    if (sharingRetries > 0)
                        Console.WriteLine($"Fixture cleanup sharing resolved: retries={sharingRetries}, elapsedMs={cleanupWait.ElapsedMilliseconds}, root={root}");
                }
                catch (Exception cleanupError)
                {
                    Console.Error.WriteLine($"Fixture cleanup pipe failed: HRESULT=0x{cleanupError.HResult:X8}, parent={parent}, descendant={(descendant == 0 ? "unknown" : descendant.ToString())}, primary={primaryFailure?.Message ?? "none"}");
                    if (primaryFailure is not null) throw new AggregateException("Pipe test and owned fixture cleanup both failed.", primaryFailure, cleanupError);
                    throw;
                }
                finally { descendantHandle?.Dispose(); parentHandle?.Dispose(); }
            }
        }
    }

    private static void NodeResolutionControls(Func<string?, string?, string> resolve)
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-node-resolution-" + Guid.NewGuid().ToString("N"));
        var first = Path.Combine(root, "first runtime");
        var second = Path.Combine(root, "second runtime");
        Directory.CreateDirectory(first); Directory.CreateDirectory(second);
        try
        {
            var executable = OperatingSystem.IsWindows() ? "node.exe" : "node";
            var firstNode = Path.Combine(first, executable); var secondNode = Path.Combine(second, executable);
            File.WriteAllText(firstNode, "fixture"); File.WriteAllText(secondNode, "fixture");
            if (resolve(secondNode, first) != secondNode) throw new Exception("Explicit test Node override lost priority.");
            if (resolve(null, Path.Combine(root, "absent") + Path.PathSeparator + first + Path.PathSeparator + second) != firstNode)
                throw new Exception("Test Node PATH lookup lost first existing runtime or paths with spaces.");
            foreach (var missingPath in new string?[] { null, "", Path.Combine(root, "absent") })
            try { resolve(null, missingPath); throw new Exception("Missing test runtime was accepted."); }
            catch (InvalidOperationException error)
            {
                if (!error.Message.Contains("LODESTAR_TEST_NODE", StringComparison.Ordinal) ||
                    !error.Message.Contains("PATH", StringComparison.Ordinal))
                    throw new Exception("Missing test runtime did not explain the override and PATH recovery options.", error);
            }
        }
        finally { Directory.Delete(root, true); }
    }

    public static async Task SourceAttestationAsync()
    {
        NodeResolutionControls(TestNodeRuntime.Resolve);
        var root = Path.Combine(Path.GetTempPath(), "ll-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var node = TestNodeRuntime.Resolve();
            var generator = Path.Combine(AppContext.BaseDirectory, "generate-fixture.mjs");
            var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(generator); start.ArgumentList.Add(root);
            using (var child = Process.Start(start)!)
            {
                var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
                await child.WaitForExitAsync(); await stdout;
                if (child.ExitCode != 0) throw new Exception("Fixture generation failed: " + await stderr);
            }
            var runtime = await RuntimeConfig.LoadAsync(Path.Combine(root, "interfaces.json"));
            await using var service = new LodestarService(runtime, journalRoot: Path.Combine(root, "journal"));
            await service.DiscoverAsync();
            var library = await service.LoadLibraryAsync(); var project = library.Projects.Single();
            var create = await service.PrepareOperatorActionAsync("research", new Dictionary<string, string> {
                ["author"] = "Alex", ["name"] = "Captured source", ["source"] = "https://example.test/spec", ["body"] = "Original source excerpt",
                ["claim"] = "Recorded finding", ["limitations"] = "Scope limits" }, project);
            if (create.Request is null) throw new Exception(create.Error);
            var created = await service.SaveAsync(create.Request); if (!created.Saved) throw new Exception(created.Error);
            var before = await service.GetRecordAsync(create.Request.RecordId);
            var fields = new Dictionary<string, string> { ["author"] = "Alex", ["id"] = create.Request.RecordId,
                ["reviewed_at"] = "2025-02-03", ["review_qualifiers"] = "Inspected source for API scope", ["source_version"] = "v2",
                ["source_reference"] = before.Record!.Json.GetProperty("data").GetProperty("source_reference").GetString()!,
                ["body_sha256"] = before.Record!.Json.GetProperty("data").GetProperty("body_sha256").GetString()! };
            var validationCalls = 0;
            await using (var validationService = new LodestarService(runtime, (_, _) => {
                validationCalls++; throw new Exception("Invalid attestation must not dispatch even a read.");
            }, Path.Combine(root, "validation-journal")))
            {
                fields["reviewed_at"] = "2025-02-30";
                var invalid = await validationService.PrepareOperatorActionAsync("research-review", fields, project);
                if (invalid.Request is not null || validationCalls != 0 || invalid.Error?.Contains("No write was dispatched", StringComparison.Ordinal) != true)
                    throw new Exception("Invalid attestation reached transport or lost explicit no-write outcome.");
            }
            foreach (var invalid in new[] { "2025-02-30", "2025-2-03", "2025-13-01" })
            {
                fields["reviewed_at"] = invalid;
                var rejected = await service.PrepareOperatorActionAsync("research-review", fields, project);
                if (rejected.Request is not null || rejected.Error is null || !rejected.Error.Contains("date", StringComparison.OrdinalIgnoreCase))
                    throw new Exception("Invalid date must fail visibly without a frozen write: " + rejected.Error);
            }
            fields["reviewed_at"] = "2025-02-03";
            foreach (var valid in new[] { "0000-02-29", "2000-02-29", "2024-02-29", "9999-12-31" })
            {
                fields["reviewed_at"] = valid;
                fields["source_version"] = "";
                var accepted = await service.PrepareOperatorActionAsync("research-review", fields, project);
                if (accepted.Request is null) throw new Exception("Shared calendar date rejected: " + valid + ": " + accepted.Error);
                using var value = JsonDocument.Parse(accepted.Request.ExactRequestUtf8);
                if (value.RootElement.GetProperty("input").GetProperty("set").GetProperty("data").GetProperty("source_version").ValueKind != JsonValueKind.Null)
                    throw new Exception("Unknown source version did not remain explicit null.");
            }
            fields["reviewed_at"] = "2025-02-03"; fields["source_version"] = "v2";
            var sourceReference = fields["source_reference"]; fields["source_reference"] = "https://example.test/changed";
            var stale = await service.PrepareOperatorActionAsync("research-review", fields, project);
            if (stale.Request is not null || stale.Error?.Contains("Refresh the selected record", StringComparison.Ordinal) != true)
                throw new Exception("Changed source provenance was silently attested.");
            fields["source_reference"] = sourceReference;
            var review = await service.PrepareOperatorActionAsync("research-review", fields, project);
            if (review.Request is null) throw new Exception("Source review not prepared: " + review.Error);
            using var document = JsonDocument.Parse(review.Request.ExactRequestUtf8);
            var delta = document.RootElement.GetProperty("input").GetProperty("set").GetProperty("data");
            if (delta.GetProperty("review_acquisition").GetString() != "operator_attested" || delta.TryGetProperty("body", out _) || delta.TryGetProperty("source_reference", out _))
                throw new Exception("Review rewrote source or claimed automatic verification.");
            var saved = await service.SaveAsync(review.Request); if (!saved.Saved) throw new Exception(saved.Error);
            var after = await service.GetRecordAsync(create.Request.RecordId);
            var oldData = before.Record!.Json.GetProperty("data"); var data = after.Record!.Json.GetProperty("data");
            foreach (var key in new[] { "body", "source_reference", "body_sha256" })
                if (oldData.GetProperty(key).GetRawText() != data.GetProperty(key).GetRawText()) throw new Exception("Source provenance changed: " + key);
            if (data.GetProperty("reviewed_at").GetString() != "2025-02-03" || data.GetProperty("reviewed_by").GetString() != "Alex" ||
                data.GetProperty("source_version").GetString() != "v2" || after.Record.UpdatedAt == before.Record.UpdatedAt || service.PendingSaves().Count != 0)
                throw new Exception("Guarded attestation save lost fields, stored time or journal settlement.");
        }
        finally { Directory.Delete(root, true); }
    }

    public static async Task QueuedDeadlineAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-deadline-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var ownedPids = new List<int>();
        Exception? primaryFailure = null;
        var disposed = false;
        try
        {
            var database = Path.Combine(root, "test.db"); File.WriteAllText(database, "fixture");
            var cli = Path.Combine(root, "held.mjs");
            File.WriteAllText(cli, "import fs from 'node:fs'; fs.writeFileSync(process.argv.at(-1), 'started'); setTimeout(() => {}, 30000);");
            var runtime = new RuntimeSelection("fixture", "fixture",
                TestNodeRuntime.Resolve(), cli, database, "fixture");
            await using var transport = new CliTransport(null, process => {
                lock (ownedPids) ownedPids.Add(process.Id);
                return Task.CompletedTask;
            });
            var first = transport.ExecuteAsync(new("get", [Path.Combine(root, "first")], runtime, TimeSpan.FromSeconds(10)));
            var second = transport.ExecuteAsync(new("get", [Path.Combine(root, "second")], runtime, TimeSpan.FromSeconds(10)));
            var started = Stopwatch.StartNew();
            while (!File.Exists(Path.Combine(root, "first")) || !File.Exists(Path.Combine(root, "second")))
            {
                if (started.Elapsed > TimeSpan.FromSeconds(5)) throw new Exception("Held read children did not start.");
                await Task.Delay(10);
            }
            var marker = Path.Combine(root, "queued-write");
            var queued = transport.ExecuteAsync(new("put", [marker], runtime, TimeSpan.FromMilliseconds(150), true));
            var completed = await Task.WhenAny(queued, Task.Delay(1500));
            if (completed != queued) throw new Exception("Whole-call deadline expired while both slots were held, but queued mutation did not finish.");
            var result = await queued;
            if (result.Code != "timeout" || result.MayHaveCommitted || result.FailureStage != "admission" ||
                !result.Message.Contains("No write was dispatched", StringComparison.Ordinal) || File.Exists(marker))
                throw new Exception("Queued timeout lost admission phase/certainly-unsent guidance or started a write.");
            await transport.DisposeAsync();
            await Task.WhenAll(first, second);
            disposed = true;
        }
        catch (Exception error) { primaryFailure = error; throw; }
        finally
        {
            var live = ownedPids.Where(ProcessAlive).ToArray();
            Console.WriteLine($"Fixture cleanup queued: disposed={disposed}, primary={primaryFailure?.GetType().Name ?? "none"}, ownedPids={string.Join(',', ownedPids)}, livePids={string.Join(',', live)}, root={root}");
            try
            {
                var sharingRetries = 0;
                while (true)
                {
                    try { Directory.Delete(root, true); break; }
                    catch (IOException error) when (disposed && live.Length == 0 &&
                        error.HResult == unchecked((int)0x80070020) && sharingRetries < 20)
                    {
                        if (sharingRetries == 0)
                            Console.WriteLine($"Fixture cleanup queued sharing: owned tasks drained, livePids=, HRESULT=0x{error.HResult:X8}, maxDelays=20, delayMs=25, root={root}");
                        sharingRetries++;
                        await Task.Delay(25);
                    }
                }
                if (sharingRetries > 0)
                    Console.WriteLine($"Fixture cleanup queued sharing resolved: retries={sharingRetries}, root={root}");
            }
            catch (Exception cleanupError)
            {
                Console.Error.WriteLine($"Fixture cleanup queued failed: HRESULT=0x{cleanupError.HResult:X8}, livePids={string.Join(',', ownedPids.Where(ProcessAlive))}");
                if (primaryFailure is not null) throw new AggregateException("Queued test and owned fixture cleanup both failed.", primaryFailure, cleanupError);
                throw;
            }
        }
    }

    private static bool ProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        try { using var process = Process.GetProcessById(pid); return !process.HasExited; }
        catch (ArgumentException) { return false; }
    }
}
