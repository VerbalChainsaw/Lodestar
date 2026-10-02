using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lodestar.Loader;

public sealed record EditDraft(string? Name, string? Availability, int? Priority, string DataJson);
public sealed record EditReview(FrozenMutation? Request, string Summary, string? Error);

public static class RecordEditor
{
    private static readonly HashSet<string> DomainKinds = new(StringComparer.Ordinal) {
        "work", "work-event", "decision-event", "migration-source", "mutation-receipt",
        "pending", "startup-snapshot", "handoff", "handoff-packet"
    };
    private static readonly HashSet<string> ProjectProtected = new(StringComparer.Ordinal) {
        "roots", "root", "catalog_binding", "catalog_fields", "name", "path", "aliases",
        "source_fingerprint", "source_fingerprints"
    };

    public static bool CanEdit(RecordSnapshot snapshot, out string reason)
    {
        reason = "";
        if (snapshot.Record is null || snapshot.WriteBasis is not { ValueKind: JsonValueKind.Object })
            { reason = "A fresh normalized record and exact write basis are required."; return false; }
        if (DomainKinds.Contains(snapshot.Record.Kind) || snapshot.Record.Kind.StartsWith("handoff-", StringComparison.Ordinal))
            { reason = "This kind belongs to a dedicated Lodestar command family."; return false; }
        if (snapshot.Record.Lifecycle is "historical" or "superseded")
            { reason = "Historical versions are read-only."; return false; }
        return true;
    }

    public static EditDraft Begin(RecordSnapshot baseline)
    {
        if (!CanEdit(baseline, out var reason)) throw new InvalidOperationException(reason);
        var json = baseline.Record!.Json;
        return new(JsonData.String(json, "name"), JsonData.String(json, "availability"),
            JsonData.TryInt(json, "priority", out var priority) ? priority : null,
            JsonData.Property(json, "data") is { } data ? JsonData.Pretty(data) : "null");
    }

    public static EditReview Prepare(RecordSnapshot baseline, EditDraft draft,
        RuntimeSelection runtime, string journalRoot)
    {
        if (!CanEdit(baseline, out var reason)) return new(null, "", reason);
        var record = baseline.Record!;
        var nameChanged = (draft.Name ?? "") != (record.Name ?? "");
        if (record.Kind == "project" && nameChanged)
            return new(null, "", "The catalog owns a project record's name.");
        var set = new JsonObject(); var remove = new JsonArray(); var changes = new List<string>();
        if (record.Kind != "project" && nameChanged)
        {
            if (string.IsNullOrWhiteSpace(draft.Name)) return new(null, "", "Name cannot be empty.");
            set["name"] = draft.Name; changes.Add("name");
        }
        if (draft.Availability != record.Availability)
        {
            if (draft.Availability is not ("known" or "known_empty" or "unavailable" or "unknown" or "stale"))
                return new(null, "", "Availability is outside the supported choices.");
            set["availability"] = draft.Availability; changes.Add("availability");
        }
        if (JsonData.TryInt(record.Json, "priority", out var oldPriority) && draft.Priority != oldPriority)
        {
            if (draft.Priority is null) return new(null, "", "Priority needs a value.");
            set["priority"] = draft.Priority; changes.Add("priority");
        }
        JsonNode? originalData, changedData;
        try
        {
            originalData = JsonNode.Parse(record.Json.GetProperty("data").GetRawText());
            changedData = JsonNode.Parse(draft.DataJson);
        }
        catch (JsonException ex) { return new(null, "", "Data JSON is invalid: " + ex.Message); }
        if (originalData is JsonObject original)
        {
            if (changedData is not JsonObject changed)
                return new(null, "", "Object data must remain an object for shallow updates.");
            if (record.Kind == "project")
                foreach (var key in ProjectProtected.Concat(original.Select(m => m.Key).Concat(changed.Select(m => m.Key))
                    .Where(key => key.StartsWith("catalog_", StringComparison.Ordinal))).Distinct(StringComparer.Ordinal))
                    if (original.ContainsKey(key) != changed.ContainsKey(key) || !JsonNode.DeepEquals(original[key], changed[key]))
                        return new(null, "", $"The project catalog owns data.{key}.");
            var changedMembers = new JsonObject();
            foreach (var member in changed)
                if (!original.ContainsKey(member.Key) || !JsonNode.DeepEquals(original[member.Key], member.Value))
                { changedMembers[member.Key] = member.Value?.DeepClone(); changes.Add("data." + member.Key); }
            foreach (var member in original)
                if (!changed.ContainsKey(member.Key))
                { remove.Add(member.Key); changes.Add("remove data." + member.Key); }
            if (changedMembers.Count > 0) set["data"] = changedMembers;
        }
        else if (!JsonNode.DeepEquals(originalData, changedData))
            return new(null, "", "Non-object data is read-only in this editor.");
        if (changes.Count == 0) return new(null, "No changes to save.", null);
        var id = "ll-" + Guid.NewGuid().ToString("D");
        var request = new JsonObject {
            ["v"] = 5, ["request_id"] = id,
            ["write_basis"] = JsonNode.Parse(baseline.WriteBasis!.Value.GetRawText()),
            ["input"] = new JsonObject { ["mode"] = "update", ["id"] = record.Id,
                ["set"] = set, ["remove"] = remove }
        };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
        var path = Path.Combine(journalRoot, id);
        var frozen = new FrozenMutation(id, record.Id, runtime,
            baseline.DatabaseInstanceId ?? "", baseline.DatabaseEpoch ?? "", bytes, path);
        return new(frozen, "Record " + record.Id + " · " + runtime.DatabasePath + Environment.NewLine +
            string.Join(Environment.NewLine, changes), null);
    }
}
