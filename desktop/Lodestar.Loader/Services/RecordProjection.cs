using System.Collections.Immutable;
using System.Text.Json;

namespace Lodestar.Loader;

public static class RecordProjection
{
    public static ImmutableArray<LibraryRecord> AssociatedRecords(LibrarySnapshot snapshot, ProjectSummary selected)
    {
        if (!selected.AssociatedRows.IsDefault) return selected.AssociatedRows;
        return snapshot.Records.Where(record =>
        {
            if (record.Kind == "project") return record.Id == selected.Id;
            var key = ApplicabilityProject(record.Json) ?? record.Scope;
            return selected.KnownScopes.Contains(key) &&
                snapshot.Projects.Count(project => project.KnownScopes.Contains(key)) == 1;
        }).ToImmutableArray();
    }

    public static LibraryRecord? ReadRecord(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object || !JsonData.TryString(json, "id", out var id) ||
            !JsonData.TryString(json, "kind", out var kind) || !JsonData.TryString(json, "scope", out var scope)) return null;
        var lifecycle = JsonData.TryObject(json, "semantics", out var semantics) &&
            JsonData.TryString(semantics, "lifecycle", out var state) ? state : null;
        return new(id, kind, scope, JsonData.String(json, "name"),
            JsonData.String(json, "availability"), lifecycle,
            JsonData.Date(json, "updated_at"), json.Clone());
    }

    public static (ImmutableArray<ProjectSummary> Projects, ImmutableArray<LibraryRecord> Global,
        ImmutableArray<LibraryRecord> Unassigned) Build(
        IReadOnlyList<LibraryRecord> catalog, IReadOnlyList<LibraryRecord> current, bool complete)
    {
        var projects = catalog.Where(r => r.Kind == "project" && r.Lifecycle is not ("historical" or "superseded"))
            .GroupBy(r => r.Id, StringComparer.Ordinal).Select(g => g.OrderByDescending(r => r.UpdatedAt).First()).ToArray();
        var scopes = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var projectScopes = new Dictionary<string, ImmutableArray<string>>(StringComparer.Ordinal);
        foreach (var project in projects)
        {
            var known = new HashSet<string>(StringComparer.Ordinal);
            var applicable = ApplicabilityProject(project.Json);
            if (!string.IsNullOrWhiteSpace(applicable)) known.Add(applicable);
            // A project record's own scope is often global, so global is never a project mapping.
            if (project.Scope != "global") known.Add(project.Scope);
            projectScopes[project.Id] = known.ToImmutableArray();
            foreach (var scope in known)
            {
                if (!scopes.TryGetValue(scope, out var owners)) scopes[scope] = owners = [];
                owners.Add(project.Id);
            }
        }
        var assigned = projects.ToDictionary(p => p.Id, _ => new List<LibraryRecord>(), StringComparer.Ordinal);
        var global = ImmutableArray.CreateBuilder<LibraryRecord>();
        var unassigned = ImmutableArray.CreateBuilder<LibraryRecord>();
        foreach (var record in current)
        {
            if (record.Kind == "project")
            {
                if (assigned.TryGetValue(record.Id, out var projectRows)) projectRows.Add(record);
                continue;
            }
            var applicable = ApplicabilityProject(record.Json);
            var key = !string.IsNullOrWhiteSpace(applicable) ? applicable : record.Scope;
            if (key == "global" && string.IsNullOrWhiteSpace(applicable)) { global.Add(record); continue; }
            if (!scopes.TryGetValue(key, out var owners) || owners.Count != 1)
            { unassigned.Add(record); continue; }
            assigned[owners[0]].Add(record);
        }
        var summaries = projects.Select(project =>
        {
            var associated = assigned[project.Id].ToImmutableArray();
            var records = associated.Where(record => record.Kind != "project").ToArray();
            var latest = records.Append(project).Where(r => r.UpdatedAt.HasValue)
                .OrderByDescending(r => r.UpdatedAt).ThenBy(r => r.Id, StringComparer.Ordinal).FirstOrDefault();
            var data = JsonData.Property(project.Json, "data");
            var status = data is { ValueKind: JsonValueKind.Object } &&
                JsonData.TryString(data.Value, "status", out var supplied) ? supplied : null;
            var open = records.Count(r => r.Kind == "work" &&
                JsonData.Property(r.Json, "data") is { ValueKind: JsonValueKind.Object } work &&
                JsonData.String(work, "status") == "open");
            return new ProjectSummary(project.Id, project.Name ?? project.Id, status,
                Roots(data), projectScopes[project.Id], records.Length, open, latest?.UpdatedAt,
                latest?.Id, complete, project, associated);
        }).OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase).ToImmutableArray();
        return (summaries, global.ToImmutable(), unassigned.ToImmutable());
    }

    public static string? ApplicabilityProject(JsonElement record)
    {
        if (!JsonData.TryObject(record, "semantics", out var semantics) ||
            !JsonData.TryObject(semantics, "applicability", out var applicability)) return null;
        return JsonData.String(applicability, "project");
    }

    private static ImmutableArray<string> Roots(JsonElement? data)
    {
        var result = ImmutableArray.CreateBuilder<string>();
        if (data is not { ValueKind: JsonValueKind.Object }) return result.ToImmutable();
        if (JsonData.TryArray(data.Value, "roots", out var roots))
        {
            foreach (var root in roots.EnumerateArray())
                if (root.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(root.GetString()))
                    result.Add(root.GetString()!);
        }
        else if (JsonData.TryString(data.Value, "root", out var singleRoot)) result.Add(singleRoot);
        return result.ToImmutable();
    }

    public static string DescribeRecord(LibraryRecord record)
    {
        var data = JsonData.Property(record.Json, "data");
        if (data is not { ValueKind: JsonValueKind.Object }) return record.Name ?? record.Id;
        foreach (var key in new[] { "description", "summary", "current_work", "status", "outcome", "notes" })
            if (JsonData.TryString(data.Value, key, out var text) && !string.IsNullOrWhiteSpace(text))
                return text;
        return record.Name ?? record.Id;
    }
}
