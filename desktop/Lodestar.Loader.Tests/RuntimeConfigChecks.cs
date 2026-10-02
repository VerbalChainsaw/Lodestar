using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Lodestar.Loader;

internal static class RuntimeConfigChecks
{
    public static async Task RunAsync()
    {
        var parent = Path.Combine(Path.GetTempPath(), "runtime-config-" + Guid.NewGuid().ToString("N"));
        var root = Path.Combine(parent, "app");
        Directory.CreateDirectory(Path.Combine(root, "core"));
        try
        {
            var node = Path.Combine(root, "node.fixture");
            var cli = Path.Combine(root, "core", "lodestar.mjs");
            await File.WriteAllTextAsync(node, "node"); await File.WriteAllTextAsync(cli, "fixture");
            await File.WriteAllTextAsync(Path.GetFullPath(Path.Combine(root, "../a.db")), "a");
            await File.WriteAllTextAsync(Path.GetFullPath(Path.Combine(root, "../b.db")), "b");
            var config = JsonSerializer.Serialize(new { v = 1, generation = "12345678-1234-4234-8234-123456789abc",
                runtime = new { node, cli = "core/lodestar.mjs", database = "../a.db" }, legacy = new { extra = true } });
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("fixture"))).ToLowerInvariant();
            var manifest = JsonSerializer.Serialize(new { v = 1, files = new[] { new { path = "core/lodestar.mjs", bytes = 7, sha256 = hash } } });
            var file = Path.Combine(root, "interfaces.json");
            var manifestFile = Path.Combine(root, "bundle-manifest.json");
            await File.WriteAllTextAsync(manifestFile, manifest);
            var failures = new List<string>();
            await File.WriteAllTextAsync(file, config);
            if ((await RuntimeConfig.LoadAsync(file)).DatabasePath != Path.GetFullPath(Path.Combine(root, "../a.db")))
                throw new Exception("Ordinary legacy config selection changed.");
            async Task Reject(string target, byte[] bytes, string field, bool numeric = false)
            {
                await File.WriteAllBytesAsync(target, bytes);
                try { await RuntimeConfig.LoadAsync(file); failures.Add("Accepted corrupt binding: " + target + " " + field); }
                catch (InvalidDataException error)
                {
                    if (!error.Message.Contains(target) || !error.Message.Contains(field) || !error.Message.Contains("Next action:"))
                        failures.Add("Unclear binding diagnostic: " + error.Message);
                    if (numeric && (!error.Message.Contains("exact numeric") || error.Message.Contains("Use a string")))
                        failures.Add("Unclear required numeric correction: " + error.Message);
                }
                if (!(await File.ReadAllBytesAsync(target)).SequenceEqual(bytes)) throw new Exception("Binding bytes changed.");
            }
            foreach (var (text, field) in new[] {
                (config.Replace("\"database\":\"../a.db\"", "\"database\":\"../a.db\",\"database\":\"../b.db\""), "/runtime/database"),
                (config.Replace("\"v\":1", "\"generation\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\",\"v\":1"), "/generation"),
                (config.Replace("\"database\":\"../a.db\"", "\"database\":\"../a.db\",\"data\\u0062ase\":\"../b.db\""), "/runtime/database") })
                await Reject(file, Encoding.UTF8.GetBytes(text), field);
            var bad = Encoding.UTF8.GetBytes(config[..^1] + ",\"extra\":\"").Concat(new byte[] { 0xc3, 0x28 })
                .Concat(Encoding.UTF8.GetBytes("\"}")).ToArray();
            await Reject(file, bad, "UTF-8");
            await Reject(file, Encoding.UTF8.GetBytes("{\"v\":1,"), "valid JSON");
            await Reject(file, Encoding.UTF8.GetBytes(config.Replace("\"v\":1", "\"v\":1.0000000000000001")), "/v", numeric: true);
            await File.WriteAllTextAsync(file, config);
            await Reject(manifestFile, Encoding.UTF8.GetBytes(manifest.Replace($"\"sha256\":\"{hash}\"",
                $"\"sha256\":\"{new string('0', 64)}\",\"sha256\":\"{hash}\"")), "/files/0/sha256");
            await Reject(manifestFile, Encoding.UTF8.GetBytes(manifest[..^1] + ",\"extra\":\"")
                .Concat(new byte[] { 0xc3, 0x28 }).Concat(Encoding.UTF8.GetBytes("\"}")).ToArray(), "UTF-8");
            await Reject(manifestFile, Encoding.UTF8.GetBytes(manifest.Replace("\"v\":1", "\"v\":1.0000000000000001")), "/v", numeric: true);
            await Reject(manifestFile, Encoding.UTF8.GetBytes(manifest.Replace("\"bytes\":7", "\"bytes\":6.9999999999999999")), "/files/0/bytes", numeric: true);
            await Reject(manifestFile, Encoding.UTF8.GetBytes(manifest.Replace("\"files\":[", "\"files\":[{\"path\":\"other/ignored\",\"bytes\":0.1234567890123456789},")
                .Replace("\"bytes\":7", "\"bytes\":6.9999999999999999")), "/files/1/bytes", numeric: true);
            await File.WriteAllTextAsync(file, config, new UTF8Encoding(true));
            await File.WriteAllTextAsync(manifestFile, manifest, new UTF8Encoding(true));
            var before = await File.ReadAllBytesAsync(file);
            var selection = await RuntimeConfig.LoadAsync(file);
            if (selection.CoreSourceBasis != "verified_manifest_core" || selection.CoreSourceDigest?.Length != 64)
                throw new Exception("Verified manifest core identity was not exposed.");
            await AssertSharedIdentityAsync(file, selection);
            if (selection.DatabasePath != Path.GetFullPath(Path.Combine(root, "../a.db"))) throw new Exception("Legacy selection changed.");
            if (!(await File.ReadAllBytesAsync(file)).SequenceEqual(before)) throw new Exception("Valid BOM bytes changed.");
            if (failures.Count > 0) throw new Exception(string.Join("\n", failures));
            foreach (var numeric in new[] { "9007199254740992", "0.1234567890123456789" })
            {
                var configBytes = Encoding.UTF8.GetBytes(config.Replace("\"extra\":true", $"\"extra\":true,\"number\":{numeric}"));
                var manifestBytes = Encoding.UTF8.GetBytes(manifest[..^1] + $",\"legacy\":{{\"number\":{numeric}}}}}");
                await File.WriteAllBytesAsync(file, configBytes); await File.WriteAllBytesAsync(manifestFile, manifestBytes);
                if ((await RuntimeConfig.LoadAsync(file)).DatabasePath != Path.GetFullPath(Path.Combine(root, "../a.db")))
                    throw new Exception("Ignored legacy numeric field changed binding.");
                if (!(await File.ReadAllBytesAsync(file)).SequenceEqual(configBytes) ||
                    !(await File.ReadAllBytesAsync(manifestFile)).SequenceEqual(manifestBytes))
                    throw new Exception("Ignored legacy numeric document bytes changed.");
            }
            var ignoredConfig = Encoding.UTF8.GetBytes(config[..^1] + ",\"bytes\":6.9999999999999999,\"files\":[{\"path\":\"core/ignored\",\"bytes\":9007199254740992}],\"ui\":{\"v\":1.0000000000000001}}");
            var ignoredManifest = Encoding.UTF8.GetBytes(manifest.Replace("\"files\":[", "\"files\":[{\"path\":\"other/ignored\",\"bytes\":6.9999999999999999,\"v\":1.0000000000000001},")
                .Replace("\"bytes\":7,", "\"bytes\":7,\"metadata\":{\"bytes\":9007199254740992},"));
            await File.WriteAllBytesAsync(file, ignoredConfig); await File.WriteAllBytesAsync(manifestFile, ignoredManifest);
            if ((await RuntimeConfig.LoadAsync(file)).DatabasePath != Path.GetFullPath(Path.Combine(root, "../a.db")) ||
                !(await File.ReadAllBytesAsync(file)).SequenceEqual(ignoredConfig) ||
                !(await File.ReadAllBytesAsync(manifestFile)).SequenceEqual(ignoredManifest))
                throw new Exception("Ignored numeric metadata compatibility changed.");
            var sourceRoot = Path.Combine(root, "source"); Directory.CreateDirectory(sourceRoot);
            var sourceCli = Path.Combine(sourceRoot, "lodestar.mjs");
            await File.WriteAllTextAsync(sourceCli, "version='3.0.0';//A");
            await File.WriteAllTextAsync(Path.Combine(sourceRoot,"package.json"), "{\"version\":\"3.0.0\"}");
            var sourceBinding = Path.Combine(sourceRoot,"interfaces.json");
            await File.WriteAllTextAsync(sourceBinding, JsonSerializer.Serialize(new { v=1, generation="12345678-1234-4234-8234-123456789abc", runtime=new {node,cli=sourceCli,database=Path.GetFullPath(Path.Combine(root,"../a.db"))} }));
            var sourceA = await RuntimeConfig.LoadAsync(sourceBinding);
            await AssertSharedIdentityAsync(sourceBinding, sourceA);
            await File.WriteAllTextAsync(sourceCli,"version='3.0.0';//B"); var sourceB = await RuntimeConfig.LoadAsync(sourceBinding);
            if (sourceA.CoreSourceBasis != "source_inventory" || sourceA.CoreSourceDigest == sourceB.CoreSourceDigest || sourceA.Fingerprint == sourceB.Fingerprint)
                throw new Exception("Equal release labels concealed changed source bytes.");
            await AssertSharedIdentityAsync(sourceBinding, sourceB);
        }
        finally { Directory.Delete(parent, true); }
    }

    private static async Task AssertSharedIdentityAsync(string config, RuntimeSelection observed)
    {
        var start = new System.Diagnostics.ProcessStartInfo(TestNodeRuntime.Resolve()) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory,"identity-fixture.mjs")); start.ArgumentList.Add(config);
        using var child = System.Diagnostics.Process.Start(start)!;
        var output = child.StandardOutput.ReadToEndAsync(); var error = child.StandardError.ReadToEndAsync(); await child.WaitForExitAsync();
        if (child.ExitCode != 0) throw new Exception("Shared fixture core identity failed: " + await error);
        using var result = JsonDocument.Parse(await output);
        if (result.RootElement.GetProperty("coreSourceDigest").GetString() != observed.CoreSourceDigest || result.RootElement.GetProperty("coreSourceBasis").GetString() != observed.CoreSourceBasis)
            throw new Exception("JS/C# disagreed about digest/basis from the same actual source/manifest fixture.");
    }
}
