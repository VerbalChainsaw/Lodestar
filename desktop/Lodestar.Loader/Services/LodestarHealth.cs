using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;

namespace Lodestar.Loader;

// A passive projection of already observed Lodestar results. Calling Build never
// invokes the CLI, reads the database, or checks the host machine.
public static class LodestarHealth
{
    public static LodestarHealthSnapshot Build(LibrarySnapshot? library,
        CapabilitySnapshot? capabilities, IReadOnlyList<PendingSave>? pendingSaves,
        CliResult? doctor = null)
    {
        var observations = ImmutableArray.CreateBuilder<HealthObservation>();
        var issues = ImmutableArray.CreateBuilder<HealthIssue>();
        var attention = false;
        var observed = false;

        if (library is null)
            observations.Add(new("Library", "Not checked", "unknown"));
        else
        {
            observed = true;
            observations.Add(new("Library read", library.CatalogOnly ? "Project catalog only" :
                library.Complete ? "Complete" : "Incomplete", library.Complete ? "ok" : "attention",
                $"Read at {library.ReadAt:O}"));
            observations.Add(new("Store revision", library.Revision?.ToString(CultureInfo.InvariantCulture)
                ?? "Not reported", library.Revision.HasValue ? "observed" : "unknown"));
            observations.Add(new("Current records", Count(library.Records), "observed"));
            observations.Add(new("Normalized rows", library.LoadedCount.ToString(CultureInfo.InvariantCulture),
                "observed"));
            observations.Add(new("Projects", Count(library.Projects), "observed"));
            observations.Add(new("Unassigned records", Count(library.Unassigned), "observed"));
            observations.Add(new("Store instance", library.DatabaseInstanceId ?? "Not reported",
                library.DatabaseInstanceId is null ? "unknown" : "observed"));
            observations.Add(new("Store epoch", library.DatabaseEpoch ?? "Not reported",
                library.DatabaseEpoch is null ? "unknown" : "observed"));
            if (!library.Complete) attention = true;
            if (library.Error is not null) { issues.Add(new("Library: " + library.Error, "refresh")); attention = true; }
            foreach (var error in Items(library.RecordErrors)) { issues.Add(new("Record read: " + error, "record-errors")); attention = true; }
            foreach (var issue in Items(library.Issues))
            {
                issues.Add(new($"Record {issue.Id ?? "(unidentified)"}: {issue.Code}: {issue.Message}", "record-errors"));
                attention = true;
            }
            foreach (var advisory in Items(library.Advisories)) issues.Add(new("Advisory: " + advisory, "refresh"));
        }

        if (capabilities is null)
            observations.Add(new("Capabilities", "Not checked", "unknown"));
        else
        {
            observed = true;
            observations.Add(new("Capability contract", capabilities.Version?.ToString(CultureInfo.InvariantCulture)
                ?? "Not reported", capabilities.Error is null ? "observed" : "attention"));
            observations.Add(new("Described operations", Count(capabilities.Operations), "observed"));
            var read = Items(capabilities.Operations).Where(operation => operation.Effect == "read").ToArray();
            observations.Add(new("Generic command forms",
                $"{read.Count(operation => operation.CanRunGenericRead)} of {read.Length} reads",
                "observed", "Other reads use dedicated project views or Manager."));
            observations.Add(new("Runtime generation", capabilities.Runtime.Generation, "observed"));
            observations.Add(new("Selected CLI", capabilities.Runtime.CliPath, "observed"));
            // Capability version is a schema version, not an installed Lodestar release version.
            observations.Add(new("Lodestar release version", capabilities.ReleaseVersion ?? "Not reported",
                capabilities.ReleaseVersion is null ? "unknown" : "observed"));
            if (capabilities.Error is not null)
            { issues.Add(new("Capabilities: " + capabilities.Error, "connection")); attention = true; }
        }

        if (pendingSaves is null)
            observations.Add(new("Unresolved saves", "Not checked", "unknown"));
        else
        {
            observed = true;
            observations.Add(new("Unresolved saves", pendingSaves.Count.ToString(CultureInfo.InvariantCulture),
                pendingSaves.Count == 0 ? "ok" : "attention"));
            foreach (var pending in pendingSaves)
                issues.Add(new(pending.ReplayEligible
                    ? $"Unresolved {pending.OperationId} request {pending.RequestId} for {pending.RecordId}; outcome requires review."
                    : $"Incomplete {pending.OperationId} journal {pending.RequestId}; replay is blocked. Inspect {pending.JournalDirectory}: {pending.Issue}",
                    "pending-saves"));
            if (pendingSaves.Count > 0) attention = true;
        }

        if (doctor is null)
            observations.Add(new("Store integrity", "Not checked", "unknown",
                "Run the public Lodestar doctor read explicitly to inspect integrity."));
        else
        {
            observed = true;
            ProjectDoctor(doctor, library, observations, issues, ref attention);
        }

        return new(attention ? "Lodestar needs review" : observed ? "Lodestar observations" :
            "Lodestar not checked", attention ? "attention" : observed ? "observed" : "unknown",
            DateTimeOffset.UtcNow, observations.ToImmutable(), issues.ToImmutable());
    }

    private static void ProjectDoctor(CliResult result, LibrarySnapshot? library,
        ImmutableArray<HealthObservation>.Builder observations,
        ImmutableArray<HealthIssue>.Builder issues, ref bool attention)
    {
        if (!result.Success || result.Envelope is not { ValueKind: JsonValueKind.Object } envelope ||
            JsonData.String(envelope, "operation") != "doctor" ||
            !JsonData.TryObject(envelope, "data", out var data))
        {
            observations.Add(new("Store integrity", "Unknown; doctor did not return a usable result", "unknown"));
            issues.Add(new("Doctor read: " + result.Message, "doctor"));
            attention = true;
            return;
        }

        var instance = JsonData.String(data, "database_instance_id");
        var epoch = JsonData.String(data, "database_epoch");
        if (library is not null &&
            (library.DatabaseInstanceId is not null && library.DatabaseInstanceId != instance ||
             library.DatabaseEpoch is not null && library.DatabaseEpoch != epoch))
        {
            observations.Add(new("Store integrity", "Unknown for selected library", "unknown"));
            issues.Add(new("Doctor result does not identify the loaded store instance and epoch.", "doctor"));
            attention = true;
            return;
        }

        if (JsonData.TryBool(data, "healthy", out var healthy))
        {
            observations.Add(new("Doctor result", healthy ? "Healthy when checked" : "Issues reported",
                healthy ? "ok" : "attention"));
            if (!healthy) attention = true;
        }
        else observations.Add(new("Doctor result", "Not reported", "unknown"));

        observations.Add(new("Doctor store revision", JsonData.Property(data, "database_revision") is { } revision
            ? Value(revision) : "Not reported", "observed"));
        observations.Add(new("Doctor schema version", JsonData.Property(data, "schema_version") is { } schema
            ? Value(schema) : "Not reported", "observed"));

        if (!JsonData.TryObject(data, "checks", out var checks))
            observations.Add(new("Integrity checks", "Not reported", "unknown"));
        else
        {
            AddCheck(checks, "integrity", "SQLite integrity", observations, ref attention);
            AddCheck(checks, "foreign_key_violations", "Foreign key violations", observations,
                ref attention);
            AddCheck(checks, "expected_tables", "Expected tables", observations, ref attention);
            AddCheck(checks, "expected_indexes", "Expected indexes", observations, ref attention);
            AddCheck(checks, "expected_definitions", "Expected definitions", observations, ref attention);
            AddCheck(checks, "decisions", "Decision records", observations, ref attention);
            AddCheck(checks, "handoff", "Handoff records", observations, ref attention);
        }

        if (!JsonData.TryArray(data, "issues", out var reported))
            observations.Add(new("Doctor issues", "Not reported", "unknown"));
        else
        {
            observations.Add(new("Doctor issues", reported.GetArrayLength().ToString(CultureInfo.InvariantCulture),
                reported.GetArrayLength() == 0 ? "ok" : "attention"));
            foreach (var item in reported.EnumerateArray())
                issues.Add(new("Doctor: " + (JsonData.String(item, "code") ?? "issue") + ": " +
                    (JsonData.String(item, "message") ?? item.GetRawText()), "doctor"));
            if (reported.GetArrayLength() > 0) attention = true;
        }
    }

    private static void AddCheck(JsonElement checks, string key, string label,
        ImmutableArray<HealthObservation>.Builder observations, ref bool attention)
    {
        var value = JsonData.Property(checks, key);
        if (value is null)
        {
            observations.Add(new(label, "Not reported", "unknown"));
            return;
        }
        var item = value.Value;
        if (item.ValueKind == JsonValueKind.Object && item.TryGetProperty("healthy", out var nested))
            item = nested;
        var state = item.ValueKind switch
        {
            JsonValueKind.True => "ok",
            JsonValueKind.False => "attention",
            JsonValueKind.Number when key == "foreign_key_violations" && item.TryGetInt64(out var count) =>
                count == 0 ? "ok" : "attention",
            JsonValueKind.String when key == "integrity" && item.GetString() == "ok" => "ok",
            JsonValueKind.String when key == "integrity" && item.GetString() == "failed" => "attention",
            _ => "observed"
        };
        if (state == "attention") attention = true;
        observations.Add(new(label, Value(item), state));
    }

    private static string Value(JsonElement item) => item.ValueKind switch
    {
        JsonValueKind.String => item.GetString() ?? "",
        JsonValueKind.Null => "null",
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        _ => item.GetRawText()
    };

    private static string Count<T>(ImmutableArray<T> values) =>
        (values.IsDefault ? 0 : values.Length).ToString(CultureInfo.InvariantCulture);

    private static IEnumerable<T> Items<T>(ImmutableArray<T> values) =>
        values.IsDefault ? [] : values;
}
