using System.Collections.Immutable;
using System.Text.Json;
using Lodestar.Loader;

public static class OperatorReadoutChecks
{
    public static Task RunAsync()
    {
        RecordProjectionRetainsStoredTruth();
        RecordProjectionLimitsKeepRawFallback();
        HealthUsesOnlyObservedLodestarFacts();
        DoctorMismatchCannotConfirmSelectedStore();
        return Task.CompletedTask;
    }

    private static void RecordProjectionRetainsStoredTruth()
    {
        foreach (var kind in new[] { "project", "note", "fact", "knowledge", "work", "handoff",
            "decision", "pending", "rejection" })
        {
            var record = Row(JsonSerializer.Serialize(new Dictionary<string, object?> {
                ["id"] = kind + ":1", ["kind"] = kind, ["scope"] = "global",
                ["data"] = new Dictionary<string, object?> {
                    ["status"] = "open", ["nested"] = new {
                        flag = false, count = 0, nothing = (string?)null,
                        array = new object?[] { 1, false, null }
                    }, ["unusual/key"] = "kept"
                }, ["custom"] = new { value = "top" }
            }));
            var readout = ReadableRecord.Project(record);
            Check(readout.Headline == $"{kind}:1", "Missing name lost its ID fallback.");
            Check(readout.State == "Recorded status: open", "A stored status was not labeled as recorded.");
            Check(readout.Sections.Any(section => section.Heading != "Record data" &&
                section.Heading != "Stored identity"), $"No kind-specific section for {kind}.");
            Check(Find(readout, "/data/nested/flag") is { Value: "false", Type: "boolean" },
                "false was lost or confused with missing.");
            Check(Find(readout, "/data/nested/count") is { Value: "0", Type: "number" },
                "zero was lost or confused with missing.");
            Check(Find(readout, "/data/nested/nothing") is { Value: "null", Type: "null" },
                "null was lost or confused with missing.");
            Check(Find(readout, "/data/nested/array/1") is { Value: "false" },
                "Array item was lost.");
            Check(Find(readout, "/data/unusual~1key") is { Value: "kept" },
                "Escaped pointer or unknown field was lost.");
            Check(Find(readout, "/custom/value") is { Value: "top" },
                "Unknown top-level field was lost.");
            Check(readout.RawJson.Contains("\"custom\""), "Raw fallback omitted source data.");
        }

        var absent = ReadableRecord.Project(Row("""{"id":"work:2","kind":"work","scope":"global"}"""));
        Check(absent.State == "No status recorded.", "Missing status was invented.");
        Check(Find(absent, "/data") is { Value: "Not recorded", Type: "missing" },
            "Missing data did not remain distinct from null.");
        var nullStatus = ReadableRecord.Project(Row("""{"id":"work:3","kind":"work","scope":"global","data":{"status":null}}"""));
        Check(nullStatus.State == "Recorded status: null", "Present null status was treated as missing.");
    }

    private static void RecordProjectionLimitsKeepRawFallback()
    {
        var large = JsonSerializer.Serialize(new { id = "note:large", kind = "note", scope = "global",
            data = Enumerable.Range(0, ReadableRecord.MaxNodes + 50)
                .ToDictionary(index => "field_" + index, index => index) });
        var readout = ReadableRecord.Project(Row(large));
        Check(readout.Truncated && readout.LimitNotice?.Contains("raw JSON") == true,
            "Node budget did not disclose omitted content.");
        Check(readout.RawJson.Contains("field_349"), "Raw fallback lost a field beyond the tree budget.");
        Check(readout.Sections.SelectMany(section => section.Items)
            .Any(item => item.Truncated), "Tree has no visible limit marker.");

        var longText = new string('x', ReadableRecord.MaxScalarCharacters + 30);
        var scalar = ReadableRecord.Project(Row(JsonSerializer.Serialize(new {
            id = "note:long", kind = "note", scope = "global", data = new { body = longText }
        })));
        Check(Find(scalar, "/data/body") is { Truncated: true }, "Long scalar limit was hidden.");
        Check(scalar.RawJson.Contains(longText), "Long scalar disappeared from raw fallback.");
    }

    private static void HealthUsesOnlyObservedLodestarFacts()
    {
        var empty = LodestarHealth.Build(null, null, null);
        Check(Observation(empty, "Store integrity") is { Value: "Not checked", State: "unknown" },
            "Absent doctor result was treated as a pass.");
        Check(Observation(empty, "Unresolved saves") is { Value: "Not checked" },
            "Uninspected pending saves were treated as zero.");

        var library = Library(complete: true, revision: 0);
        var capabilities = new CapabilitySnapshot(1, [],
            new("config", "generation", "node", "cli", "database", "fingerprint"),
            DateTimeOffset.UtcNow, null);
        var observed = LodestarHealth.Build(library, capabilities, []);
        Check(Observation(observed, "Store revision") is { Value: "0" }, "Revision zero was treated as absent.");
        Check(Observation(observed, "Store integrity") is { State: "unknown" },
            "A complete library was confused with an integrity check.");
        Check(Observation(observed, "Lodestar release version") is { State: "unknown" },
            "Capability contract version was mislabeled as product version.");
        var counted = LodestarHealth.Build(library with {
            Records = [Row("""{"id":"fact:one","kind":"fact","scope":"global"}""")], LoadedCount = 2
        }, capabilities, []);
        Check(Observation(counted, "Current records") is { Value: "1" } &&
            Observation(counted, "Normalized rows") is { Value: "2" },
            "Catalog and current scan rows were confused with current record count.");
        var malformed = LodestarHealth.Build(library with { LoadedCount = 2,
            RecordErrors = ["One stored row could not be normalized"] }, capabilities, []);
        Check(Observation(malformed, "Normalized rows") is { Value: "2" } &&
            malformed.Issues.Any(issue => issue.ActionKey == "record-errors"),
            "Successful normalization count or rejected-row issue was lost.");
        var contextRead = new CapabilityOperation("work.status", ["work", "status"],
            "Read project work", "read", Parse("{}"), false, "Requires selected project context");
        var adapters = LodestarHealth.Build(library, capabilities with { Operations = [contextRead] }, []);
        Check(adapters.Issues.Length == 0 &&
            Observation(adapters, "Generic command forms") is { Value: "0 of 1 reads" },
            "A context-specific read adapter was reported as a health issue.");

        var pending = new PendingSave("request", "work:1", "database", DateTimeOffset.UtcNow, "journal");
        var withPending = LodestarHealth.Build(library, capabilities, [pending]);
        Check(Observation(withPending, "Unresolved saves") is { Value: "1", State: "attention" },
            "Pending save count was not surfaced.");
        Check(withPending.Issues.Any(issue => issue.ActionKey == "pending-saves"),
            "Pending save issue lacks its view action.");

        var doctor = new CliResult(true, Parse("""{"v":5,"ok":true,"operation":"doctor","data":{"healthy":false,"database_instance_id":"instance","database_epoch":"epoch","database_revision":0,"schema_version":5,"checks":{"integrity":"failed","foreign_key_violations":0,"expected_tables":false},"issues":[{"code":"integrity_error","message":"Structural error"}]}}"""),
            null, "Doctor completed", 4, "", 5);
        var checkedHealth = LodestarHealth.Build(library, capabilities, [], doctor);
        Check(Observation(checkedHealth, "Doctor result") is { State: "attention" },
            "Doctor diagnostic exit was lost.");
        Check(Observation(checkedHealth, "SQLite integrity") is { Value: "failed", State: "attention" },
            "Explicit failed integrity check was lost.");
        Check(checkedHealth.Issues.Any(issue => issue.ActionKey == "doctor" &&
            issue.Message.Contains("Structural error")), "Doctor issue or action was lost.");
    }

    private static void DoctorMismatchCannotConfirmSelectedStore()
    {
        var doctor = new CliResult(true, Parse("""{"operation":"doctor","data":{"healthy":true,"database_instance_id":"different","database_epoch":"epoch","checks":{"integrity":"ok"},"issues":[]}}"""),
            null, "OK", 0, "", 1);
        var health = LodestarHealth.Build(Library(true, 8), null, [], doctor);
        Check(Observation(health, "Store integrity") is { State: "unknown" },
            "Doctor result from another store was accepted.");
        Check(health.Issues.Any(issue => issue.ActionKey == "doctor" &&
            issue.Message.Contains("loaded store")), "Store mismatch was not explained.");
    }

    private static LibrarySnapshot Library(bool complete, long revision) =>
        new([], [], [], [], "instance", "epoch", revision, DateTimeOffset.UtcNow,
            complete, 0, [], [], null);

    private static LibraryRecord Row(string text) => RecordProjection.ReadRecord(Parse(text))!;

    private static JsonElement Parse(string text) => JsonDocument.Parse(text).RootElement.Clone();

    private static ReadoutNode? Find(OperatorRecordReadout readout, string path) =>
        readout.Sections.SelectMany(section => section.Items)
            .SelectMany(Flatten).FirstOrDefault(node => node.Path == path);

    private static IEnumerable<ReadoutNode> Flatten(ReadoutNode node)
    {
        yield return node;
        foreach (var child in node.Children)
            foreach (var nested in Flatten(child)) yield return nested;
    }

    private static HealthObservation? Observation(LodestarHealthSnapshot snapshot, string label) =>
        snapshot.Observations.FirstOrDefault(item => item.Label == label);

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception("Operator readout: " + message);
    }
}
