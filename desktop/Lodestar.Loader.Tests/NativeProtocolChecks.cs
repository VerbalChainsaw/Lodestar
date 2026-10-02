using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Lodestar.Loader;

internal static class NativeProtocolChecks
{
    private static void Require(bool condition, string message)
    { if (!condition) throw new Exception(message); }
    private static string Node() => TestNodeRuntime.Resolve();
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static byte[] BadUtf8(string text) => Encoding.UTF8.GetBytes(text[..text.IndexOf("TOKEN")])
        .Concat(new byte[] { 0xc3, 0x28 }).Concat(Encoding.UTF8.GetBytes(text[(text.IndexOf("TOKEN") + 5)..])).ToArray();
    private static string Root(string name)
    {
        var path = Path.Combine(Path.GetTempPath(), "ll-native-protocol-" + name + "-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path); return path;
    }

    public static async Task TransportBytesAsync()
    {
        MixedOutputChecks();
        var root = Root("transport");
        try
        {
            var db = Path.Combine(root, "fixture.db"); File.WriteAllText(db, "synthetic process; never opened");
            var cli = Path.Combine(root, "synthetic.mjs");
            var runtime = new RuntimeSelection("unused", "g", Node(), cli, db, "f");
            foreach (var mutation in new[] { false, true })
            foreach (var stream in new[] { "stdout", "stderr" })
            {
                var operation = mutation ? "put" : "get";
                var envelope = JsonSerializer.Serialize(new { v = 5, ok = true, operation, more = false,
                    next = Array.Empty<object>(), revision = 8, database_instance_id = "a", database_epoch = "b",
                    data = new { body = "TOKEN" } });
                foreach (var fault in new[] { "valid", "bad-utf8", "duplicate-v", "duplicate-ok", "duplicate-data", "duplicate-escaped-name" })
                {
                    var text = fault switch {
                        "duplicate-v" => envelope.Replace("\"v\":5", "\"v\":4,\"v\":5"),
                        "duplicate-ok" => envelope.Replace("\"ok\":true", "\"ok\":false,\"ok\":true"),
                        "duplicate-data" => envelope.Replace("\"body\":\"TOKEN\"", "\"body\":\"first\",\"body\":\"second\""),
                        "duplicate-escaped-name" => envelope.Replace("\"ok\":true", "\"o\\u006b\":false,\"ok\":true"),
                        _ => envelope.Replace("TOKEN", "é界") };
                    var bytes = fault == "bad-utf8" ? BadUtf8(envelope) : Encoding.UTF8.GetBytes(text);
                    File.WriteAllText(cli, "process." + stream + ".write(Buffer.from('" + Convert.ToBase64String(bytes) + "','base64'));" );
                    await using var transport = new CliTransport(new DiagnosticLog(Path.Combine(root, "diagnostics")), null);
                    var result = await transport.ExecuteAsync(new(operation, [operation], runtime, TimeSpan.FromSeconds(3), mutation));
                    if (fault == "valid") Require(result.Success && !result.MayHaveCommitted, "Valid multibyte response was rejected.");
                    else Require(!result.Success && result.Code == "protocol_error" && result.Envelope is null &&
                        result.MayHaveCommitted == mutation && result.Message.Contains("UTF-8", StringComparison.Ordinal),
                        fault + " was accepted or lost structured protocol/uncertainty guidance: " + result.Code + "/" + result.Success);
                }
            }
        }
        finally { Directory.Delete(root, true); }
    }

    private static void MixedOutputChecks()
    {
        var parse = typeof(CliTransport).GetMethod("Parse", BindingFlags.NonPublic | BindingFlags.Static)!;
        var runtime = new RuntimeSelection("unused", "g", "unused", "unused", "unused", "f");
        var good = "{\"v\":5,\"ok\":true,\"operation\":\"put\",\"more\":false,\"next\":[],\"revision\":1,\"database_instance_id\":\"a\",\"database_epoch\":\"b\",\"data\":{}}";
        var duplicate = good.Replace("\"ok\":true", "\"ok\":false,\"ok\":true");
        string EscapeNames(string text) => text.Replace("\"v\"", "\"\\u0076\"").Replace("\"ok\"", "\"\\u006fk\"")
            .Replace("\"operation\"", "\"\\u006fperation\"").Replace("\"data\"", "\"\\u0064ata\"");
        using var goodDocument = JsonDocument.Parse(good);
        var pretty = JsonSerializer.Serialize(goodDocument.RootElement, new JsonSerializerOptions { WriteIndented = true });
        var prettyDuplicate = pretty.Replace("\"ok\": true", "\"ok\": false,\n  \"ok\": true");
        using var bracesDocument = JsonDocument.Parse(good.Replace("\"data\":{}", "\"data\":" +
            JsonSerializer.Serialize(new { body = "literal { with a quote \" and backslash \\" })));
        var prettyBraces = JsonSerializer.Serialize(bracesDocument.RootElement, new JsonSerializerOptions { WriteIndented = true });
        var failures = new List<string>();
        foreach (var mutation in new[] { false, true })
        foreach (var (name, stdout, stderr, expectedSuccess) in new[] {
            ("literal duplicate", good, duplicate, false),
            ("BOM duplicate", good, "\uFEFF" + duplicate, false),
            ("escaped duplicate", good, EscapeNames(duplicate), false),
            ("BOM escaped duplicate", good, "\uFEFF" + EscapeNames(duplicate), false),
            ("escaped missing version", good, EscapeNames(good.Replace("\"v\":5,", "")), false),
            ("escaped truncated object", good, EscapeNames(good[..^3]), false),
            ("escaped key after malformed prefix", good, "{\"noise\":," + EscapeNames(good)[1..], false),
            ("valid escaped second envelope", good, EscapeNames(good), false),
            ("valid escaped sole envelope", EscapeNames(good), "", true),
            ("valid BOM escaped sole envelope", "\uFEFF" + EscapeNames(good), "", true),
            ("ordinary warning", good, "ordinary warning", true),
            ("ordinary JSON diagnostic", good, "{\"message\":\"data\"}", true),
            ("pretty second stderr envelope", good, pretty, false),
            ("pretty duplicate stderr envelope", good, prettyDuplicate, false),
            ("pretty escaped duplicate stderr envelope", good, EscapeNames(prettyDuplicate), false),
            ("pretty BOM duplicate stderr envelope", good, "\uFEFF" + prettyDuplicate, false),
            ("pretty incomplete escaped stderr", good, "{\n  \"\\u006fk\": false,", false),
            ("pretty sole stdout among warnings", "ordinary warning\n" + pretty + "\nordinary warning", "", true),
            ("pretty sole stderr among warnings", "", "ordinary warning\n" + pretty + "\nordinary warning", true),
            ("pretty sole BOM escaped stderr", "", "ordinary warning\n\uFEFF" + EscapeNames(pretty), true),
            ("pretty duplicate stderr after JSON diagnostic", good, "{\"message\":\"ordinary diagnostic\"}\n" + prettyDuplicate, false),
            ("pretty second stdout among warnings", good + "\nordinary warning\n" + pretty, "", false),
            ("pretty quoted brace stdout with warning", prettyBraces + "\nordinary warning", "", true),
            ("pretty quoted brace stderr with warning", "", prettyBraces + "\nordinary warning", true) })
        {
            var operation = mutation ? "put" : "get";
            var invocation = new CliInvocation(operation, [operation], runtime, TimeSpan.FromSeconds(1), mutation);
            var result = (CliResult)parse.Invoke(null, [invocation, 0,
                (stdout.Replace("\"put\"", "\"" + operation + "\""), false),
                (stderr.Replace("\"put\"", "\"" + operation + "\""), false), 0L, mutation])!;
            if (result.Success != expectedSuccess || !expectedSuccess &&
                (result.Code != "protocol_error" || result.MayHaveCommitted != mutation || result.Envelope is not null))
                failures.Add(name + "/" + operation + "=" + result.Success + "/" + result.Code + "/" + result.MayHaveCommitted);
        }
        Require(failures.Count == 0, "Mixed-output classifier: " + string.Join("; ", failures));
    }

    public static async Task PendingResponsesAsync()
    {
        var root = Root("journal");
        try
        {
            var runtime = new RuntimeSelection("unused", "g", "unused", "unused", "unused", "f");
            foreach (var fault in new[] { "valid", "bom", "bad-utf8", "duplicate-ok", "duplicate-nested", "missing" })
            {
                var journal = Path.Combine(root, fault);
                var id = "ll-" + Guid.NewGuid().ToString("D");
                var directory = Path.Combine(journal, id); Directory.CreateDirectory(directory);
                var request = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, request_id = id,
                    input = new { mode = "update", id = "fact:one" } });
                var hash = Hash(request);
                var context = JsonSerializer.SerializeToUtf8Bytes(new {
                    request_id = id, record_id = "fact:one", request_sha256 = hash, config = runtime.ConfigPath,
                    generation = runtime.Generation, fingerprint = runtime.Fingerprint, database = runtime.DatabasePath,
                    database_instance_id = "a", database_epoch = "b", operation = "put", prior_outcome_unknown = true,
                    dispatch_sha256 = Hash(JsonSerializer.SerializeToUtf8Bytes(new { operation = "put", cwd = (string?)null, request_sha256 = hash })) });
                File.WriteAllBytes(Path.Combine(directory, "request.json"), request);
                File.WriteAllBytes(Path.Combine(directory, "context.json"), context);
                var response = JsonSerializer.Serialize(new { v = 5, ok = true, operation = "put", more = false,
                    next = Array.Empty<object>(), revision = 8, database_instance_id = "a", database_epoch = "b",
                    receipt_id = "mutation-receipt:" + Hash(JsonSerializer.SerializeToUtf8Bytes(new[] { "a", "b", id })),
                    request = new { id, replayed = false, committed_revision = 8 }, data = new { id = "fact:one", body = "TOKEN" } });
                var text = fault switch {
                    "duplicate-ok" => response.Replace("\"ok\":true", "\"ok\":false,\"ok\":true"),
                    "duplicate-nested" => response.Replace("\"body\":\"TOKEN\"", "\"body\":\"first\",\"body\":\"second\""),
                    _ => response.Replace("TOKEN", "é界") };
                var bytes = fault == "bad-utf8" ? BadUtf8(response) : Encoding.UTF8.GetBytes(text);
                if (fault == "bom") bytes = Encoding.UTF8.GetPreamble().Concat(bytes).ToArray();
                if (fault != "missing") File.WriteAllBytes(Path.Combine(directory, "response.json"), bytes);
                await using var service = new LodestarService(runtime, journal);
                var pending = service.PendingSaves();
                if (fault is "valid" or "bom") Require(pending.Count == 0, "Valid cached success no longer settles.");
                else Require(pending.Count == 1 && pending[0].ReplayEligible && (fault == "missing" ||
                    pending[0].Issue?.Contains("preserved", StringComparison.Ordinal) == true),
                    fault + " hid an unresolved journal or lost preserved-byte recovery guidance.");
                Require(File.ReadAllBytes(Path.Combine(directory, "request.json")).SequenceEqual(request) &&
                    File.ReadAllBytes(Path.Combine(directory, "context.json")).SequenceEqual(context) &&
                    (fault == "missing" || File.ReadAllBytes(Path.Combine(directory, "response.json")).SequenceEqual(bytes)),
                    "Listing changed exact journal bytes.");
            }
            foreach (var fault in new[] { "bad-utf8", "duplicate-flag" })
            {
                var journal = Path.Combine(root, "context-" + fault);
                var id = "ll-" + Guid.NewGuid().ToString("D");
                var directory = Path.Combine(journal, id); Directory.CreateDirectory(directory);
                var request = Encoding.UTF8.GetBytes("{}");
                File.WriteAllBytes(Path.Combine(directory, "request.json"), request);
                var text = JsonSerializer.Serialize(new { request_id = id, prior_outcome_unknown = true, metadata = "TOKEN" });
                var bytes = fault == "bad-utf8" ? BadUtf8(text) : Encoding.UTF8.GetBytes(
                    text.Replace("\"prior_outcome_unknown\":true", "\"prior_outcome_unknown\":false,\"prior_outcome_unknown\":true"));
                File.WriteAllBytes(Path.Combine(directory, "context.json"), bytes);
                await using var service = new LodestarService(runtime, journal);
                var pending = service.PendingSaves();
                Require(pending.Count == 1 && !pending[0].ReplayEligible &&
                    pending[0].Issue?.Contains("Preserve", StringComparison.Ordinal) == true &&
                    File.ReadAllBytes(Path.Combine(directory, "context.json")).SequenceEqual(bytes),
                    "Malformed context lost blocked replay/preserved-byte inspection guidance.");
            }
        }
        finally { Directory.Delete(root, true); }
    }

    public static async Task SingularRootsAsync()
    {
        var root = Root("project");
        try
        {
            foreach (var plural in new[] { false, true })
            {
                var row = JsonSerializer.SerializeToElement(new { id = "project:one", kind = "project", scope = "global",
                    data = plural ? (object)new { roots = new[] { root } } : new { root },
                    semantics = new { applicability = new { project = "scope:one" } } });
                var record = RecordProjection.ReadRecord(row)!;
                var project = RecordProjection.Build([record], [], true).Projects[0];
                var calls = 0;
                await using var service = new LodestarService(new("unused", "g", "unused", "unused", "unused", "f"),
                    (invocation, _) => { calls++; return Task.FromResult(new CliResult(true,
                        JsonSerializer.SerializeToElement(new { data = new { project = new { id = project.Id, scope = "scope:one" } } }),
                        null, "OK", 0, "", 0)); }, Path.Combine(root, "journal"));
                var mapping = await service.ValidateProjectContextAsync(project);
                Require(project.Roots.SequenceEqual(new[] { root }) && mapping.Matched && calls == 1,
                    "Supported " + (plural ? "plural" : "singular") + " root was lost before native project mapping.");
            }
            var filtered = JsonSerializer.SerializeToElement(new { id = "project:filtered", kind = "project", scope = "global",
                data = new { roots = new object[] { "", 7, root }, root = "must-not-win" } });
            var projected = RecordProjection.Build([RecordProjection.ReadRecord(filtered)!], [], true).Projects[0];
            Require(projected.Roots.SequenceEqual(new[] { root }), "Array root precedence or malformed-entry filtering changed.");
        }
        finally { Directory.Delete(root, true); }
    }
}
