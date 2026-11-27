using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Lodestar.Loader;

internal static class RuntimePathBoundaryChecks
{
    public static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "portable-db-boundary-" + Guid.NewGuid().ToString("N"));
        var app = Path.Combine(root, "app");
        Directory.CreateDirectory(Path.Combine(app, "core"));
        try
        {
            var node = Path.Combine(root, "node.fixture");
            await File.WriteAllTextAsync(node, "node");
            await File.WriteAllTextAsync(Path.Combine(app, "core", "lodestar.mjs"), "fixture");
            await File.WriteAllTextAsync(Path.Combine(app, "bundle-manifest.json"), JsonSerializer.Serialize(new { v = 1,
                files = new[] { new { path = "core/lodestar.mjs", bytes = 7,
                    sha256 = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("fixture"))).ToLowerInvariant() } } }));
            var file = Path.Combine(app, "interfaces.json");
            async Task<(string Database, byte[] Config, byte[] Store)> Bind(string database, bool source = false)
            {
                var resolved = Path.GetFullPath(Path.Combine(app, database));
                Directory.CreateDirectory(Path.GetDirectoryName(resolved)!);
                await File.WriteAllTextAsync(resolved, "existing-store-witness");
                await File.WriteAllTextAsync(file, JsonSerializer.Serialize(new { v = 1,
                    generation = "12345678-1234-4234-8234-123456789abc",
                    runtime = new { node, cli = source ? "lodestar.mjs" : "core/lodestar.mjs", database } }));
                return (resolved, await File.ReadAllBytesAsync(file), await File.ReadAllBytesAsync(resolved));
            }
            var failures = new List<string>();
            foreach (var database in new[] { Path.Combine(app, "store.db"), "core/../store.db",
                Path.Combine(app.ToUpperInvariant(), "store.db"), Path.Combine(app + ".lodestar-stage", "store.db"),
                Path.Combine(app + ".lodestar-previous", "store.db") })
            {
                var before = await Bind(database);
                try { await RuntimeConfig.LoadAsync(file); failures.Add("Accepted protected database: " + database); }
                catch (InvalidDataException error)
                {
                    if (!error.Message.Contains(file) || !error.Message.Contains("/runtime/database") ||
                        !error.Message.Contains(before.Database) || !error.Message.Contains("Next action:") ||
                        !error.Message.Contains("outside") || !error.Message.Contains("staging") || !error.Message.Contains("previous"))
                        failures.Add("Missing corrective database diagnostic: " + error.Message);
                }
                if (!(await File.ReadAllBytesAsync(file)).SequenceEqual(before.Config) ||
                    !(await File.ReadAllBytesAsync(before.Database)).SequenceEqual(before.Store))
                    throw new Exception("Rejected selection changed config or existing store bytes.");
            }
            foreach (var suffix in new[] { "-external", ".lodestar-stage-external", ".lodestar-previous-external" })
            {
                var before = await Bind(Path.Combine(app + suffix, "store.db"));
                if ((await RuntimeConfig.LoadAsync(file)).DatabasePath != before.Database ||
                    !(await File.ReadAllBytesAsync(file)).SequenceEqual(before.Config) ||
                    !(await File.ReadAllBytesAsync(before.Database)).SequenceEqual(before.Store))
                    throw new Exception("Legitimate external prefix sibling changed selection or bytes.");
            }
            var original = await Bind("store.db");
            var alias = Path.Combine(root, "external-alias");
            var start = new ProcessStartInfo(TestNodeRuntime.Resolve()) { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardError = true, RedirectStandardOutput = true };
            start.ArgumentList.Add("--input-type=module"); start.ArgumentList.Add("-e");
            start.ArgumentList.Add("import {symlink} from 'node:fs/promises'; await symlink(process.argv[1], process.argv[2], process.platform==='win32'?'junction':'dir');");
            start.ArgumentList.Add(app); start.ArgumentList.Add(alias);
            using (var child = Process.Start(start)!)
            {
                var error = child.StandardError.ReadToEndAsync(); await child.WaitForExitAsync();
                if (child.ExitCode != 0) throw new Exception("Reparse fixture could not be created: " + await error);
            }
            var aliased = await Bind(Path.Combine(alias, "store.db"));
            try { await RuntimeConfig.LoadAsync(file); failures.Add("Accepted reparse database ancestor alias."); }
            catch (InvalidDataException error)
            {
                if (!error.Message.Contains("/runtime/database") || !error.Message.Contains("plain directories"))
                    failures.Add("Reparse alias diagnostic lacks corrective guidance: " + error.Message);
            }
            if (!(await File.ReadAllBytesAsync(file)).SequenceEqual(aliased.Config) ||
                !(await File.ReadAllBytesAsync(original.Database)).SequenceEqual(original.Store))
                throw new Exception("Alias rejection changed config or store bytes.");
            var external = await Bind(Path.Combine(app + "-external", "store.db"));
            try { await RuntimeConfig.LoadAsync(Path.Combine(alias, "interfaces.json")); failures.Add("Accepted reparse app root ancestor."); }
            catch (InvalidDataException error)
            {
                if (!error.Message.Contains("/runtime/database") || !error.Message.Contains("plain directories"))
                    failures.Add("Reparse app root diagnostic lacks corrective guidance: " + error.Message);
            }
            if (!(await File.ReadAllBytesAsync(file)).SequenceEqual(external.Config) ||
                !(await File.ReadAllBytesAsync(external.Database)).SequenceEqual(external.Store))
                throw new Exception("App root alias rejection changed config or store bytes.");
            File.Delete(Path.Combine(app, "bundle-manifest.json"));
            await File.WriteAllTextAsync(Path.Combine(app, "lodestar.mjs"), "source");
            var source = await Bind("source.db", source: true);
            if ((await RuntimeConfig.LoadAsync(file)).DatabasePath != source.Database)
                throw new Exception("Generic source app-local explicit database semantics changed.");
            if (failures.Count != 0) throw new Exception(string.Join('\n', failures));
        }
        finally
        {
            var alias = Path.Combine(root, "external-alias");
            if (Directory.Exists(alias)) Directory.Delete(alias);
            Directory.Delete(root, true);
        }
    }
}
