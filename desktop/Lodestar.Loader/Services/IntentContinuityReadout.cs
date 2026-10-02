using System.Collections.Immutable;
using System.Text.Json;

namespace Lodestar.Loader;

// Presentation and read admission for the shared core projection. It never
// selects additional context or treats retrieved record prose as a command.
public static class IntentContinuityReadout
{
    private static bool TryProjection(JsonElement data, out JsonElement context)
    {
        context = default;
        return JsonData.TryObject(data, "continuity", out context) &&
            JsonData.TryInt(context, "version", out var version) && version == 1 &&
            JsonData.TryArray(context, "records", out var records) && records.EnumerateArray().All(row =>
                row.ValueKind == JsonValueKind.Object && JsonData.String(row, "id") is { Length: > 0 } && JsonData.TryObject(row, "selection", out _)) &&
            JsonData.TryArray(context, "decisions", out var decisions) && decisions.EnumerateArray().All(row =>
                row.ValueKind == JsonValueKind.Object && JsonData.String(row, "key") is { Length: > 0 } &&
                JsonData.String(row, "resolution") is "current" or "conflict" or "unavailable") &&
            JsonData.TryArray(context, "issues", out var issues) && issues.EnumerateArray().All(row => row.ValueKind == JsonValueKind.Object) &&
            JsonData.TryArray(context, "read_required", out var reads) && reads.EnumerateArray().All(row =>
                row.ValueKind == JsonValueKind.Object && JsonData.String(row, "target_id") is { Length: > 0 } &&
                TryReadArguments(row, out _)) &&
            JsonData.TryArray(context, "active_requirement_ids", out var active) &&
            active.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String) &&
            JsonData.TryBool(context, "complete", out _) && JsonData.TryBool(context, "truncated", out _);
    }

    private static bool TryReadArguments(JsonElement row, out ImmutableArray<string> args)
    {
        args = [];
        if (!JsonData.TryArray(row, "read_args", out var values) || values.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String)) return false;
        args = values.EnumerateArray().Select(item => item.GetString()!).ToImmutableArray();
        return ReadOperation(args, args.Length == 6 ? args[3] : null) is not null;
    }

    public static string Format(JsonElement data)
    {
        var lines = new List<string> { "RECORDED CONTEXT / CONTINUITY",
            "Projection of current Lodestar records. This does not prove what context a past agent was delivered or establish acceptance." };
        if (!TryProjection(data, out var context))
            return string.Join('\n', lines.Append("Recorded context coverage: unknown. Missing, malformed or unsupported continuity metadata/read arrays; inspect the exact public response. Existing plan/evidence remains usable."));
        JsonData.TryBool(context, "complete", out var complete); JsonData.TryBool(context, "truncated", out var truncated);
        lines.Add("Recorded context coverage: " + (complete ? "selection resolved" : "incomplete") + (truncated ? " · truncated" : ""));
        lines.Add("Association mode: " + (JsonData.String(context, "association_mode") ?? "unknown"));
        JsonData.TryArray(context, "active_requirement_ids", out var active);
        lines.Add("Active branch: " + (JsonData.TryInt(context, "active_requirement_ids_omitted", out var omitted) && omitted > 0
            ? "IDs omitted by the context bound; read the intent before acting"
            : active.GetArrayLength() == 0 ? "explicitly none" : string.Join(", ", active.EnumerateArray().Select(item => item.GetString()))));
        JsonData.TryArray(context, "records", out var records);
        lines.Add("CURRENT CONTEXT RECORDS / REASONS");
        if (records.GetArrayLength() == 0) lines.Add("No context records selected within this projection.");
        foreach (var row in records.EnumerateArray())
        {
            lines.Add("• " + (JsonData.String(row, "id") ?? "unknown") + " · revision " + Revision(row) +
                " · " + (JsonData.Property(row, "semantics") is { } semantics ? JsonData.String(semantics, "lifecycle") : null));
            if (JsonData.Property(row, "selection") is { } selection) lines.Add("  Selected because: " + JsonData.Pretty(selection));
            if (JsonData.Property(row, "data") is { } body) lines.Add("  Recorded content: " + JsonData.Pretty(body));
            foreach (var field in new[] { "availability", "semantics", "sources" })
                if (JsonData.Property(row, field) is { } value) lines.Add("  " + field + ": " + JsonData.Pretty(value));
        }
        JsonData.TryArray(context, "decisions", out var decisions);
        lines.Add("RESOLVED DECISIONS / REASONS");
        if (decisions.GetArrayLength() == 0) lines.Add("No decision keys selected.");
        foreach (var decision in decisions.EnumerateArray())
        {
            lines.Add("• " + JsonData.String(decision, "key") + " · " + (JsonData.String(decision, "resolution") ?? "unknown"));
            // Core replay owns current/historical disposition and conflicts.
            lines.Add(JsonData.Pretty(decision));
        }
        foreach (var field in new[] { "issues", "read_required", "limits", "omitted" })
            if (JsonData.Property(context, field) is { } value) lines.Add(field.Replace('_', ' ').ToUpperInvariant() + "\n" + JsonData.Pretty(value));
        return string.Join('\n', lines);
    }

    public static ImmutableArray<ContinuityReadAction> Reads(JsonElement data, string? root)
    {
        if (!TryProjection(data, out var context)) return [];
        var actions = ImmutableArray.CreateBuilder<ContinuityReadAction>();
        var identities = new HashSet<string>(StringComparer.Ordinal);
        void Add(string label, ImmutableArray<string> args)
        {
            if (ReadOperation(args, root) is null) return;
            if (identities.Add(JsonSerializer.Serialize(args))) actions.Add(new(label, args));
        }
        JsonData.TryArray(context, "read_required", out var required);
        foreach (var row in required.EnumerateArray())
            if (JsonData.TryArray(row, "read_args", out var values) && values.EnumerateArray().All(item => item.ValueKind == JsonValueKind.String))
                Add("Required: " + JsonData.String(row, "target_id") + " · " + JsonData.String(row, "code"),
                    values.EnumerateArray().Select(item => item.GetString()!).ToImmutableArray());
        JsonData.TryArray(context, "records", out var records);
        foreach (var row in records.EnumerateArray())
            if (JsonData.String(row, "id") is { } id) Add("Record: " + id, ["get", "--", id]);
        JsonData.TryArray(context, "decisions", out var decisions);
        foreach (var row in decisions.EnumerateArray())
            if (root is not null && JsonData.String(row, "key") is { } key)
                Add("Decision: " + key, ["decision", "show", "--cwd", root, "--", key]);
        return actions.ToImmutable();
    }

    public static string? ReadOperation(ImmutableArray<string> args, string? root)
    {
        if (args.IsDefaultOrEmpty || args.Any(token => string.IsNullOrEmpty(token) || JsonData.HasInvalidUnicode(token) || token.Any(char.IsControl))) return null;
        if (args.Length == 3 && args[0] == "get" && args[1] == "--" ||
            args.Length == 4 && args[0] == "get" && args[1] == "--raw" && args[2] == "--") return "get";
        return root is not null && args.Length == 6 && args[0] == "decision" && args[1] == "show" &&
            args[2] == "--cwd" && SameRoot(args[3], root) && args[4] == "--" ? "decision.show" : null;
    }

    private static bool SameRoot(string offered, string selected)
    {
        try { return string.Equals(Path.GetFullPath(offered), Path.GetFullPath(selected), StringComparison.OrdinalIgnoreCase); }
        catch (ArgumentException) { return false; }
        catch (NotSupportedException) { return false; }
    }

    public static Dictionary<string, int> RequirementDepths(JsonElement[] rows)
    {
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var row in rows) if (JsonData.String(row, "id") is { } id) parents[id] = JsonData.String(row, "parent_id");
        var depths = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var id in parents.Keys)
        {
            if (depths.ContainsKey(id)) continue;
            var chain = new List<string>(); var visiting = new HashSet<string>(StringComparer.Ordinal);
            string? cursor = id;
            while (cursor is not null && parents.ContainsKey(cursor) && !depths.ContainsKey(cursor) && visiting.Add(cursor))
            { chain.Add(cursor); cursor = parents[cursor]; }
            var depth = cursor is not null && depths.TryGetValue(cursor, out var existing) ? existing : -1;
            // Valid work.check plans are acyclic. Bound presentation for malformed
            // responses as well, without recursion or repeated parent traversal.
            for (var index = chain.Count - 1; index >= 0; index--) depths[chain[index]] = ++depth;
        }
        return depths;
    }

    private static string Revision(JsonElement value) => JsonData.TryLong(value, "revision", out var revision) ? revision.ToString() : "unknown";
}
