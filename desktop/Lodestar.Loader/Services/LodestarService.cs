using System.Collections.Immutable;
using System.Text.Json;
using System.Text;
using System.Security.Cryptography;
using System.Diagnostics;
using System.Security;

namespace Lodestar.Loader;

public sealed partial class LodestarService : IAsyncDisposable
{
    private const int PageSize = 250;
    private const int RecordBudget = 100_000;
    private static readonly HashSet<string> ReservedGenericFlags = new(StringComparer.Ordinal) {
        "--db", "--output", "--args-file", "--args-stdin", "--human", "--help", "-h",
        "--version", "-v", "--interface-config", "--cwd", "--session", "--agent",
        "--harness", "--file"
    };
    private readonly CliTransport _transport = new();
    private readonly Func<CliInvocation, CancellationToken, Task<CliResult>>? _executeOverride;
    private readonly string _journalRoot;
    private IReadOnlyList<PendingSave> _lastPendingSaves = [];
    private readonly SemaphoreSlim _libraryLoadGate = new(1, 1);
    private LibraryResume? _libraryResume;
    public RuntimeSelection Runtime { get; private set; }
    public CapabilitySnapshot? Capabilities { get; private set; }
    public LibrarySnapshot? LastCompleteLibrary { get; private set; }
    public LibraryLoadDiagnostics? LastLibraryLoadDiagnostics { get; private set; }

    public LodestarService(RuntimeSelection runtime, string? journalRoot = null)
    {
        Runtime = runtime;
        _journalRoot = journalRoot ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lodestar Loader", "pending");
    }

    internal LodestarService(RuntimeSelection runtime,
        Func<CliInvocation, CancellationToken, Task<CliResult>> execute,
        string? journalRoot = null) : this(runtime, journalRoot) => _executeOverride = execute;

    public static Task<RuntimeSelection> LoadRuntimeAsync(string configPath, CancellationToken cancellation = default) =>
        RuntimeConfig.LoadAsync(configPath, cancellation);

    public Task<CliResult> ExecuteAsync(CliInvocation invocation, CancellationToken cancellation = default) =>
        _executeOverride is null ? _transport.ExecuteAsync(invocation, cancellation) :
            _executeOverride(invocation, cancellation);

    private Task<CliResult> CallAsync(string id, IEnumerable<string> args, CancellationToken cancellation,
        TimeSpan? deadline = null, bool mutation = false, string? requestFile = null) =>
        ExecuteAsync(new(id, args.ToImmutableArray(), Runtime, deadline ?? TimeSpan.FromSeconds(30),
            mutation, requestFile), cancellation);

    public async Task<CapabilitySnapshot> DiscoverAsync(RuntimeSelection? runtime = null,
        CancellationToken cancellation = default)
    {
        if (runtime is not null) { Runtime = runtime; Capabilities = null; LastCompleteLibrary = null;
            _libraryResume = null; _lastPendingSaves = []; _sharedPending = []; _sharedSettled.Clear(); _sharedRecoveryError = null; }
        var discoveryRuntime = Runtime;
        Capabilities = null;
        var result = await CallAsync("help", ["--help"], cancellation);
        var now = DateTimeOffset.UtcNow;
        if (Runtime != discoveryRuntime)
            return new(null, [], discoveryRuntime, now, "Runtime changed during discovery; refresh the selected runtime.");
        if (!result.Success || result.Envelope is null)
            return Capabilities = new(null, [], Runtime, now, result.Message);
        var data = JsonData.Property(result.Envelope.Value, "data");
        if (data is not { ValueKind: JsonValueKind.Object })
            return Capabilities = new(null, [], Runtime, now, "Help data is unavailable.");
        var version = JsonData.TryInt(data.Value, "capability_version", out var number) ? number : (int?)null;
        var reportedRelease = JsonData.String(data.Value, "version");
        var release = reportedRelease is { Length: > 0 and <= 128 } &&
            char.IsAsciiLetterOrDigit(reportedRelease[0]) &&
            reportedRelease.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_' or '+')
            ? reportedRelease : null;
        var operations = ImmutableArray.CreateBuilder<CapabilityOperation>();
        if (JsonData.TryArray(data.Value, "operations", out var descriptions))
            foreach (var item in descriptions.EnumerateArray())
            {
                if (!JsonData.TryString(item, "id", out var id)) continue;
                var argv = JsonData.TryArray(item, "argv", out var values)
                    ? values.EnumerateArray().Where(v => v.ValueKind == JsonValueKind.String)
                        .Select(v => v.GetString()!).ToImmutableArray() : [];
                var effect = JsonData.String(item, "effect") ?? "unknown";
                var reason = version != 1 ? "Unsupported capability metadata version." :
                    effect != "read" ? "This operation is descriptive here; a dedicated action is required." :
                    argv.IsDefaultOrEmpty ? "No exact argv binding." : ValidateGenericDescriptor(item);
                operations.Add(new(id, argv, JsonData.String(item, "summary") ?? id,
                    effect, item.Clone(), reason is null, reason));
            }
        Capabilities = new(version, operations.ToImmutable(), Runtime, now,
            version == 1 ? null : "Capability metadata is unavailable or unsupported; editing and generic actions are disabled.", release,
            JsonData.TryInt(data.Value, "contract_version", out var contract) ? contract : null,
            JsonData.TryInt(data.Value, "schema_version", out var schema) ? schema : null);
        await RefreshSharedRecoveryAsync(cancellation);
        return Capabilities;
    }

    private static string? ValidateGenericDescriptor(JsonElement item)
    {
        if (!JsonData.TryArray(item, "argv", out var leading) || leading.GetArrayLength() == 0 ||
            leading.EnumerateArray().Any(token => token.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(token.GetString()) || token.GetString()!.StartsWith('-') ||
                ReservedGenericFlags.Contains(token.GetString()!)))
            return "Unsafe or incomplete leading argv metadata.";
        if (JsonData.String(item, "id") != string.Join('.', leading.EnumerateArray().Select(token => token.GetString())))
            return "Operation ID does not match its leading argv.";
        if (!JsonData.TryArray(item, "parameters", out var parameters) ||
            !JsonData.TryArray(item, "constraints", out var constraints) ||
            !JsonData.TryObject(item, "context", out var context)) return "Incomplete argument metadata.";
        if (!JsonData.TryBool(context, "project", out var project) ||
            !JsonData.TryBool(context, "actor", out var actor) || project || actor ||
            context.EnumerateObject().Any(p => p.Name is not ("project" or "actor")))
            return "This read requires context that the generic form does not supply.";
        var names = new HashSet<string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);
        var positionals = new List<int>();
        foreach (var parameter in parameters.EnumerateArray())
        {
            if (!JsonData.TryString(parameter, "name", out var name) || !names.Add(name) ||
                !JsonData.TryString(parameter, "binding", out var binding) ||
                !JsonData.TryBool(parameter, "required", out _) ||
                !JsonData.TryObject(parameter, "schema", out var schema) ||
                !JsonData.TryString(schema, "type", out var type) ||
                type is not ("string" or "boolean" or "integer")) return "Unsupported parameter metadata.";
            if (schema.EnumerateObject().Any(p => p.Name is not
                    ("type" or "enum" or "minimum" or "maximum" or "minLength" or "maxLength" or "description" or "default")))
                return "Unsupported scalar schema feature.";
            if (JsonData.TryArray(schema, "enum", out var enumValues) &&
                (enumValues.GetArrayLength() == 0 || enumValues.EnumerateArray().Any(value =>
                    type == "string" && value.ValueKind != JsonValueKind.String ||
                    type == "boolean" && value.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
                    type == "integer" && (value.ValueKind != JsonValueKind.Number || !value.TryGetInt64(out var choice) ||
                        choice is < -9007199254740991 or > 9007199254740991))))
                return "Unsupported enum schema.";
            if (schema.TryGetProperty("enum", out var enumProperty) && enumProperty.ValueKind != JsonValueKind.Array)
                return "Unsupported enum schema.";
            if (schema.TryGetProperty("minimum", out _) || schema.TryGetProperty("maximum", out _))
                if (type != "integer" || schema.TryGetProperty("minimum", out var minimum) &&
                    (minimum.ValueKind != JsonValueKind.Number || !minimum.TryGetInt64(out _)) ||
                    schema.TryGetProperty("maximum", out var maximum) &&
                    (maximum.ValueKind != JsonValueKind.Number || !maximum.TryGetInt64(out _)))
                    return "Unsupported numeric bounds.";
            if (schema.TryGetProperty("minLength", out _) || schema.TryGetProperty("maxLength", out _))
                if (type != "string" || schema.TryGetProperty("minLength", out var minLength) &&
                    (minLength.ValueKind != JsonValueKind.Number || !minLength.TryGetInt32(out var minimumLength) || minimumLength < 0) ||
                    schema.TryGetProperty("maxLength", out var maxLength) &&
                    (maxLength.ValueKind != JsonValueKind.Number || !maxLength.TryGetInt32(out var maximumLength) || maximumLength < 0))
                    return "Unsupported string bounds.";
            if (binding == "positional")
            {
                if (!JsonData.TryInt(parameter, "index", out var index) || index < 0 ||
                    parameter.TryGetProperty("flag", out _)) return "Invalid positional index or binding.";
                positionals.Add(index);
            }
            if (binding is "option" or "flag" && (!JsonData.TryString(parameter, "flag", out var flag) ||
                !flag.StartsWith("--", StringComparison.Ordinal) || flag == "--" ||
                ReservedGenericFlags.Contains(flag) || !flags.Add(flag) ||
                parameter.TryGetProperty("index", out _))) return "Unsafe or missing option binding.";
            if (binding == "flag" && type != "boolean") return "A flag needs a boolean schema.";
            if (binding is not ("positional" or "option" or "flag")) return "Unsupported parameter binding.";
        }
        if (!positionals.Order().SequenceEqual(Enumerable.Range(0, positionals.Count)))
            return "Positional indices must be unique and contiguous from zero.";
        foreach (var constraint in constraints.EnumerateArray())
            if (JsonData.String(constraint, "kind") is not ("at_most_one" or "exactly_one") ||
                !JsonData.TryArray(constraint, "parameters", out var members) ||
                members.EnumerateArray().DistinctBy(member => member.GetRawText()).Count() != members.GetArrayLength() ||
                members.EnumerateArray().Any(member => member.ValueKind != JsonValueKind.String ||
                    !names.Contains(member.GetString()!))) return "Unsupported constraint.";
        return null;
    }

    public async Task<CliResult> RunReadAsync(CapabilityOperation operation,
        IReadOnlyDictionary<string, string?> values, CancellationToken cancellation = default)
    {
        if (!operation.CanRunGenericRead || operation.Effect != "read")
            throw new InvalidOperationException(operation.UnavailableReason ?? "This operation cannot run as a generic read.");
        var invalid = ValidateGenericDescriptor(operation.Description);
        if (invalid is not null) throw new InvalidOperationException(invalid);
        if (!operation.Argv.SequenceEqual(operation.Description.GetProperty("argv").EnumerateArray()
            .Select(token => token.GetString()!)))
            throw new InvalidOperationException("Operation argv differs from its validated description.");
        if (values.Keys.Any(name => !operation.Description.GetProperty("parameters").EnumerateArray()
            .Any(parameter => JsonData.String(parameter, "name") == name)))
            throw new ArgumentException("A supplied input is not described by this operation.");
        var args = operation.Argv.ToList();
        var parameters = operation.Description.GetProperty("parameters").EnumerateArray().ToArray();
        var positionals = new List<(int Index, string Value)>();
        foreach (var parameter in parameters)
        {
            var name = JsonData.String(parameter, "name")!;
            values.TryGetValue(name, out var text);
            var required = JsonData.TryBool(parameter, "required", out var marked) && marked;
            if (string.IsNullOrEmpty(text)) { if (required) throw new ArgumentException($"{name} is required."); continue; }
            var schema = parameter.GetProperty("schema");
            var type = JsonData.String(schema, "type");
            if (type == "boolean" && !bool.TryParse(text, out _)) throw new ArgumentException($"{name} needs true or false.");
            if (type == "integer" && (!long.TryParse(text, out var number) ||
                number is < -9007199254740991 or > 9007199254740991 ||
                JsonData.TryLong(schema, "minimum", out var min) && number < min ||
                JsonData.TryLong(schema, "maximum", out var max) && number > max))
                throw new ArgumentException($"{name} needs an allowed integer.");
            if (JsonData.TryInt(schema, "minLength", out var length) && text.Length < length)
                throw new ArgumentException($"{name} is too short.");
            if (JsonData.TryInt(schema, "maxLength", out var maxLength) && text.Length > maxLength)
                throw new ArgumentException($"{name} is too long.");
            if (JsonData.TryArray(schema, "enum", out var enums) &&
                !enums.EnumerateArray().Any(value => type switch {
                    "string" => value.GetString() == text,
                    "integer" => value.GetInt64() == long.Parse(text),
                    "boolean" => value.GetBoolean() == bool.Parse(text),
                    _ => false
                }))
                throw new ArgumentException($"{name} is outside the described choices.");
            var binding = JsonData.String(parameter, "binding");
            if (binding == "positional") positionals.Add((parameter.GetProperty("index").GetInt32(), text));
            else if (binding == "option")
            {
                if (text.StartsWith("--", StringComparison.Ordinal) || text is "-h" or "-v")
                    throw new ArgumentException($"{name} resembles a global CLI option in this option binding.");
                args.Add(JsonData.String(parameter, "flag")!); args.Add(text);
            }
            else if (bool.Parse(text)) args.Add(JsonData.String(parameter, "flag")!);
        }
        foreach (var constraint in operation.Description.GetProperty("constraints").EnumerateArray())
        {
            var set = constraint.GetProperty("parameters").EnumerateArray()
                .Count(v => values.TryGetValue(v.GetString()!, out var text) && !string.IsNullOrEmpty(text) &&
                    (JsonData.String(parameters.Single(parameter => JsonData.String(parameter, "name") == v.GetString())
                        .GetProperty("schema"), "type") != "boolean" || bool.Parse(text)));
            if (JsonData.String(constraint, "kind") == "exactly_one" && set != 1 ||
                JsonData.String(constraint, "kind") == "at_most_one" && set > 1)
                throw new ArgumentException("The operation's parameter constraint is not satisfied.");
        }
        if (positionals.Count > 0)
        {
            if (!positionals.OrderBy(p => p.Index).Select(p => p.Index)
                .SequenceEqual(Enumerable.Range(0, positionals.Count)))
                throw new ArgumentException("Optional positional values cannot leave an earlier position empty.");
            args.Add("--");
            args.AddRange(positionals.OrderBy(p => p.Index).Select(p => p.Value));
        }
        return await CallAsync(operation.Id, args, cancellation);
    }

    public async Task<LibrarySnapshot> LoadLibraryAsync(CancellationToken cancellation = default,
        Action<LibrarySnapshot>? onCatalogReady = null, int batchRecordBudget = RecordBudget)
    {
        ValidateBatchBudget(batchRecordBudget);
        await _libraryLoadGate.WaitAsync(cancellation);
        try
        {
            _libraryResume = null;
            await RefreshSharedRecoveryAsync(cancellation);
            return await LoadLibraryBatchAsync(null, cancellation, onCatalogReady, batchRecordBudget);
        }
        finally { _libraryLoadGate.Release(); }
    }

    public async Task<LibrarySnapshot> ContinueLibraryAsync(CancellationToken cancellation = default,
        Action<LibrarySnapshot>? onCatalogReady = null, int batchRecordBudget = RecordBudget)
    {
        ValidateBatchBudget(batchRecordBudget);
        await _libraryLoadGate.WaitAsync(cancellation);
        try
        {
            var resume = _libraryResume;
            if (resume is null) return PriorOrError("There is no safe library continuation; start a new load.");
            if (resume.Runtime != Runtime)
            {
                _libraryResume = null;
                return PriorOrError("The selected runtime changed; start a new library load.");
            }
            return await LoadLibraryBatchAsync(resume, cancellation, onCatalogReady, batchRecordBudget);
        }
        finally { _libraryLoadGate.Release(); }
    }

    private static void ValidateBatchBudget(int budget)
    {
        if (budget <= 0) throw new ArgumentOutOfRangeException(nameof(budget), "Batch budget must be positive.");
    }

    private async Task<LibrarySnapshot> LoadLibraryBatchAsync(LibraryResume? resume,
        CancellationToken cancellation, Action<LibrarySnapshot>? onCatalogReady, int budget)
    {
        var started = DateTimeOffset.UtcNow;
        var watch = Stopwatch.StartNew();
        var phases = ImmutableArray.CreateBuilder<LibraryLoadPhaseSample>(7);
        using var process = Process.GetCurrentProcess();
        void Sample(string phase)
        {
            process.Refresh();
            var heap = GC.GetGCMemoryInfo();
            phases.Add(new(phase, watch.ElapsedMilliseconds, GC.GetTotalMemory(false),
                heap.HeapSizeBytes, heap.FragmentedBytes, process.WorkingSet64,
                process.PrivateMemorySize64, GC.GetTotalAllocatedBytes(false)));
        }
        try
        {
            for (var attempt = 0; attempt < (resume is null ? 2 : 1); attempt++)
            {
                var runtime = Runtime;
                var catalogArgs = new List<string> { "find", "--all", "--kind", "project", "--history", "--limit",
                    Math.Min(PageSize, budget).ToString() };
                var catalog = resume?.Catalog is { HasMore: false } savedCatalog ? savedCatalog :
                    await PagesAsync(catalogArgs, null, cancellation, budget, resume?.Catalog);
                Sample($"catalog-{attempt + 1}");
                if (catalog.Error is not null)
                {
                    _libraryResume = null;
                    if (resume is null && IsRevisionConflict(catalog.Error) && attempt == 0) continue;
                    return PriorOrError(catalog.Error);
                }
                var published = resume?.CatalogPublished ?? false;
                if (!catalog.HasMore && catalog.Complete && !published &&
                    LastCompleteLibrary is null && onCatalogReady is not null)
                {
                    var projectedCatalog = RecordProjection.Build(catalog.Records, [], false);
                    onCatalogReady(new(projectedCatalog.Projects, [], [], [], catalog.Instance, catalog.Epoch,
                        catalog.Revision, DateTimeOffset.UtcNow, false, catalog.Records.Count,
                        catalog.Errors.ToImmutableArray(),
                        catalog.Advisories.Append("Project catalog ready; current records and counts are still loading.")
                            .ToImmutableArray(), null, catalog.Issues.ToImmutableArray(),
                        catalog.Records.Where(record => record.Kind == "project" &&
                            record.Lifecycle is "historical" or "superseded").ToImmutableArray(), true,
                        true, true));
                    published = true;
                    Sample($"catalog-published-{attempt + 1}");
                }
                var remaining = budget - (catalog.Records.Count - (resume?.Catalog.Records.Count ?? 0)) -
                    (catalog.Errors.Count - (resume?.Catalog.Errors.Count ?? 0));
                PageSet? current = resume?.Current;
                if (!catalog.HasMore && catalog.NextArgs is null && remaining > 0)
                {
                    var currentArgs = new List<string> { "find", "--all", "--limit",
                        Math.Min(PageSize, remaining).ToString(), "--at-revision",
                        catalog.Revision?.ToString() ?? "-1" };
                    current = current is { HasMore: false } savedCurrent ? savedCurrent :
                        await PagesAsync(currentArgs, catalog, cancellation, remaining, current);
                    Sample($"current-{attempt + 1}");
                    if (current.Error is not null)
                    {
                        _libraryResume = null;
                        if (resume is null && IsRevisionConflict(current.Error) && attempt == 0) continue;
                        return PriorOrError(current.Error);
                    }
                }
                if (Runtime != runtime)
                {
                    _libraryResume = null;
                    return PriorOrError("The selected runtime changed during library load; start a new load.");
                }
                var hasMore = catalog.HasMore || current is null || current.HasMore;
                var canContinue = hasMore && (catalog.HasMore ? catalog.NextArgs is not null :
                    current is null || current.NextArgs is not null);
                var complete = !hasMore && catalog.Complete && current?.Complete == true;
                var currentRows = current?.Records ?? [];
                var projected = RecordProjection.Build(catalog.Records, currentRows, complete);
                var snapshot = new LibrarySnapshot(projected.Projects, currentRows.ToImmutableArray(),
                    projected.Global, projected.Unassigned, catalog.Instance, catalog.Epoch, catalog.Revision,
                    DateTimeOffset.UtcNow, complete, catalog.Records.Count + currentRows.Count,
                    catalog.Errors.Concat(current?.Errors ?? []).ToImmutableArray(),
                    catalog.Advisories.Concat(current?.Advisories ?? [])
                        .Concat(hasMore ? ["Library loading is partial; more records remain."] : [])
                        .ToImmutableArray(), null,
                    catalog.Issues.Concat(current?.Issues ?? []).DistinctBy(issue => (issue.Id, issue.Code, issue.Message))
                        .ToImmutableArray(),
                    catalog.Records.Where(record => record.Kind == "project" &&
                        record.Lifecycle is "historical" or "superseded").ToImmutableArray(),
                    current is null, hasMore, canContinue);
                Sample($"projected-{attempt + 1}");
                _libraryResume = canContinue ? new(runtime, catalog, current, published) : null;
                if (complete) LastCompleteLibrary = snapshot;
                return complete || LastCompleteLibrary is null ? snapshot : PriorOrError(
                    $"Refresh was partial: {snapshot.LoadedCount} records loaded, " +
                    $"{snapshot.RecordErrors.Length} record errors; " +
                    string.Join("; ", snapshot.Advisories.Take(3)), hasMore, canContinue);
            }
            return PriorOrError("The database changed twice during library load; refresh again.");
        }
        finally
        {
            Sample("finished");
            LastLibraryLoadDiagnostics = new(started, DateTimeOffset.UtcNow, phases.ToImmutable());
        }
    }

    private static bool IsRevisionConflict(string error) =>
        error.Contains("revision", StringComparison.OrdinalIgnoreCase);

    private LibrarySnapshot PriorOrError(string error, bool hasMore = false, bool canContinue = false) => LastCompleteLibrary is { } prior
        ? prior with { Error = $"Refresh at {DateTimeOffset.UtcNow:O} failed: {error} " +
            $"Showing the complete snapshot read at {prior.ReadAt:O} (revision {prior.Revision?.ToString() ?? "unknown"}).",
            HasMore = hasMore, CanContinue = canContinue }
        : new([], [], [], [], null, null, null, DateTimeOffset.UtcNow, false, 0, [], [], error,
            HasMore: hasMore, CanContinue: canContinue);

    private sealed record LibraryResume(RuntimeSelection Runtime, PageSet Catalog, PageSet? Current,
        bool CatalogPublished);

    private sealed record PageSet(List<LibraryRecord> Records, List<string> Errors, List<string> Advisories,
        List<RecordIssue> Issues,
        string? Instance, string? Epoch, long? Revision, bool Complete, string? Error,
        bool HasMore = false, List<string>? NextArgs = null, int NextOffset = -1);

    private async Task<PageSet> PagesAsync(List<string> firstArgs, PageSet? anchor,
        CancellationToken cancellation, int budget = RecordBudget, PageSet? resume = null)
    {
        var rows = resume?.Records.ToList() ?? []; var errors = resume?.Errors.ToList() ?? [];
        var advisories = resume?.Advisories.ToList() ?? []; var issues = resume?.Issues.ToList() ?? [];
        string? instance = resume?.Instance ?? anchor?.Instance, epoch = resume?.Epoch ?? anchor?.Epoch;
        long? revision = resume?.Revision ?? anchor?.Revision;
        var complete = resume?.Complete ?? true; string? error = null;
        var args = resume?.NextArgs?.ToList() ?? firstArgs;
        var lastOffset = resume?.NextOffset ?? -1;
        var pageLimit = Math.Min(PageSize, budget);
        var readThisBatch = 0;
        var hasMore = false; List<string>? nextArgs = null; var nextOffset = -1;
        var selectedRuntime = Runtime;
        while (true)
        {
            cancellation.ThrowIfCancellationRequested();
            if (Runtime != selectedRuntime) { error = "The selected runtime changed during the scan."; break; }
            pageLimit = Math.Min(PageSize, budget - readThisBatch);
            firstArgs[firstArgs.IndexOf("--limit") + 1] = pageLimit.ToString();
            args[args.IndexOf("--limit") + 1] = pageLimit.ToString();
            var result = await CallAsync("find", args, cancellation);
            cancellation.ThrowIfCancellationRequested();
            if (Runtime != selectedRuntime) { error = "The selected runtime changed during the scan."; break; }
            if (!result.Success || result.Envelope is null) { error = result.Code + ": " + result.Message; break; }
            var envelope = result.Envelope.Value;
            var newInstance = JsonData.String(envelope, "database_instance_id");
            var newEpoch = JsonData.String(envelope, "database_epoch");
            var newRevision = JsonData.TryLong(envelope, "revision", out var rev) ? rev : (long?)null;
            if (newInstance is null || newEpoch is null || newRevision is null ||
                instance is not null && instance != newInstance || epoch is not null && epoch != newEpoch ||
                revision is not null && revision != newRevision)
            { error = "Store identity, epoch, or revision changed during the scan."; break; }
            instance = newInstance; epoch = newEpoch; revision = newRevision;
            var data = JsonData.Property(envelope, "data");
            if (data is not { ValueKind: JsonValueKind.Object } || !JsonData.TryArray(data.Value, "records", out var records))
            { error = "Find returned no records array."; break; }
            if (records.GetArrayLength() > pageLimit)
            { error = "Find returned more rows than the requested page limit."; break; }
            var priorErrorCount = errors.Count;
            readThisBatch += records.GetArrayLength();
            foreach (var item in records.EnumerateArray())
            {
                var record = RecordProjection.ReadRecord(item);
                if (record is null) { errors.Add("A returned record has an invalid normalized shape."); complete = false; }
                else rows.Add(record);
            }
            if (JsonData.TryArray(data.Value, "record_errors", out var recordErrors))
                foreach (var item in recordErrors.EnumerateArray())
                {
                    errors.Add(JsonData.Pretty(item)); complete = false;
                    var id = JsonData.TryObject(item, "identifiers", out var identifiers)
                        ? JsonData.String(identifiers, "id") : null;
                    issues.Add(new(id, JsonData.String(item, "code") ?? "record_error",
                        JsonData.String(item, "message") ?? "A stored record could not be normalized.", item.Clone()));
                }
            var pageErrorCount = errors.Count - priorErrorCount;
            if (records.GetArrayLength() + pageErrorCount > pageLimit)
            { error = "Find reported more rows and record errors than the requested page limit."; break; }
            readThisBatch += pageErrorCount;
            if (JsonData.TryBool(data.Value, "complete", out var dataComplete) && !dataComplete) complete = false;
            if (JsonData.TryBool(data.Value, "more", out var nestedMore) && nestedMore) complete = false;
            if (!JsonData.TryBool(envelope, "more", out var more)) { complete = false; advisories.Add("Missing paging state."); break; }
            if (!more)
            {
                hasMore = false; nextArgs = null; nextOffset = -1;
                break;
            }
            if (records.GetArrayLength() < pageLimit && errors.Count == priorErrorCount)
            { error = "Find reported more pages after a short page without record errors."; break; }
            hasMore = true;
            var offsetAt = args.IndexOf("--offset");
            var requestOffset = offsetAt >= 0 && int.TryParse(args[offsetAt + 1], out var parsedOffset)
                ? parsedOffset : 0;
            if (!TryContinuation(envelope, firstArgs, revision.Value, lastOffset,
                (long)requestOffset + pageLimit, out var next, out var validatedOffset,
                out var notes))
            { complete = false; advisories.AddRange(notes); advisories.Add("A valid continuation is missing; scan stopped."); break; }
            advisories.AddRange(notes); nextArgs = next; nextOffset = validatedOffset;
            if (readThisBatch >= budget) break;
            args = next; lastOffset = validatedOffset;
        }
        return new(rows, errors, advisories, issues, instance, epoch, revision, complete, error,
            hasMore, nextArgs, nextOffset);
    }

    private static bool TryContinuation(JsonElement envelope, List<string> initial, long revision,
        int lastOffset, long expectedOffset, out List<string> next, out int nextOffset,
        out List<string> advisories)
    {
        next = []; nextOffset = lastOffset; advisories = [];
        if (!JsonData.TryArray(envelope, "next", out var entries)) return false;
        foreach (var entry in entries.EnumerateArray())
        {
            if (entry.ValueKind == JsonValueKind.String) { advisories.Add(entry.GetString()!); continue; }
            if (entry.ValueKind != JsonValueKind.Object || JsonData.String(entry, "command") != "find" ||
                !JsonData.TryArray(entry, "args", out var values)) continue;
            var tokens = values.EnumerateArray().Select(v => v.ValueKind == JsonValueKind.String ? v.GetString() : null).ToArray();
            if (tokens.Any(v => v is null)) continue;
            var candidate = tokens.Select(v => v!).ToList();
            var expected = initial.Skip(1).TakeWhile(v => v != "--at-revision").ToList();
            // The first page lacks --offset; the continuation adds it and an exact pinned revision.
            var offsetAt = candidate.IndexOf("--offset"); var revisionAt = candidate.IndexOf("--at-revision");
            if (offsetAt < 0 || revisionAt < 0 || offsetAt + 1 >= candidate.Count ||
                revisionAt + 1 >= candidate.Count || !int.TryParse(candidate[offsetAt + 1], out var offset) ||
                offset <= lastOffset || offset <= 0 || offset != expectedOffset ||
                candidate[revisionAt + 1] != revision.ToString()) continue;
            var stable = candidate.Where((_, index) => index != offsetAt && index != offsetAt + 1 &&
                index != revisionAt && index != revisionAt + 1).ToList();
            if (!stable.SequenceEqual(expected, StringComparer.Ordinal)) continue;
            next = ["find", ..candidate]; nextOffset = offset; return true;
        }
        return false;
    }

    public async Task<RecordSnapshot> GetRecordAsync(string id, CancellationToken cancellation = default)
    {
        var result = await CallAsync("get", ["get", "--", id], cancellation);
        return ParseRecord(result);
    }
    public async Task<RecordSnapshot> GetHistoryAsync(string id, CancellationToken cancellation = default)
    {
        var result = await CallAsync("get", ["get", "--history", "--", id], cancellation);
        return ParseRecord(result);
    }
    public async Task<RecordSnapshot> GetRawAsync(string id, CancellationToken cancellation = default)
    {
        var result = await CallAsync("get", ["get", "--raw", "--", id], cancellation);
        return ParseRecord(result);
    }
    private static RecordSnapshot ParseRecord(CliResult result)
    {
        var now = DateTimeOffset.UtcNow;
        if (!result.Success || result.Envelope is null)
            return new(null, null, null, [], null, null, null, now, result.Code + ": " + result.Message);
        var envelope = result.Envelope.Value;
        var data = JsonData.Property(envelope, "data");
        var record = data is { } content ? RecordProjection.ReadRecord(content) : null;
        var basis = data is { } source ? JsonData.Property(source, "write_basis")?.Clone() : null;
        var raw = data is { } rawSource ? JsonData.Property(rawSource, "raw_record")?.Clone() : null;
        if (raw is null && data is { } historyData && JsonData.TryObject(historyData, "current", out var current))
            raw = JsonData.Property(current, "raw_record")?.Clone();
        var history = data is { } historySource && JsonData.TryArray(historySource, "versions", out var versions)
            ? versions.EnumerateArray().Select(v => v.Clone()).ToImmutableArray() : [];
        return new(record, basis, raw, history, JsonData.String(envelope, "database_instance_id"),
            JsonData.String(envelope, "database_epoch"),
            JsonData.TryLong(envelope, "revision", out var revision) ? revision : null,
            now, data is null ? "Record data is missing." : null,
            history.Select(DecodeHistory).ToImmutableArray());
    }

    private static DecodedHistoryVersion DecodeHistory(JsonElement version)
    {
        JsonElement? stored = null;
        long? oldRevision = null;
        if (JsonData.TryObject(version, "raw_record", out var row) &&
            JsonData.TryString(row, "content_json", out var content))
        {
            try
            {
                using var document = JsonDocument.Parse(content);
                stored = document.RootElement.Clone();
                if (JsonData.TryObject(stored.Value, "_lodestar", out var metadata) &&
                    JsonData.TryLong(metadata, "revision", out var actual)) oldRevision = actual;
            }
            catch (JsonException) { /* Preserve raw evidence when stored JSON is malformed. */ }
        }
        return new(JsonData.TryLong(version, "revision", out var replacing) ? replacing : null,
            oldRevision, JsonData.String(version, "receipt_id"), stored, version.Clone());
    }

    public Task<CliResult> StartProjectAsync(string root, CancellationToken cancellation = default) =>
        CallAsync("start", ["start", "--cwd", root], cancellation);

    public async Task<ProjectContextResult> ValidateProjectContextAsync(ProjectSummary selected,
        CancellationToken cancellation = default)
    {
        var root = selected.Roots.FirstOrDefault(Directory.Exists);
        if (root is null)
            return new(false, selected.Id, null, null, [], null, null,
                "No recorded project root currently resolves; stored records remain available.");
        var read = await StartProjectAsync(root, cancellation);
        if (!read.Success || read.Envelope is null)
            return new(false, selected.Id, null, null, [], root, null,
                "start --cwd failed: " + read.Message);
        var data = JsonData.Property(read.Envelope.Value, "data");
        if (data is not { ValueKind: JsonValueKind.Object } ||
            !JsonData.TryObject(data.Value, "project", out var project))
            return new(false, selected.Id, null, null, [], root, data, "start returned no project mapping.");
        var resolved = JsonData.String(project, "id");
        var scope = JsonData.String(project, "scope");
        if (LastCompleteLibrary is { } library &&
            (JsonData.String(read.Envelope.Value, "database_instance_id") != library.DatabaseInstanceId ||
             JsonData.String(read.Envelope.Value, "database_epoch") != library.DatabaseEpoch))
            return new(false, selected.Id, resolved, scope, [], root, data.Value.Clone(),
                "The selected database identity or epoch changed since the library read.");
        var history = JsonData.TryArray(project, "historical_scopes", out var scopes)
            ? scopes.EnumerateArray().Where(s => s.ValueKind == JsonValueKind.String)
                .Select(s => s.GetString()!).ToImmutableArray() : [];
        var matched = resolved == selected.Id && scope is not null && selected.KnownScopes.Contains(scope);
        return new(matched, selected.Id, resolved, scope, history, root, data.Value.Clone(),
            matched ? null : "The root now resolves to a different project mapping; root-dependent actions are blocked.");
    }

    public async Task<LibrarySnapshot> LoadHistoricalScopeAsync(ProjectSummary project, string scope,
        CancellationToken cancellation = default)
    {
        var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (!mapping.Matched || !mapping.HistoricalScopes.Contains(scope))
            return PriorOrError(mapping.Error ?? "The requested historical scope is not explicitly mapped.");
        var pages = await PagesAsync(["find", "--all", "--scope", scope, "--history", "--limit", "250"],
            null, cancellation);
        if (pages.Error is not null) return PriorOrError(pages.Error);
        return new([project], pages.Records.ToImmutableArray(), [], [], pages.Instance, pages.Epoch,
            pages.Revision, DateTimeOffset.UtcNow, pages.Complete && !pages.HasMore, pages.Records.Count,
            pages.Errors.ToImmutableArray(), pages.Advisories.Concat(pages.HasMore
                ? ["Historical scope reached the client record budget; counts are partial."] : [])
                .ToImmutableArray(), null, pages.Issues.ToImmutableArray(),
            HasMore: pages.HasMore);
    }

    public async Task<CliResult> ReadProjectDomainAsync(ProjectSummary project, string operationId,
        int limit = 250, string? decisionKey = null, CancellationToken cancellation = default)
    {
        var expected = operationId switch {
            "work.status" => new[] { "work", "status" },
            "work.history" => ["work", "history"],
            "handoff.status" => ["handoff", "status"],
            "handoff.history" => ["handoff", "history"],
            "decision.show" => ["decision", "show"],
            "pending.list" => ["pending", "list"],
            _ => null
        };
        var supportsLimit = operationId is "work.status" or "work.history" or "pending.list";
        if (expected is null || (supportsLimit ? limit is < 1 or > 250 : limit != 250) ||
            decisionKey is not null && operationId != "decision.show")
            return new(false, null, "unsupported_domain_read", "Unsupported operation or limit; only work and pending reads accept limit 1–250.",
                null, "", 0);
        var descriptor = Capabilities?.Version == 1
            ? Capabilities.Operations.FirstOrDefault(candidate => candidate.Id == operationId) : null;
        if (descriptor is null || descriptor.Effect != "read" || !descriptor.Argv.SequenceEqual(expected) ||
            !JsonData.TryObject(descriptor.Description, "context", out var context) ||
            !JsonData.TryBool(context, "project", out var needsProject) || !needsProject ||
            !JsonData.TryBool(context, "actor", out var needsActor) || needsActor ||
            !JsonData.TryArray(descriptor.Description, "parameters", out var parameters) ||
            !parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "cwd" &&
                JsonData.String(parameter, "binding") == "option" && JsonData.String(parameter, "flag") == "--cwd") ||
            (supportsLimit && !parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "limit" &&
                JsonData.String(parameter, "binding") == "option" && JsonData.String(parameter, "flag") == "--limit")))
            return new(false, null, "unsupported_domain_read", "The selected core does not describe this supported project read.",
                null, "", 0);
        var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (!mapping.Matched || mapping.Root is null)
            return new(false, null, "project_context_mismatch", mapping.Error ?? "The project root no longer matches.",
                null, "", 0);
        var args = expected.ToList();
        args.Add("--cwd"); args.Add(mapping.Root);
        if (supportsLimit)
        { args.Add("--limit"); args.Add(limit.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
        if (decisionKey is not null)
        {
            if (string.IsNullOrWhiteSpace(decisionKey) || JsonData.HasInvalidUnicode(decisionKey))
                return new(false, null, "invalid_input", "Decision key is invalid.", null, "", 0);
            args.Add("--"); args.Add(decisionKey);
        }
        return await CallAsync(operationId, args, cancellation);
    }

    public async Task<CliResult> CheckIntentAsync(ProjectSummary project, string intentRecordId,
        CancellationToken cancellation = default)
    {
        static CliResult Rejected(string code, string message) =>
            new(false, null, code, message, null, "", 0);
        if (string.IsNullOrWhiteSpace(intentRecordId) || JsonData.HasInvalidUnicode(intentRecordId))
            return Rejected("invalid_input", "Select an exact intent record ID.");
        var descriptor = Capabilities?.Version == 1
            ? Capabilities.Operations.FirstOrDefault(item => item.Id == "work.check") : null;
        if (descriptor is null || descriptor.Effect != "read" ||
            !descriptor.Argv.SequenceEqual(["work", "check"]) ||
            !JsonData.TryObject(descriptor.Description, "context", out var context) ||
            !JsonData.TryBool(context, "project", out var needsProject) || !needsProject ||
            !JsonData.TryBool(context, "actor", out var needsActor) || needsActor ||
            !JsonData.TryArray(descriptor.Description, "parameters", out var parameters) ||
            !parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "cwd" &&
                JsonData.String(parameter, "binding") == "option" && JsonData.String(parameter, "flag") == "--cwd") ||
            !parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "intent_record_id" &&
                JsonData.String(parameter, "binding") == "positional" && JsonData.TryInt(parameter, "index", out var index) && index == 0))
            return Rejected("unsupported_domain_read", "The selected core does not describe the exact work.check read.");
        var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (!mapping.Matched || mapping.Root is null || mapping.CanonicalScope is null)
            return Rejected("project_context_mismatch", mapping.Error ?? "The project root no longer matches.");
        var current = await GetRecordAsync(intentRecordId, cancellation);
        if (current.Error is not null || current.Record is not { } record || record.Id != intentRecordId ||
            record.Kind != "knowledge" || record.Scope != mapping.CanonicalScope ||
            record.Lifecycle is "historical" or "superseded" ||
            record.Availability is "unavailable" or "stale" ||
            JsonData.Property(record.Json, "data") is not { ValueKind: JsonValueKind.Object } data ||
            !JsonData.TryObject(data, "intent", out _))
            return Rejected("invalid_intent_selection", "The selected record is not a current, readable intent knowledge record in this verified project.");
        return await CallAsync("work.check", ["work", "check", "--cwd", mapping.Root, "--", intentRecordId], cancellation);
    }

    public async Task<CliResult> ReadContinuityAsync(ProjectSummary project, ImmutableArray<string> arguments,
        CancellationToken cancellation = default)
    {
        // A projection may offer literal reads, never an executable, DB override or write.
        var root = project.Roots.FirstOrDefault(Directory.Exists);
        var operation = IntentContinuityReadout.ReadOperation(arguments, root);
        if (operation is null)
            return new(false, null, "unsupported_continuity_read", "Unsupported continuity read; no command was dispatched.", null, "", 0);
        var runtime = Runtime;
        var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (Runtime != runtime || !mapping.Matched || mapping.Root is null ||
            IntentContinuityReadout.ReadOperation(arguments, mapping.Root) != operation)
            return new(false, null, "project_context_mismatch", mapping.Error ?? "Selected runtime or project root changed; reopen the intent read.", null, "", 0);
        if (operation == "decision.show")
            return await ReadProjectDomainAsync(project, operation, decisionKey: arguments[^1], cancellation: cancellation);
        return await CallAsync("get", arguments, cancellation);
    }

    public EditReview ReviewEdit(RecordSnapshot baseline, EditDraft draft) =>
        RecordEditor.Prepare(baseline, draft, Runtime, _journalRoot);

    public IReadOnlyList<PendingSave> PendingSaves() => MergeSharedRecovery(EnumeratePendingSaves(Directory.EnumerateDirectories));

    internal PendingSaveListing ReadPendingSaves(Func<string, IEnumerable<string>>? enumerate = null)
    {
        try
        {
            var items = MergeSharedRecovery(EnumeratePendingSaves(enumerate ?? Directory.EnumerateDirectories));
            _lastPendingSaves = items;
            return new(items, _sharedRecoveryError, _journalRoot, _sharedRecoveryError is null ? null : "shared_recovery_incomplete");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException)
        {
            return new(_lastPendingSaves,
                "Pending saves could not read the journal root. Inspect the listed folder, preserve its files, then select Pending saves again to retry the read.",
                _journalRoot, "journal_read_failed");
        }
    }

    private IReadOnlyList<PendingSave> EnumeratePendingSaves(Func<string, IEnumerable<string>> enumerate)
    {
        FileAttributes rootAttributes;
        try { rootAttributes = File.GetAttributes(_journalRoot); }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { return []; }
        if ((rootAttributes & FileAttributes.Directory) == 0 ||
            (rootAttributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Journal root is not a direct local directory.");
        var items = new List<PendingSave>();
        foreach (var directory in enumerate(_journalRoot))
        {
            var requestId = Path.GetFileName(directory);
            var recordId = "";
            var database = "";
            var created = DateTimeOffset.MinValue;
            string? issue = null;
            var replayEligible = false;
            var operation = "put";
            string? projectRoot = null;
            var commitReported = false;
            long? committedRevision = null;
            string? receiptId = null;
            try
            {
                created = new DateTimeOffset(Directory.GetCreationTimeUtc(directory));
                if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Journal directory is a reparse point.");
                if (!requestId.StartsWith("ll-", StringComparison.Ordinal) ||
                    !Guid.TryParse(requestId.AsSpan(3), out _))
                    throw new InvalidDataException("Journal directory has an invalid request ID.");
                if (!File.Exists(Path.Combine(directory, "request.json")))
                    throw new InvalidDataException("Frozen request is missing.");
                if ((File.GetAttributes(Path.Combine(directory, "request.json")) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Frozen request is a reparse point.");
                if (!File.Exists(Path.Combine(directory, "context.json")))
                    throw new InvalidDataException("Request context is missing or unreadable.");
                if ((File.GetAttributes(Path.Combine(directory, "context.json")) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Request context is a reparse point.");
                using var context = JsonData.ParseDocument(File.ReadAllBytes(Path.Combine(directory, "context.json")));
                var value = context.RootElement;
                recordId = JsonData.String(value, "record_id") ?? "";
                database = JsonData.String(value, "database") ?? "";
                var savedHash = JsonData.String(value, "request_sha256");
                operation = JsonData.String(value, "operation") ?? "put";
                projectRoot = JsonData.String(value, "project_root");
                var projectId = JsonData.String(value, "project_id");
                var projectScope = JsonData.String(value, "project_scope");
                if (JsonData.String(value, "request_id") != requestId ||
                    string.IsNullOrWhiteSpace(recordId) || string.IsNullOrWhiteSpace(database) ||
                    string.IsNullOrWhiteSpace(JsonData.String(value, "database_instance_id")) ||
                    string.IsNullOrWhiteSpace(JsonData.String(value, "database_epoch")) ||
                    operation is not ("put" or "delete" or "decision.set" or "pending.drop") ||
                    (projectRoot is null) != (projectId is null) ||
                    (projectRoot is null) != (projectScope is null) ||
                    (operation != "put" && projectRoot is null) ||
                    (projectRoot is not null && (string.IsNullOrWhiteSpace(projectRoot) ||
                        string.IsNullOrWhiteSpace(projectId) || string.IsNullOrWhiteSpace(projectScope))) ||
                    JsonData.String(value, "config") != Runtime.ConfigPath ||
                    JsonData.String(value, "generation") != Runtime.Generation ||
                    JsonData.String(value, "fingerprint") != Runtime.Fingerprint ||
                    database != Runtime.DatabasePath)
                    throw new InvalidDataException("Request identity or runtime context is incomplete or changed.");
                if (savedHash is null || savedHash.Length != 64 || !savedHash.All(Uri.IsHexDigit))
                    throw new InvalidDataException("Original request SHA-256 is missing or corrupt.");
                var dispatchHash = JsonData.String(value, "dispatch_sha256");
                if (dispatchHash is null ? operation != "put" || projectRoot is not null :
                    dispatchHash != DispatchHash(operation, projectRoot, savedHash))
                    throw new InvalidDataException("Saved operation or project root digest is missing or changed.");
                var bytes = File.ReadAllBytes(Path.Combine(directory, "request.json"));
                if (!string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), savedHash,
                    StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Frozen request differs from its original SHA-256.");
                using var request = JsonData.ParseDocument(bytes);
                if (!MatchesFrozenRequest(request.RootElement, requestId, recordId, operation,
                    projectRoot, projectScope))
                    throw new InvalidDataException("Frozen request identity differs from its context.");
                var frozen = new FrozenMutation(requestId, recordId, Runtime,
                    JsonData.String(value, "database_instance_id")!,
                    JsonData.String(value, "database_epoch")!, bytes, directory,
                    operation, projectRoot, projectId, projectScope);
                replayEligible = true;
                var priorUnknown = !JsonData.TryBool(value, "prior_outcome_unknown", out var unknown) || unknown;
                if (value.TryGetProperty("prior_outcome_unknown", out _) &&
                    !JsonData.TryBool(value, "prior_outcome_unknown", out _))
                    throw new InvalidDataException("Prior outcome state is invalid.");
                var firstUncertainty = ReadFirstUncertainty(frozen, priorUnknown);
                if (firstUncertainty is not null) priorUnknown = true;
                var responseFile = Path.Combine(directory, "response.json");
                if (Directory.Exists(responseFile))
                    throw new InvalidDataException("Recorded response is a directory.");
                JsonElement? deliveryStatus = null;
                if (File.Exists(responseFile))
                {
                    if ((File.GetAttributes(responseFile) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("Recorded response is a reparse point.");
                    try
                    {
                        using var response = JsonData.ParseDocument(File.ReadAllBytes(responseFile));
                        var verified = ValidateMutationResponse(response.RootElement, frozen);
                        if (verified.Code == "response_delivery_failed") deliveryStatus = response.RootElement.Clone();
                        else if (verified.MayHaveCommitted) issue = verified.Message;
                        else if (verified.Success || !priorUnknown) continue;
                        else issue = "The exact replay was rejected; a prior write outcome remains unknown. Verify the original receipt before resolving this journal.";
                    }
                    catch (Exception error) when (error is JsonException or InvalidDataException)
                    {
                        issue = "Recorded response cannot be verified. Its bytes are preserved; deliberate exact replay can reconcile the original request.";
                    }
                }
                var deliveryFile = Path.Combine(directory, "delivery-error.json");
                if (deliveryStatus is null && File.Exists(deliveryFile))
                {
                    if ((File.GetAttributes(deliveryFile) & FileAttributes.ReparsePoint) != 0)
                        throw new InvalidDataException("Recorded delivery status is a reparse point.");
                    using var delivery = JsonData.ParseDocument(File.ReadAllBytes(deliveryFile));
                    deliveryStatus = delivery.RootElement.Clone();
                }
                if (deliveryStatus is { } reported)
                {
                    ValidateMutationResponse(reported, frozen);
                    if (!TryMatchingDeliveryReport(reported, frozen, out var reportedRevision,
                        out receiptId))
                        throw new InvalidDataException("Recorded delivery status cannot be verified.");
                    commitReported = true;
                    committedRevision = reportedRevision;
                }
                if (firstUncertainty is not null)
                    issue = (issue is null ? "" : issue + " ") + "Original unresolved attempt: " +
                        firstUncertainty.Code + ": " + firstUncertainty.Message;
            }
            catch (Exception error) { issue = error.Message; replayEligible = false; }
            items.Add(new(requestId, recordId, database, created, directory, replayEligible, issue,
                operation, projectRoot, commitReported, committedRevision, receiptId));
        }
        return items.OrderByDescending(i => i.CreatedAt).ToArray();
    }

    private static bool ExistingAttributes(string path, out FileAttributes attributes)
    {
        try { attributes = File.GetAttributes(path); return true; }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { attributes = default; return false; }
    }

    public Task<SaveResult> SaveAsync(FrozenMutation frozen, CancellationToken cancellation = default) =>
        SaveCoreAsync(frozen, cancellation, reconcileUnverifiedResponse: false);

    private async Task<SaveResult> SaveCoreAsync(FrozenMutation frozen, CancellationToken cancellation,
        bool reconcileUnverifiedResponse)
    {
        if (frozen.OperationId is not ("put" or "delete" or "decision.set" or "pending.drop") ||
            (frozen.ProjectRoot is null) != (frozen.ProjectId is null) ||
            (frozen.ProjectRoot is null) != (frozen.ProjectScope is null) ||
            (frozen.ProjectRoot is not null && (string.IsNullOrWhiteSpace(frozen.ProjectRoot) ||
                string.IsNullOrWhiteSpace(frozen.ProjectId) || string.IsNullOrWhiteSpace(frozen.ProjectScope))) ||
            frozen.OperationId != "put" && frozen.ProjectRoot is null)
            return new(false, false, false, frozen.RequestId, "Frozen operation or project context is invalid.", null);
        var fullRoot = Path.GetFullPath(_journalRoot).TrimEnd(Path.DirectorySeparatorChar);
        var fullJournal = Path.GetFullPath(frozen.JournalDirectory).TrimEnd(Path.DirectorySeparatorChar);
        if (!frozen.RequestId.StartsWith("ll-", StringComparison.Ordinal) ||
            !Guid.TryParse(frozen.RequestId.AsSpan(3), out _) ||
            Path.GetFileName(fullJournal) != frozen.RequestId ||
            !string.Equals(Path.GetDirectoryName(fullJournal), fullRoot, StringComparison.OrdinalIgnoreCase))
            return new(false, false, false, frozen.RequestId, "Request journal path is invalid.", null);
        var requestFile = Path.Combine(fullJournal, "request.json");
        var previouslyPending = false;
        var incompleteJournal = false;
        try
        {
            if (ExistingAttributes(fullRoot, out var rootAttributes) &&
                    ((rootAttributes & FileAttributes.ReparsePoint) != 0 ||
                     (rootAttributes & FileAttributes.Directory) == 0) ||
                ExistingAttributes(fullJournal, out var journalAttributes) &&
                    ((journalAttributes & FileAttributes.ReparsePoint) != 0 ||
                     (journalAttributes & FileAttributes.Directory) == 0))
                return new(false, true, true, frozen.RequestId,
                    "Pending saves needs inspection: the journal path is not a direct local directory. This attempt was not sent.", null);
            previouslyPending = ExistingAttributes(requestFile, out var requestAttributes);
            incompleteJournal = ExistingAttributes(fullJournal, out _) && !previouslyPending;
            if (previouslyPending && (requestAttributes & FileAttributes.ReparsePoint) != 0)
                return new(false, true, true, frozen.RequestId,
                    "Pending saves needs inspection: the saved request is a reparse point. This attempt was not sent.", null);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or SecurityException)
        {
            return new(false, true, true, frozen.RequestId,
                "Pending saves needs inspection: the existing journal cannot be verified (" +
                error.GetType().Name + ", HRESULT 0x" + error.HResult.ToString("X8") +
                "). This attempt was not sent. Inspect Pending saves and preserve its files before retrying.", null);
        }
        SaveResult PreflightFailure(string reason) => new(false, previouslyPending,
            previouslyPending || incompleteJournal, frozen.RequestId,
            (previouslyPending ? "A prior request outcome is unknown; this attempt was not sent. " :
                incompleteJournal ? "An incomplete journal needs inspection; this attempt was not sent. " :
                    "Save was not sent. ") + reason +
            (previouslyPending || incompleteJournal ? " Inspect Pending saves before another attempt." : ""), null);
        if (!frozen.Runtime.Equals(Runtime))
            return PreflightFailure("Selected runtime changed; retain the draft and reload.");
        RuntimeSelection current;
        try { current = await RuntimeConfig.LoadAsync(Runtime.ConfigPath, cancellation); }
        catch (Exception error) { return PreflightFailure("Runtime configuration could not be read: " + error.Message); }
        if (!current.Equals(frozen.Runtime))
            return PreflightFailure("Configuration or runtime changed; save is blocked.");
        var dispatchAttempted = false;
        var priorOutcomeUnknown = false;
        var contextFile = Path.Combine(frozen.JournalDirectory, "context.json");
        try
        {
            var requestHash = Convert.ToHexString(SHA256.HashData(frozen.ExactRequestUtf8)).ToLowerInvariant();
            using var request = JsonData.ParseDocument(frozen.ExactRequestUtf8);
            if (!MatchesFrozenRequest(request.RootElement, frozen.RequestId, frozen.RecordId,
                frozen.OperationId, frozen.ProjectRoot, frozen.ProjectScope))
                throw new InvalidDataException("Frozen request identity differs from its context.");
            if (frozen.OperationId == "put" &&
                JsonData.TryObject(request.RootElement, "input", out var putInput) &&
                JsonData.String(putInput, "mode") == "create" &&
                JsonData.TryObject(putInput, "record", out var createdRecord) &&
                JsonData.String(createdRecord, "kind") == "project")
            {
                if (!JsonData.TryObject(createdRecord, "data", out var projectData) ||
                    !JsonData.TryArray(projectData, "roots", out var roots) ||
                    roots.GetArrayLength() == 0 || roots.EnumerateArray().Any(item =>
                        item.ValueKind != JsonValueKind.String ||
                        !Path.IsPathFullyQualified(item.GetString()!) ||
                        !Directory.Exists(item.GetString()!)))
                    throw new InvalidDataException("The new project's recorded root no longer resolves.");
            }
            if (frozen.ProjectRoot is not null)
            {
                if (!Path.IsPathFullyQualified(frozen.ProjectRoot) || !Directory.Exists(frozen.ProjectRoot))
                    throw new InvalidDataException("The saved project root no longer resolves.");
                var mapped = await StartProjectAsync(frozen.ProjectRoot, cancellation);
                if (!mapped.Success || mapped.Envelope is null ||
                    JsonData.String(mapped.Envelope.Value, "database_instance_id") != frozen.DatabaseInstanceId ||
                    JsonData.String(mapped.Envelope.Value, "database_epoch") != frozen.DatabaseEpoch ||
                    !JsonData.TryObject(mapped.Envelope.Value, "data", out var startData) ||
                    !JsonData.TryObject(startData, "project", out var selected) ||
                    JsonData.String(selected, "id") != frozen.ProjectId ||
                    JsonData.String(selected, "scope") != frozen.ProjectScope)
                    throw new InvalidDataException("The project root or selected store changed; dispatch is blocked.");
            }
            var identity = await CallAsync("find", ["find", "--all", "--limit", "1"], cancellation);
            if (!identity.Success || identity.Envelope is null) throw new InvalidDataException(identity.Message);
            var envelope = identity.Envelope.Value;
            if (JsonData.String(envelope, "database_instance_id") != frozen.DatabaseInstanceId ||
                JsonData.String(envelope, "database_epoch") != frozen.DatabaseEpoch)
                throw new InvalidDataException("Database identity or epoch changed; exact replay is blocked.");
            Directory.CreateDirectory(frozen.JournalDirectory);
            var existingRequest = File.Exists(requestFile);
            if (existingRequest)
            {
                if (!File.ReadAllBytes(requestFile).AsSpan().SequenceEqual(frozen.ExactRequestUtf8))
                    throw new InvalidDataException("The pending request bytes differ from the frozen body.");
            }
            else
            {
                await using var stream = new FileStream(requestFile, FileMode.CreateNew, FileAccess.Write,
                    FileShare.None, 4096, FileOptions.WriteThrough);
                await stream.WriteAsync(frozen.ExactRequestUtf8, cancellation);
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(contextFile))
            {
                using var contextDocument = JsonData.ParseDocument(await File.ReadAllBytesAsync(contextFile, cancellation));
                var savedContext = contextDocument.RootElement;
                priorOutcomeUnknown = !JsonData.TryBool(savedContext, "prior_outcome_unknown", out var unknown) || unknown;
                if (savedContext.TryGetProperty("prior_outcome_unknown", out _) &&
                    !JsonData.TryBool(savedContext, "prior_outcome_unknown", out _))
                    throw new InvalidDataException("Prior outcome state is invalid.");
                var savedOperation = JsonData.String(savedContext, "operation") ?? "put";
                var savedRoot = JsonData.String(savedContext, "project_root");
                var savedDispatchHash = JsonData.String(savedContext, "dispatch_sha256");
                if (JsonData.String(savedContext, "request_sha256") != requestHash ||
                    JsonData.String(savedContext, "request_id") != frozen.RequestId ||
                    JsonData.String(savedContext, "record_id") != frozen.RecordId ||
                    JsonData.String(savedContext, "config") != frozen.Runtime.ConfigPath ||
                    JsonData.String(savedContext, "generation") != frozen.Runtime.Generation ||
                    JsonData.String(savedContext, "fingerprint") != frozen.Runtime.Fingerprint ||
                    JsonData.String(savedContext, "database") != frozen.Runtime.DatabasePath ||
                    JsonData.String(savedContext, "database_instance_id") != frozen.DatabaseInstanceId ||
                    JsonData.String(savedContext, "database_epoch") != frozen.DatabaseEpoch ||
                    savedOperation != frozen.OperationId || savedRoot != frozen.ProjectRoot ||
                    JsonData.String(savedContext, "project_id") != frozen.ProjectId ||
                    JsonData.String(savedContext, "project_scope") != frozen.ProjectScope ||
                    (savedDispatchHash is null ? frozen.OperationId != "put" || frozen.ProjectRoot is not null :
                        savedDispatchHash != DispatchHash(frozen.OperationId, frozen.ProjectRoot, requestHash)))
                    throw new InvalidDataException("Pending request context or original SHA-256 is missing or changed; replay is blocked.");
            }
            else
            {
                if (existingRequest)
                    throw new InvalidDataException("Pending request context is missing; replay is blocked.");
                var contextBytes = JsonSerializer.SerializeToUtf8Bytes(new {
                    request_id = frozen.RequestId, record_id = frozen.RecordId,
                    request_sha256 = requestHash,
                    config = frozen.Runtime.ConfigPath, generation = frozen.Runtime.Generation,
                    fingerprint = frozen.Runtime.Fingerprint, database = frozen.Runtime.DatabasePath,
                    database_instance_id = frozen.DatabaseInstanceId, database_epoch = frozen.DatabaseEpoch,
                    operation = frozen.OperationId, project_root = frozen.ProjectRoot,
                    project_id = frozen.ProjectId, project_scope = frozen.ProjectScope,
                    prior_outcome_unknown = false,
                    dispatch_sha256 = DispatchHash(frozen.OperationId, frozen.ProjectRoot, requestHash)
                });
                await using var stream = new FileStream(contextFile, FileMode.CreateNew, FileAccess.Write,
                    FileShare.None, 4096, FileOptions.WriteThrough);
                await stream.WriteAsync(contextBytes, cancellation);
                stream.Flush(flushToDisk: true);
            }
            var responseFile = Path.Combine(frozen.JournalDirectory, "response.json");
            var firstUncertainty = ReadFirstUncertainty(frozen, priorOutcomeUnknown);
            if (firstUncertainty is not null) priorOutcomeUnknown = true;
            if (ExistingAttributes(responseFile, out var responseAttributes))
            {
                if ((responseAttributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                    throw new InvalidDataException("Recorded response is not a direct local file.");
                var responseBytes = await File.ReadAllBytesAsync(responseFile, cancellation);
                CliResult? verified = null;
                try
                {
                    using var response = JsonData.ParseDocument(responseBytes);
                    verified = ValidateMutationResponse(response.RootElement, frozen);
                }
                catch (Exception error) when (error is JsonException or InvalidDataException)
                {
                    if (!reconcileUnverifiedResponse) throw;
                    await PreserveUnverifiedResponseAsync(frozen.JournalDirectory, responseBytes, cancellation);
                    priorOutcomeUnknown = true;
                }
                if (verified is { MayHaveCommitted: true } && verified.Code != "response_delivery_failed")
                {
                    await RetainFirstUncertaintyAsync(frozen, verified, cancellation, responseBytes);
                    priorOutcomeUnknown = true;
                    if (!reconcileUnverifiedResponse)
                        return new(false, true, true, frozen.RequestId, verified.Message, verified);
                }
                else if (verified is not null && verified.Code != "response_delivery_failed")
                {
                    if (verified.Success || !priorOutcomeUnknown)
                        return new(verified.Success, false, false, frozen.RequestId,
                            verified.Success ? null : verified.Message, verified);
                    if (!reconcileUnverifiedResponse)
                        return new(false, true, true, frozen.RequestId,
                            "The exact replay was rejected; a prior write outcome remains unknown. " + verified.Message +
                                (firstUncertainty is null ? "" : " Original unresolved attempt: " + firstUncertainty.Code + ": " + firstUncertainty.Message), verified);
                }
                else priorOutcomeUnknown = true;
            }
            else if (existingRequest)
            {
                priorOutcomeUnknown = true;
                if (firstUncertainty is null)
                    await RetainFirstUncertaintyAsync(frozen, new(false, null, "response_missing",
                        "A prior request has no verified response. Inspect its exact request and original receipt before replay.",
                        null, "", 0, true), cancellation);
            }
            if (priorOutcomeUnknown) await RetainUnknownOutcomeAsync(contextFile, cancellation);
            await using var lockedRequest = new FileStream(requestFile, FileMode.Open, FileAccess.Read,
                FileShare.Read, 4096, FileOptions.SequentialScan);
            if (lockedRequest.Length != frozen.ExactRequestUtf8.Length)
                throw new InvalidDataException("Pending request length changed before dispatch.");
            var checkedBytes = new byte[frozen.ExactRequestUtf8.Length];
            await lockedRequest.ReadExactlyAsync(checkedBytes, cancellation);
            if (!string.Equals(Convert.ToHexString(SHA256.HashData(checkedBytes)), requestHash,
                StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Pending request SHA-256 changed before dispatch.");
            dispatchAttempted = true;
            var arguments = frozen.OperationId switch {
                "put" => new[] { "put", "--file", requestFile },
                "decision.set" => new[] { "decision", "set", "--cwd", frozen.ProjectRoot!, "--file", requestFile },
                "delete" => new[] { "delete", "--file", requestFile },
                _ => new[] { "pending", "drop", "--cwd", frozen.ProjectRoot!, "--file", requestFile }
            };
            var result = await CallAsync(frozen.OperationId, arguments, cancellation,
                mutation: true, requestFile: requestFile);
            var deliveryFailure = result.Code == "response_delivery_failed";
            if (result.Envelope is { } full)
            {
                if (!JsonData.TryBool(full, "ok", out var responseOkay) || responseOkay != result.Success)
                {
                    await PreserveUnverifiedResponseAsync(frozen.JournalDirectory, Encoding.UTF8.GetBytes(full.GetRawText()), cancellation);
                    throw new InvalidDataException("Mutation result flags disagree with its envelope; no response was settled.");
                }
                var recordedFile = deliveryFailure ? Path.Combine(frozen.JournalDirectory,
                    "delivery-error.json") : responseFile;
                CliResult verified;
                try { verified = ValidateMutationResponse(full, frozen, result.ExitCode); }
                catch (InvalidDataException)
                {
                    var invalidBytes = Encoding.UTF8.GetBytes(full.GetRawText());
                    if (File.Exists(recordedFile))
                        await PreserveUnverifiedResponseAsync(frozen.JournalDirectory, invalidBytes, cancellation);
                    else await File.WriteAllBytesAsync(recordedFile, invalidBytes, cancellation);
                    throw;
                }
                if (verified.Code != result.Code)
                    throw new InvalidDataException("Mutation result code disagrees with its verified envelope.");
                if (verified.MayHaveCommitted && verified.FailureCategory == "inconsistent_exit")
                {
                    // The raw envelope cannot preserve the observed process failure across reopen.
                    // Keep both its exact bytes and an identity-bound uncertainty diagnostic.
                    await PreserveUnverifiedResponseAsync(frozen.JournalDirectory,
                        Encoding.UTF8.GetBytes(full.GetRawText()), cancellation);
                    await RetainFirstUncertaintyAsync(frozen, verified, cancellation);
                }
                else if (verified.MayHaveCommitted)
                {
                    var exactResponse = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(full.GetRawText())).ToArray();
                    try { await RetainFirstUncertaintyAsync(frozen, verified, cancellation, exactResponse); }
                    catch (Exception retentionError) when (retentionError is IOException or UnauthorizedAccessException or InvalidDataException)
                    {
                        // A fresh attempt has no older response to protect. Retain its core evidence
                        // without replacing an existing latest response when the first slot fails.
                        if (!ExistingAttributes(recordedFile, out _))
                        {
                            await using var saved = new FileStream(recordedFile, FileMode.CreateNew, FileAccess.Write,
                                FileShare.None, 4096, FileOptions.WriteThrough);
                            await saved.WriteAsync(exactResponse, cancellation);
                            saved.Flush(flushToDisk: true);
                        }
                        throw;
                    }
                }
                var temporary = recordedFile + ".tmp";
                await File.WriteAllTextAsync(temporary, full.GetRawText(), Encoding.UTF8, cancellation);
                File.Move(temporary, recordedFile, overwrite: true);
            }
            else if (result.MayHaveCommitted) await RetainFirstUncertaintyAsync(frozen, result, cancellation);
            if (deliveryFailure)
            {
                if (!result.Success && result.ExitCode == 5 && result.Envelope is { } reported &&
                    TryMatchingDeliveryReport(reported, frozen, out var revision, out var receiptId))
                    return new(false, true, true, frozen.RequestId,
                        "The CLI reports a commit at revision " + revision +
                        (receiptId is null ? ". " : " with receipt " + receiptId + ". ") +
                        "Response delivery failed; verify the receipt in Pending saves before treating the save as settled. The exact request and draft remain available.", result);
                return new(false, true, true, frozen.RequestId,
                    "Response delivery failed. The write outcome needs verification; inspect the exact request in Pending saves.", result);
            }
            var uncertainResult = !result.Success && (priorOutcomeUnknown || result.MayHaveCommitted);
            if (uncertainResult) await RetainUnknownOutcomeAsync(contextFile, cancellation);
            var originalGuidance = priorOutcomeUnknown && !result.MayHaveCommitted && firstUncertainty is not null
                ? " Original unresolved attempt: " + firstUncertainty.Code + ": " + firstUncertainty.Message : "";
            return new(result.Success, uncertainResult,
                uncertainResult, frozen.RequestId, result.Success ? null :
                    (priorOutcomeUnknown ? "A prior write outcome remains unknown; the latest attempt did not settle it. " : "") + result.Message + originalGuidance, result);
        }
        catch (Exception error)
        {
            var uncertain = previouslyPending || dispatchAttempted;
            var requiresRecovery = uncertain || File.Exists(requestFile);
            string? retentionFailure = null;
            if (uncertain && File.Exists(contextFile))
            {
                try { await RetainUnknownOutcomeAsync(contextFile, CancellationToken.None); }
                catch (Exception persistenceError) when (persistenceError is IOException or UnauthorizedAccessException or SecurityException or JsonException or InvalidDataException)
                {
                    // Keep the primary failure; report only bounded scalar cause for journal failure.
                    var cause = persistenceError is JsonException ? nameof(JsonException) : persistenceError.GetType().Name;
                    retentionFailure = " Unknown-outcome retention failed (" + cause + ", HRESULT 0x" +
                        persistenceError.HResult.ToString("X8") + "). Preserve the journal files for inspection.";
                }
            }
            var message = dispatchAttempted ? "Save outcome is uncertain." : previouslyPending ?
                "A prior request outcome is uncertain; this attempt was not sent." : "Save was not sent.";
            if (error is not OperationCanceledException) message += " " + error.Message;
            message += retentionFailure;
            if (requiresRecovery) message += " Inspect the pending request before retrying.";
            return new(false, uncertain, requiresRecovery, frozen.RequestId, message, null);
        }
    }

    private static async Task RetainUnknownOutcomeAsync(string contextFile, CancellationToken cancellation)
    {
        using var document = JsonData.ParseDocument(await File.ReadAllBytesAsync(contextFile, cancellation));
        var context = System.Text.Json.Nodes.JsonNode.Parse(document.RootElement.GetRawText()) as System.Text.Json.Nodes.JsonObject
            ?? throw new InvalidDataException("Saved context is invalid.");
        if (context.TryGetPropertyValue("prior_outcome_unknown", out var marker))
        {
            if (marker is not System.Text.Json.Nodes.JsonValue value || !value.TryGetValue<bool>(out var unknown))
                throw new InvalidDataException("Prior outcome state is invalid.");
            if (unknown) return;
        }
        context["prior_outcome_unknown"] = true;
        var temporary = contextFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.WriteThrough))
            {
                await stream.WriteAsync(JsonSerializer.SerializeToUtf8Bytes(context), cancellation);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, contextFile, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static CliResult? ReadFirstUncertainty(FrozenMutation frozen, bool verifiedUnknownContext = false)
    {
        var path = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
        if (!ExistingAttributes(path, out var attributes)) return null;
        try
        {
            if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                new FileInfo(path).Length > 16 * 1024 * 1024)
                throw new InvalidDataException("The retained response is not a bounded direct local file.");
            using var document = JsonData.ParseDocument(File.ReadAllBytes(path));
            var envelope = document.RootElement;
            if (envelope.ValueKind != JsonValueKind.Object)
                throw new InvalidDataException("The retained response is not a structured object.");
            if (!envelope.TryGetProperty("v", out _) && !envelope.TryGetProperty("error", out _))
            {
                if (!JsonData.TryBool(envelope, "mayHaveCommitted", out var uncertain) || !uncertain ||
                    JsonData.String(envelope, "operation") != frozen.OperationId ||
                    !JsonData.TryString(envelope, "code", out var code) || string.IsNullOrWhiteSpace(code) ||
                    !JsonData.TryString(envelope, "message", out var message) || string.IsNullOrWhiteSpace(message))
                    throw new InvalidDataException("Synthetic uncertainty diagnostic has invalid fields.");
                if (envelope.EnumerateObject().Count() == 4)
                    return new(false, null, "uncertainty_diagnostic_unverified",
                        "Legacy uncertainty diagnostic text is unverified because it has no request/store identity. " +
                        "Its bytes are preserved; the outcome still needs reconciliation. Inspect request.json and context.json " +
                        "for current request '" + frozen.RequestId + "' in store '" + frozen.DatabaseInstanceId +
                        "', epoch '" + frozen.DatabaseEpoch + "'; deliberate exact replay can verify its original receipt.",
                        null, "", 0, true);
                if (envelope.EnumerateObject().Count() != 8 ||
                    JsonData.String(envelope, "request_id") != frozen.RequestId ||
                    JsonData.String(envelope, "database_instance_id") != frozen.DatabaseInstanceId ||
                    JsonData.String(envelope, "database_epoch") != frozen.DatabaseEpoch ||
                    !string.Equals(JsonData.String(envelope, "request_sha256"),
                        Convert.ToHexString(SHA256.HashData(frozen.ExactRequestUtf8)), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Synthetic uncertainty diagnostic identity differs from the frozen request/store.");
                return new(false, null, code, message, null, "", 0, true);
            }
            var verified = ValidateMutationResponse(envelope, frozen);
            if (verified.Success || !verified.MayHaveCommitted)
                throw new InvalidDataException("The retained response does not establish uncertainty.");
            return verified;
        }
        catch (JsonException) when (verifiedUnknownContext)
        {
            // Request bytes, runtime identity and unknown-outcome context were checked independently.
            // Incomplete evidence establishes no result; retain it while the exact receipt reconciles.
            return new(false, null, "uncertainty_evidence_incomplete",
                "First uncertainty evidence at '" + path + "' is incomplete. Its bytes are preserved; " +
                "the original dispatch outcome remains unknown. Deliberate exact replay can reconcile the original receipt.",
                null, "", 0, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            throw new InvalidDataException("First uncertainty evidence cannot be verified at '" + path +
                "'. Preserve this file and the latest response. Inspect request.json and context.json for current frozen request '" +
                frozen.RequestId + "' in store '" + frozen.DatabaseInstanceId + "', epoch '" + frozen.DatabaseEpoch +
                "', and read its original receipt/current state before reconciliation. " + error.Message, error);
        }
    }

    private static async Task RetainFirstUncertaintyAsync(FrozenMutation frozen, CliResult result,
        CancellationToken cancellation, byte[]? exactBytes = null)
    {
        // Callers validate the frozen request/context before retention. Never replace older evidence.
        if (ReadFirstUncertainty(frozen, verifiedUnknownContext: true) is not null) return;
        var path = Path.Combine(frozen.JournalDirectory, "response.uncertainty.json");
        var bytes = exactBytes ?? JsonSerializer.SerializeToUtf8Bytes(new {
            operation = frozen.OperationId, code = result.Code ?? "response_missing", message = result.Message,
            mayHaveCommitted = true, request_id = frozen.RequestId,
            database_instance_id = frozen.DatabaseInstanceId, database_epoch = frozen.DatabaseEpoch,
            request_sha256 = Convert.ToHexString(SHA256.HashData(frozen.ExactRequestUtf8)).ToLowerInvariant()
        });
        if (result.Success || !result.MayHaveCommitted || bytes.Length > 16 * 1024 * 1024)
            throw new InvalidDataException("First uncertainty evidence exceeds the response budget or lacks an unresolved outcome; preserve the latest response and exact request before replay.");
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                await stream.WriteAsync(bytes, cancellation);
                stream.Flush(flushToDisk: true);
            }
            cancellation.ThrowIfCancellationRequested();
            File.Move(temporary, path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new IOException("First uncertainty evidence could not be retained at '" + path +
                "'. Preserve the original response and exact request; inspect storage before replay. " + error.Message, error);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static async Task PreserveUnverifiedResponseAsync(string directory, byte[] bytes, CancellationToken cancellation)
    {
        var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        var snapshot = Path.Combine(directory, "response-unverified-" + hash + ".json");
        if (ExistingAttributes(snapshot, out var attributes))
        {
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 ||
                !File.ReadAllBytes(snapshot).SequenceEqual(bytes))
                throw new InvalidDataException("Unverified response snapshot needs inspection.");
            return;
        }
        await using var stream = new FileStream(snapshot, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            4096, FileOptions.WriteThrough);
        await stream.WriteAsync(bytes, cancellation);
        stream.Flush(flushToDisk: true);
    }

    private static CliResult ValidateMutationResponse(JsonElement envelope, FrozenMutation frozen,
        int? observedExit = null, bool verifyTarget = true)
    {
        var parsed = CliTransport.ParseRecordedMutation(new(frozen.OperationId, [frozen.OperationId],
            frozen.Runtime, TimeSpan.FromSeconds(30), true), envelope, observedExit);
        var unresolvedCoreError = parsed.MayHaveCommitted && parsed.Code != "response_delivery_failed";
        var hasRequest = JsonData.TryObject(envelope, "request", out var request);
        if (parsed.Envelope is null || !JsonData.TryBool(envelope, "more", out var more) || more ||
            (unresolvedCoreError
                ? (envelope.GetProperty("database_instance_id").ValueKind != JsonValueKind.Null &&
                    JsonData.String(envelope, "database_instance_id") != frozen.DatabaseInstanceId) ||
                  (envelope.GetProperty("database_epoch").ValueKind != JsonValueKind.Null &&
                    JsonData.String(envelope, "database_epoch") != frozen.DatabaseEpoch) ||
                  (envelope.TryGetProperty("request", out var reportedRequest) && reportedRequest.ValueKind != JsonValueKind.Null &&
                    (!hasRequest || JsonData.String(request, "id") != frozen.RequestId))
                : JsonData.String(envelope, "database_instance_id") != frozen.DatabaseInstanceId ||
                  JsonData.String(envelope, "database_epoch") != frozen.DatabaseEpoch ||
                  !hasRequest || JsonData.String(request, "id") != frozen.RequestId))
            throw new InvalidDataException("Mutation response protocol or frozen request/store identity cannot be verified.");
        var receipt = "mutation-receipt:" + Convert.ToHexString(SHA256.HashData(
            JsonSerializer.SerializeToUtf8Bytes(new[] { frozen.DatabaseInstanceId, frozen.DatabaseEpoch, frozen.RequestId })))
            .ToLowerInvariant();
        if (parsed.Success)
        {
            if (!JsonData.TryBool(request, "replayed", out _) ||
                !JsonData.TryLong(request, "committed_revision", out var committed) || committed < 1 ||
                !JsonData.TryLong(envelope, "revision", out var revision) || revision != committed ||
                JsonData.String(envelope, "receipt_id") != receipt)
                throw new InvalidDataException("Mutation success receipt or committed revision does not match the frozen request.");
            var data = envelope.GetProperty("data");
            var target = frozen.OperationId switch {
                "put" or "delete" => JsonData.String(data, "id"),
                "pending.drop" when JsonData.TryObject(data, "record", out var record) => JsonData.String(record, "id"),
                "decision.set" when JsonData.TryBool(data, "changed", out var changed) && changed &&
                    JsonData.TryObject(data, "record", out var decision) && JsonData.TryObject(decision, "data", out var content)
                    => JsonData.String(content, "key"),
                "decision.set" when JsonData.TryObject(data, "current", out var current) => JsonData.String(current, "key"),
                _ => null
            };
            if (verifyTarget && target != frozen.RecordId)
                throw new InvalidDataException("Mutation result target differs from the frozen request.");
        }
        else if (JsonData.TryObject(envelope, "error", out var error) &&
            JsonData.TryObject(error, "identifiers", out var identifiers))
        {
            foreach (var (field, expected) in new[] { ("request_id", frozen.RequestId),
                ("database_instance_id", frozen.DatabaseInstanceId), ("database_epoch", frozen.DatabaseEpoch), ("receipt_id", receipt) })
                if (identifiers.TryGetProperty(field, out var identity) &&
                    (identity.ValueKind != JsonValueKind.String || identity.GetString() != expected))
                    throw new InvalidDataException("Mutation error identifiers disagree with its frozen request/store identity.");
        }
        if (parsed.Code == "response_delivery_failed" && !TryMatchingDeliveryReport(envelope, frozen, out _, out _))
            throw new InvalidDataException("Recorded delivery status cannot be verified.");
        return parsed;
    }

    private static bool TryMatchingDeliveryReport(JsonElement envelope, FrozenMutation frozen,
        out long revision, out string? receiptId)
    {
        revision = 0;
        receiptId = null;
        if (!JsonData.TryObject(envelope, "error", out var error) ||
            JsonData.String(error, "code") != "response_delivery_failed" ||
            !JsonData.TryBool(envelope, "ok", out var okay) || okay ||
            JsonData.String(envelope, "operation") != frozen.OperationId ||
            !JsonData.TryObject(error, "identifiers", out var identifiers) ||
            JsonData.String(identifiers, "request_id") != frozen.RequestId ||
            !JsonData.TryObject(envelope, "request", out var request) ||
            JsonData.String(request, "id") != frozen.RequestId ||
            JsonData.String(envelope, "database_instance_id") != frozen.DatabaseInstanceId ||
            JsonData.String(envelope, "database_epoch") != frozen.DatabaseEpoch ||
            JsonData.String(identifiers, "database_instance_id") != frozen.DatabaseInstanceId ||
            JsonData.String(identifiers, "database_epoch") != frozen.DatabaseEpoch ||
            !envelope.TryGetProperty("revision", out var envelopeRevision) ||
            envelopeRevision.ValueKind != JsonValueKind.Number ||
            !envelopeRevision.TryGetInt64(out var topRevision) ||
            !identifiers.TryGetProperty("committed_revision", out var committed) ||
            committed.ValueKind != JsonValueKind.Number ||
            !committed.TryGetInt64(out revision) || revision < 1 ||
            revision > 9_007_199_254_740_991L || revision != topRevision)
            return false;
        receiptId = JsonData.String(identifiers, "receipt_id");
        if (receiptId is not null && (receiptId.Length > 160 || receiptId.Any(char.IsControl)))
            return false;
        if (identifiers.TryGetProperty("receipt_read_args", out var receiptArgs))
        {
            if (receiptId is null || receiptArgs.ValueKind != JsonValueKind.Array ||
                receiptArgs.GetArrayLength() != 4 ||
                receiptArgs.EnumerateArray().Any(value => value.ValueKind != JsonValueKind.String) ||
                receiptArgs[0].GetString() != "--db" ||
                receiptArgs[1].GetString() != frozen.Runtime.DatabasePath ||
                receiptArgs[2].GetString() != "get" ||
                receiptArgs[3].GetString() != receiptId)
                return false;
        }
        return true;
    }

    public async Task<SaveResult> RecoverAsync(string requestId, CancellationToken cancellation = default)
    {
        var shared = _sharedPending.Where(item => item.RequestId == requestId || item.RecoveryKey == requestId).ToArray();
        if (shared.Length > 1) return new(false, true, true, requestId,
            "Several journals share this request ID. Select the specific journal key from recovery list before replay.", null);
        if (shared.Length == 1 && !EnumeratePendingSaves(Directory.EnumerateDirectories).Any(item => item.RequestId == requestId && item.ReplayEligible))
            return await RecoverSharedAsync(shared[0], cancellation);
        var item = PendingSaves().FirstOrDefault(p => p.RequestId == requestId);
        if (item is null) return new(false, false, false, requestId, "No unresolved request with that ID was found.", null);
        if (!item.ReplayEligible)
            return new(false, true, true, requestId,
                "Pending request needs inspection; replay is blocked: " + item.Issue, null);
        try
        {
            using var document = JsonData.ParseDocument(await File.ReadAllBytesAsync(
                Path.Combine(item.JournalDirectory, "context.json"), cancellation));
            var context = document.RootElement;
            if (JsonData.String(context, "generation") != Runtime.Generation ||
                JsonData.String(context, "fingerprint") != Runtime.Fingerprint ||
                JsonData.String(context, "config") != Runtime.ConfigPath ||
                JsonData.String(context, "database") != Runtime.DatabasePath)
                return new(false, false, true, requestId, "Runtime context changed; exact replay is blocked.", null);
            var savedHash = JsonData.String(context, "request_sha256");
            if (savedHash is null || savedHash.Length != 64 || !savedHash.All(Uri.IsHexDigit))
                return new(false, false, true, requestId,
                    "Original request SHA-256 is missing or corrupt; replay is blocked.", null);
            var bytes = await File.ReadAllBytesAsync(Path.Combine(item.JournalDirectory, "request.json"), cancellation);
            if (!string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), savedHash,
                StringComparison.OrdinalIgnoreCase))
                return new(false, false, true, requestId,
                    "Pending request differs from its original SHA-256; replay is blocked.", null);
            var frozen = new FrozenMutation(requestId, item.RecordId, Runtime,
                JsonData.String(context, "database_instance_id") ?? "",
                JsonData.String(context, "database_epoch") ?? "", bytes, item.JournalDirectory,
                JsonData.String(context, "operation") ?? "put", JsonData.String(context, "project_root"),
                JsonData.String(context, "project_id"), JsonData.String(context, "project_scope"));
            return await SaveCoreAsync(frozen, cancellation, reconcileUnverifiedResponse: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            return new(false, false, true, requestId,
                "Pending request context cannot be verified: " + error.Message, null);
        }
    }

    public async ValueTask DisposeAsync() => await _transport.DisposeAsync();
}
