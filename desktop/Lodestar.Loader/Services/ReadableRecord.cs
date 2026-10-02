using System.Collections.Immutable;
using System.Text;
using System.Text.Json;

namespace Lodestar.Loader;

public static class ReadableRecord
{
    public const int MaxNodes = 300;
    public const int MaxDepth = 6;
    public const int MaxScalarCharacters = 800;

    private static readonly HashSet<string> IdentityFields = new(StringComparer.Ordinal) {
        "id", "kind", "scope", "name", "availability", "priority", "created_at", "updated_at"
    };

    public static OperatorRecordReadout Project(LibraryRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        var json = record.Json;
        var budget = new RenderBudget();
        var sections = ImmutableArray.CreateBuilder<ReadoutSection>();
        var identity = ImmutableArray.CreateBuilder<ReadoutNode>();
        var additional = ImmutableArray.CreateBuilder<ReadoutNode>();

        if (json.ValueKind == JsonValueKind.Object)
        {
            var properties = json.EnumerateObject().ToArray();
            for (var index = 0; index < properties.Length; index++)
            {
                if (budget.Remaining == 0)
                {
                    budget.Truncated = true;
                    additional.Add(new("", "Additional stored fields",
                        $"{properties.Length - index} omitted; inspect raw JSON", "limit", [], true));
                    break;
                }
                var property = properties[index];
                var path = ChildPath("", property.Name);
                if (IdentityFields.Contains(property.Name))
                    identity.Add(Node(property.Name, path, property.Value, 0, budget));
                else if (property.Name == "data")
                    sections.Add(new(DataHeading(record.Kind), ChildrenOrSelf(property.Name, path, property.Value, budget)));
                else if (property.Name == "semantics")
                    sections.Add(new("Meaning and applicability", ChildrenOrSelf(property.Name, path, property.Value, budget)));
                else if (property.Name == "sources")
                    sections.Add(new("Sources", ChildrenOrSelf(property.Name, path, property.Value, budget)));
                else if (property.Name is "links" or "relationships")
                    sections.Add(new("Relationships", ChildrenOrSelf(property.Name, path, property.Value, budget)));
                else additional.Add(Node(property.Name, path, property.Value, 0, budget));
            }
        }
        else
        {
            additional.Add(Node("Stored value", "", json, 0, budget));
        }

        if (identity.Count > 0) sections.Insert(0, new("Stored identity", identity.ToImmutable()));
        if (additional.Count > 0) sections.Add(new("Other stored fields", additional.ToImmutable()));
        if (!sections.Any(section => section.Heading == DataHeading(record.Kind)))
            sections.Add(new(DataHeading(record.Kind), [new("/data", "Data", "Not recorded", "missing", [])]));

        var state = RecordedState(json);
        var raw = json.ValueKind == JsonValueKind.Undefined ? "" : JsonData.Pretty(json);
        return new(Headline(record), KindLabel(record.Kind), state, Summary(record),
            sections.ToImmutable(), raw, budget.Truncated,
            budget.Truncated ? $"Display limited to {MaxNodes} nodes, {MaxDepth} nested levels, " +
                $"and {MaxScalarCharacters} characters per value. Inspect raw JSON for omitted content." : null);
    }

    private static string Headline(LibraryRecord record)
    {
        if (!string.IsNullOrWhiteSpace(record.Name)) return record.Name;
        var data = JsonData.Property(record.Json, "data");
        if (data is { ValueKind: JsonValueKind.Object })
            foreach (var key in new[] { "title", "subject", "key" })
                if (JsonData.TryString(data.Value, key, out var text) && !string.IsNullOrWhiteSpace(text))
                    return text;
        return record.Id;
    }

    private static string Summary(LibraryRecord record)
    {
        var data = JsonData.Property(record.Json, "data");
        if (data is { ValueKind: JsonValueKind.Object })
        {
            string[] keys = record.Kind switch
            {
                "work" => ["current_work", "summary", "description", "outcome", "notes"],
                "handoff" or "handoff-packet" => ["summary", "reason", "notes", "message"],
                "decision" or "decision-event" => ["rationale", "reason", "summary", "description"],
                "rejection" => ["reason", "rationale", "summary", "description"],
                "pending" => ["reason", "summary", "description", "notes"],
                _ => ["description", "summary", "statement", "content", "notes"]
            };
            foreach (var key in keys)
                if (JsonData.TryString(data.Value, key, out var text) && !string.IsNullOrWhiteSpace(text))
                    return text;
        }
        return "No summary recorded.";
    }

    private static string RecordedState(JsonElement json)
    {
        var data = JsonData.Property(json, "data");
        if (data is { ValueKind: JsonValueKind.Object } &&
            data.Value.TryGetProperty("status", out var status))
            return "Recorded status: " + Scalar(status);
        var semantics = JsonData.Property(json, "semantics");
        if (semantics is { ValueKind: JsonValueKind.Object } &&
            semantics.Value.TryGetProperty("lifecycle", out var lifecycle))
            return "Recorded lifecycle: " + Scalar(lifecycle);
        if (json.ValueKind == JsonValueKind.Object && json.TryGetProperty("availability", out var availability))
            return "Recorded availability: " + Scalar(availability);
        return "No status recorded.";
    }

    private static ImmutableArray<ReadoutNode> ChildrenOrSelf(string name, string path,
        JsonElement value, RenderBudget budget)
    {
        if (value.ValueKind != JsonValueKind.Object) return [Node(name, path, value, 0, budget)];
        var children = ImmutableArray.CreateBuilder<ReadoutNode>();
        var count = value.EnumerateObject().Count();
        var seen = 0;
        foreach (var property in value.EnumerateObject())
        {
            if (budget.Remaining == 0) break;
            children.Add(Node(property.Name, ChildPath(path, property.Name), property.Value, 0, budget));
            seen++;
        }
        if (seen < count)
        {
            budget.Truncated = true;
            children.Add(new(path, "Additional fields", $"{count - seen} omitted; inspect raw JSON",
                "limit", [], true));
        }
        return children.ToImmutable();
    }

    private static ReadoutNode Node(string name, string path, JsonElement value, int depth,
        RenderBudget budget)
    {
        if (budget.Remaining == 0)
        {
            budget.Truncated = true;
            return new(path, Label(name), "Display node limit reached; inspect raw JSON", "limit", [], true);
        }
        budget.Remaining--;
        if (value.ValueKind is not (JsonValueKind.Object or JsonValueKind.Array))
        {
            var text = Scalar(value);
            if (text.Length <= MaxScalarCharacters)
                return new(path, Label(name), text, Type(value), []);
            budget.Truncated = true;
            return new(path, Label(name), text[..MaxScalarCharacters] + "…", Type(value), [], true);
        }

        var count = value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() :
            value.EnumerateObject().Count();
        var description = value.ValueKind == JsonValueKind.Array ?
            $"{count} item{(count == 1 ? "" : "s")}" :
            $"{count} field{(count == 1 ? "" : "s")}";
        if (depth >= MaxDepth && count > 0)
        {
            budget.Truncated = true;
            return new(path, Label(name), description + "; depth limit reached", Type(value), [], true);
        }

        var children = ImmutableArray.CreateBuilder<ReadoutNode>();
        var seen = 0;
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (budget.Remaining == 0) break;
                children.Add(Node(property.Name, ChildPath(path, property.Name), property.Value, depth + 1, budget));
                seen++;
            }
        }
        else
        {
            foreach (var element in value.EnumerateArray())
            {
                if (budget.Remaining == 0) break;
                children.Add(Node($"Item {seen + 1}", ChildPath(path, seen.ToString()), element,
                    depth + 1, budget));
                seen++;
            }
        }
        if (seen < count)
        {
            budget.Truncated = true;
            children.Add(new(path, "Additional items", $"{count - seen} omitted; inspect raw JSON", "limit", [], true));
        }
        return new(path, Label(name), description, Type(value), children.ToImmutable(), seen < count);
    }

    private static string Scalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Null => "null",
        JsonValueKind.Undefined => "Not recorded",
        _ => value.GetRawText()
    };

    private static string Type(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.True or JsonValueKind.False => "boolean",
        JsonValueKind.Undefined => "missing",
        _ => value.ValueKind.ToString().ToLowerInvariant()
    };

    private static string ChildPath(string parent, string name) => parent + "/" +
        name.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    private static string Label(string name)
    {
        var result = new StringBuilder(name.Length + 8);
        for (var index = 0; index < name.Length; index++)
        {
            var character = name[index];
            if (character is '_' or '-') { result.Append(' '); continue; }
            if (index > 0 && char.IsUpper(character) && char.IsLower(name[index - 1])) result.Append(' ');
            result.Append(character);
        }
        if (result.Length > 0) result[0] = char.ToUpperInvariant(result[0]);
        return result.ToString();
    }

    private static string KindLabel(string kind) => kind switch
    {
        "project" => "Project", "note" => "Note", "fact" => "Fact",
        "knowledge" => "Knowledge", "work" or "work-event" => "Work record",
        "handoff" or "handoff-packet" => "Handoff record",
        "decision" or "decision-event" => "Decision record", "pending" => "Pending candidate",
        "rejection" => "Rejection", _ => Label(kind)
    };

    private static string DataHeading(string kind) => kind switch
    {
        "project" => "Project details", "note" => "Note details", "fact" => "Fact details",
        "knowledge" => "Knowledge details", "work" or "work-event" => "Recorded work",
        "handoff" or "handoff-packet" => "Handoff details",
        "decision" or "decision-event" => "Decision details", "pending" => "Pending details",
        "rejection" => "Rejection details", _ => "Record data"
    };

    private sealed class RenderBudget
    {
        public int Remaining { get; set; } = MaxNodes;
        public bool Truncated { get; set; }
    }
}
