using System.Collections.Immutable;

namespace Lodestar.Loader;

// Each displayed value carries a pointer into the exact stored JSON. The raw record
// remains available when a display limit is reached.
public sealed record ReadoutNode(string Path, string Label, string Value, string Type,
    ImmutableArray<ReadoutNode> Children, bool Truncated = false);

public sealed record ReadoutSection(string Heading, ImmutableArray<ReadoutNode> Items);

public sealed record OperatorRecordReadout(string Headline, string KindLabel, string State,
    string Summary, ImmutableArray<ReadoutSection> Sections, string RawJson,
    bool Truncated, string? LimitNotice);

public sealed record HealthObservation(string Label, string Value, string State,
    string? Detail = null);

public sealed record HealthIssue(string Message, string ActionKey);

public sealed record LodestarHealthSnapshot(string Headline, string State,
    DateTimeOffset ObservedAt, ImmutableArray<HealthObservation> Observations,
    ImmutableArray<HealthIssue> Issues);
