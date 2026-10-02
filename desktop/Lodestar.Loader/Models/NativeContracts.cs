using System.Collections.Immutable;
using System.Text.Json;

namespace Lodestar.Loader;

// Public boundary shared by the WPF views and the one-shot CLI service.
public sealed record RuntimeSelection(string ConfigPath, string Generation, string NodePath,
    string CliPath, string DatabasePath, string Fingerprint, string? CoreSourceDigest = null,
    string? CoreSourceBasis = null);

public sealed record CliInvocation(string OperationId, ImmutableArray<string> Arguments,
    RuntimeSelection Runtime, TimeSpan Deadline, bool IsMutation = false,
    string? RequestFilePath = null);

public sealed record CliResult(bool Success, JsonElement? Envelope, string? Code, string Message,
    int? ExitCode, string Diagnostics, long ElapsedMilliseconds, bool MayHaveCommitted = false,
    string? FailureStage = null, string? FailureCategory = null, string? Action = null,
    string? CorrelationId = null, bool DiagnosticsUnavailable = false);

public sealed record CapabilityOperation(string Id, ImmutableArray<string> Argv, string Summary,
    string Effect, JsonElement Description, bool CanRunGenericRead, string? UnavailableReason);

public sealed record CapabilitySnapshot(int? Version, ImmutableArray<CapabilityOperation> Operations,
    RuntimeSelection Runtime, DateTimeOffset ReadAt, string? Error, string? ReleaseVersion = null,
    int? ContractVersion = null, int? SchemaVersion = null);

public sealed record ContinuityReadAction(string Label, ImmutableArray<string> Arguments)
{
    public override string ToString() => Label;
}

public sealed record LibraryRecord(string Id, string Kind, string Scope, string? Name,
    string? Availability, string? Lifecycle, DateTimeOffset? UpdatedAt, JsonElement Json);

public sealed record ProjectSummary(string Id, string Name, string? RecordedStatus,
    ImmutableArray<string> Roots, ImmutableArray<string> KnownScopes, int CurrentRecordCount,
    int RecordedOpenWorkCount, DateTimeOffset? LatestCurrentUpdate, string? LatestRecordId,
    bool AssociationComplete, LibraryRecord CatalogRecord,
    ImmutableArray<LibraryRecord> AssociatedRows = default);

public sealed record LibrarySnapshot(ImmutableArray<ProjectSummary> Projects,
    ImmutableArray<LibraryRecord> Records, ImmutableArray<LibraryRecord> GlobalKnowledge,
    ImmutableArray<LibraryRecord> Unassigned, string? DatabaseInstanceId,
    string? DatabaseEpoch, long? Revision, DateTimeOffset ReadAt, bool Complete,
    int LoadedCount, ImmutableArray<string> RecordErrors, ImmutableArray<string> Advisories,
    string? Error = null, ImmutableArray<RecordIssue> Issues = default,
    ImmutableArray<LibraryRecord> HistoricalProjects = default, bool CatalogOnly = false,
    bool HasMore = false, bool CanContinue = false);

public sealed record LibraryLoadPhaseSample(string Phase, long ElapsedMilliseconds,
    long ManagedBytes, long HeapSizeBytes, long FragmentedBytes, long WorkingSetBytes,
    long PrivateBytes, long TotalAllocatedBytes);

public sealed record LibraryLoadDiagnostics(DateTimeOffset StartedAt, DateTimeOffset CompletedAt,
    ImmutableArray<LibraryLoadPhaseSample> Phases);

public sealed record RecordIssue(string? Id, string Code, string Message, JsonElement Evidence);

public sealed record ProjectContextResult(bool Matched, string SelectedProjectId, string? ResolvedProjectId,
    string? CanonicalScope, ImmutableArray<string> HistoricalScopes, string? Root,
    JsonElement? StartData, string? Error);

public sealed record RecordSnapshot(LibraryRecord? Record, JsonElement? WriteBasis,
    JsonElement? RawRecord, ImmutableArray<JsonElement> History,
    string? DatabaseInstanceId, string? DatabaseEpoch, long? Revision,
    DateTimeOffset ReadAt, string? Error,
    ImmutableArray<DecodedHistoryVersion> DecodedHistory = default);

public sealed record DecodedHistoryVersion(long? ReplacingReceiptRevision, long? StoredRecordRevision,
    string? ReceiptId, JsonElement? StoredContent, JsonElement RawEvidence);

public sealed record FrozenMutation(string RequestId, string RecordId, RuntimeSelection Runtime,
    string DatabaseInstanceId, string DatabaseEpoch, byte[] ExactRequestUtf8,
    string JournalDirectory, string OperationId = "put", string? ProjectRoot = null,
    string? ProjectId = null, string? ProjectScope = null);

public sealed record SaveResult(bool Saved, bool MayHaveCommitted, bool RequiresRecovery,
    string RequestId, string? Error, CliResult? Cli);

public sealed record PendingSaveListing(IReadOnlyList<PendingSave> Items, string? Error,
    string JournalRoot, string? Category = null);

public sealed record RefreshOutcome(bool Complete, long? Revision, DateTimeOffset? ReadAt,
    string? Error);

public static class SavedRefreshStatus
{
    public static string Describe(FrozenMutation frozen, RefreshOutcome refresh)
    {
        var saved = "Saved " + frozen.RecordId + " · request " + frozen.RequestId;
        if (refresh.Complete && refresh.Error is null)
            return saved + " · refreshed library revision " + (refresh.Revision?.ToString() ?? "unknown");
        var prior = "revision " + (refresh.Revision?.ToString() ?? "unknown") +
            ", read " + (refresh.ReadAt?.ToLocalTime().ToString("g") ?? "unknown");
        return saved + "; library refresh " + (refresh.Error is null ? "partial" : "failed or partial") +
            " · displayed data may be stale (" + prior + "). " +
            (refresh.Error is null ? "" : refresh.Error + " ") + "Use Refresh to retry the read.";
    }
}

// ReplayEligible means the local journal body and context passed inspection.
// RecoverAsync still checks the selected runtime and current store identity.
public sealed record PendingSave(string RequestId, string RecordId, string DatabasePath,
    DateTimeOffset CreatedAt, string JournalDirectory, bool ReplayEligible = true, string? Issue = null,
    string OperationId = "put", string? ProjectRoot = null, bool CommitReported = false,
    long? CommittedRevision = null, string? ReceiptId = null, string? RecoveryKey = null);
