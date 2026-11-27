using System.Diagnostics;
using System.Text.Json;
using Lodestar.Loader;

public static class RecoveryBridgeChecks
{
    public static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-shared-recovery-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var start = new ProcessStartInfo(TestNodeRuntime.Resolve()) {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "gap-recovery-fixture.mjs"));
            start.ArgumentList.Add(root);
            using (var child = Process.Start(start)!)
            {
                var output = child.StandardOutput.ReadToEndAsync(); var errors = child.StandardError.ReadToEndAsync();
                await child.WaitForExitAsync(); await output;
                if (child.ExitCode != 0) throw new Exception("Recovery fixture failed: " + await errors);
            }
            var runtime = await RuntimeConfig.LoadAsync(Path.Combine(root, "config", "interfaces.json"));
            using var expected = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(root, "expected.json")));
            var managerId = expected.RootElement.GetProperty("manager").GetString()!;
            var bareId = expected.RootElement.GetProperty("bare").GetString()!;
            var managerFolder = expected.RootElement.GetProperty("manager_folder").GetString()!;
            var original = File.ReadAllBytes(Path.Combine(managerFolder, "request.json"));
            await using var service = new LodestarService(runtime, journalRoot: Path.Combine(root, "config", "pending"));
            await service.DiscoverAsync();
            var listing = service.ReadPendingSaves();
            if (!listing.Items.Any(row => row.RequestId == managerId && row.ReplayEligible) ||
                !listing.Items.Any(row => row.RequestId == bareId && row.ReplayEligible))
                throw new Exception("Loader cannot enumerate the Manager and bare CLI requests. " + listing.Error +
                    " Items: " + string.Join("; ", listing.Items.Select(row => row.RequestId + ": " + row.Issue)));
            var health = LodestarHealth.Build(null, service.Capabilities, listing.Items);
            if (!health.Issues.Any()) throw new Exception("Health omitted unresolved cross-surface requests.");
            var contextFile = Path.Combine(managerFolder, "context.json");
            var contextBytes = File.ReadAllBytes(contextFile);
            await File.WriteAllTextAsync(contextFile, new string(' ', 16 * 1024 * 1024 + 1) +
                System.Text.Encoding.UTF8.GetString(contextBytes));
            var oversized = await service.RecoverAsync(managerId);
            if (oversized.Saved || oversized.Error?.Contains("bounded local journal", StringComparison.Ordinal) != true)
                throw new Exception("Shared recovery did not reject oversized local state before reading/dispatch: " + oversized.Error);
            if (!original.AsSpan().SequenceEqual(File.ReadAllBytes(Path.Combine(managerFolder, "request.json"))))
                throw new Exception("Oversized-state refusal changed the saved request.");
            await File.WriteAllBytesAsync(contextFile, contextBytes);
            var saved = await service.RecoverAsync(managerId);
            if (!saved.Saved) throw new Exception("Manager exact replay failed: " + saved.Error);
            if (!original.AsSpan().SequenceEqual(File.ReadAllBytes(Path.Combine(managerFolder, "request.json"))))
                throw new Exception("Cross-surface recovery changed request bytes.");
            var record = await service.GetRecordAsync("note:manager-pending");
            if (record.Record is null) throw new Exception("Recovered record is absent.");
            if (service.ReadPendingSaves().Items.Any(row => row.RequestId == managerId))
                throw new Exception("Confirmed receipt still appears unresolved.");
            var bare = await service.RecoverAsync(bareId);
            if (!bare.Saved || (await service.GetRecordAsync("note:cli-pending")).Record is null)
                throw new Exception("Bare CLI recovery failed: " + bare.Error);
            var linksOperation = service.Capabilities!.Operations.Single(operation => operation.Id == "links");
            var links = await service.RunReadAsync(linksOperation, new Dictionary<string,string?> {
                ["id"] = "note:manager-pending", ["limit"] = "1" });
            if (!links.Success || links.Envelope?.GetProperty("data").GetProperty("id").GetString() != "note:manager-pending")
                throw new Exception("The dedicated links route cannot use its typed read.");
            var nativeId = "ll-" + Guid.NewGuid().ToString("D");
            var instance = bare.Cli!.Envelope!.Value.GetProperty("database_instance_id").GetString()!;
            var epoch = bare.Cli.Envelope.Value.GetProperty("database_epoch").GetString()!;
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = nativeId,
                database_instance_id = instance, database_epoch = epoch, project_scope = (string?)null, checkout = (string?)null,
                actor = new { id = "user:fixture", agent = "human", harness = "loader", session = (string?)null },
                preconditions = new[] { new { target = new { kind = "record", id = "note:native-pending" }, expected_revision = (long?)null } },
                input = new { mode = "create", record = new { id = "note:native-pending", name = "Native pending", kind = "note", scope = "global",
                    availability = "known", data = new { body = "Preserved" }, aliases = Array.Empty<string>(), links = Array.Empty<object>(), sources = Array.Empty<object>() } } });
            var nativeFolder = Path.Combine(root, "config", "pending", nativeId);
            var nativeSaved = await service.SaveAsync(new(nativeId, "note:native-pending", runtime, instance, epoch, bytes, nativeFolder));
            if (!nativeSaved.Saved) throw new Exception("Native fixture save failed: " + nativeSaved.Error);
            File.Delete(Path.Combine(nativeFolder, "response.json"));
            var shared = await service.ExecuteAsync(new("recovery.list", ["recovery", "list", "--interface-config", runtime.ConfigPath], runtime, TimeSpan.FromSeconds(30)));
            var nativeRow = shared.Envelope!.Value.GetProperty("data").GetProperty("journals").EnumerateArray().Single(row => row.GetProperty("request_id").GetString() == nativeId);
            if (!nativeRow.GetProperty("replay_eligible").GetBoolean()) throw new Exception("Public adapter rejected real native fingerprint/context: " + nativeRow);
            var replay = await service.ExecuteAsync(new("put", ["recovery", "replay", nativeRow.GetProperty("key").GetString()!, "--interface-config", runtime.ConfigPath], runtime, TimeSpan.FromSeconds(30), true, Path.Combine(nativeFolder,"request.json")));
            if (!replay.Success || !replay.Envelope!.Value.GetProperty("request").GetProperty("replayed").GetBoolean() ||
                replay.Envelope.Value.GetProperty("revision").GetInt64() != nativeSaved.Cli!.Envelope!.Value.GetProperty("revision").GetInt64())
                throw new Exception("Public replay of a real native journal lost its original receipt/revision.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
