using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lodestar.Loader;

public sealed partial class LodestarService
{
    public bool SupportsOperatorRead(string operation)
    {
        if (operation is not ("work.prepare-capture" or "work.attention") || Capabilities?.Version != 1) return false;
        var descriptor = Capabilities.Operations.FirstOrDefault(item => item.Id == operation);
        return descriptor is { Effect: "read" } && descriptor.Argv.SequenceEqual(operation.Split('.')) &&
            JsonData.TryObject(descriptor.Description, "context", out var context) &&
            JsonData.TryBool(context, "project", out var project) && project &&
            JsonData.TryBool(context, "actor", out var actor) && !actor &&
            JsonData.TryArray(descriptor.Description, "parameters", out var parameters) &&
            parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "cwd" && JsonData.String(parameter, "binding") == "option" && JsonData.String(parameter, "flag") == "--cwd") &&
            (operation != "work.prepare-capture" || JsonData.TryObject(descriptor.Description, "draft_schema", out var schema) &&
                JsonData.TryArray(schema, "oneOf", out var variants) && variants.GetArrayLength() == 2 &&
                parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "file" && JsonData.String(parameter, "binding") == "option" && JsonData.String(parameter, "flag") == "--file") &&
                variants.EnumerateArray().All(variant => JsonData.TryObject(variant, "properties", out var properties) &&
                    JsonData.TryObject(properties, "version", out var version) && JsonData.TryInt(version, "const", out var value) && value == 1));
    }

    public async Task<EditReview> PrepareCaptureAsync(ProjectSummary project, JsonElement draft,
        CancellationToken cancellation = default)
    {
        if (!SupportsOperatorRead("work.prepare-capture")) return new(null, "", "Selected core does not support this action.");
        var runtime = Runtime; string? file = null;
        try {
            if (!JsonData.TryInt(draft, "version", out var version) || version != 1 ||
                JsonData.String(draft, "stage") is not ("create" or "associate") ||
                JsonData.String(draft, "intent_record_id") is not { Length: > 0 } intent)
                throw new InvalidDataException("Select an exact intent and version-1 capture draft.");
            var author = JsonData.String(draft, "author");
            if (string.IsNullOrWhiteSpace(author) || author != author.Trim() || author.Any(char.IsControl) || JsonData.HasInvalidUnicode(author))
                throw new InvalidDataException("Recorded by must be an exact nonempty operator identity.");
            var mapping = await ValidateProjectContextAsync(project, cancellation);
            if (!mapping.Matched || mapping.Root is null || mapping.CanonicalScope is null)
                throw new InvalidDataException(mapping.Error ?? "Selected project root no longer matches.");
            file = Path.Combine(Path.GetTempPath(), "lodestar-capture-" + Guid.NewGuid().ToString("N") + ".json");
            await File.WriteAllBytesAsync(file, JsonSerializer.SerializeToUtf8Bytes(draft), cancellation);
            var result = await CallAsync("work.prepare-capture", ["work", "prepare-capture", "--cwd", mapping.Root, "--file", file], cancellation);
            if (!result.Success) {
                var identifiers = result.Envelope is { } rejected && JsonData.TryObject(rejected,"error",out var error) && JsonData.TryObject(error,"identifiers",out var named)
                    ? "\nNamed fields / reads: " + JsonData.Pretty(named) : "";
                return new(null,"", "Capture preparation failed. No write was dispatched. " + result.Code + ": " + result.Message +
                    "\n" + result.Action + identifiers);
            }
            var envelope = RequireEnvelope(result, "Capture preparation"); var data = RequireData(result, "Capture preparation");
            var stage = JsonData.String(draft, "stage");
            var recordId = stage == "create" && JsonData.TryObject(draft, "record", out var record)
                ? JsonData.String(record, "id") : JsonData.String(draft, "record_id");
            if (Runtime != runtime || JsonData.String(envelope, "operation") != "work.prepare-capture" ||
                !JsonData.TryInt(data, "version", out var observed) || observed != 1 ||
                JsonData.String(data, "stage") != stage || JsonData.String(data, "intent_record_id") != intent ||
                JsonData.String(data, "record_id") != recordId || string.IsNullOrWhiteSpace(recordId) ||
                JsonData.String(data, "operation") != "put" || !JsonData.TryObject(data, "review", out var review) ||
                !JsonData.TryBool(review, "noop", out var noop) || !JsonData.TryArray(review, "changes", out var changes) ||
                changes.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String) ||
                JsonData.String(review, "summary") is not { Length: > 0 } summary ||
                JsonData.String(review, "intent_sha256") is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit) ||
                !JsonData.TryLong(review, "intent_revision", out var intentRevision) || intentRevision < 0 ||
                !JsonData.TryArray(data, "read_after", out var reads) || reads.EnumerateArray().Any(row =>
                    row.ValueKind != JsonValueKind.Array || row.EnumerateArray().Any(token => token.ValueKind != JsonValueKind.String)))
                throw new InvalidDataException("Malformed or obsolete preparation response; refresh the selected intent before review.");
            var instance = JsonData.String(envelope, "database_instance_id"); var epoch = JsonData.String(envelope, "database_epoch");
            if (string.IsNullOrWhiteSpace(instance) || string.IsNullOrWhiteSpace(epoch) ||
                !JsonData.TryLong(envelope, "revision", out var revision) || revision < 0)
                throw new InvalidDataException("Preparation omitted observed database identity/revision.");
            var basis = RequireBasis(data, "Capture preparation"); CheckBasisIdentity(basis, instance, epoch);
            ValidatePreparedBasis(basis);
            if (JsonData.String(basis, "project_scope") != mapping.CanonicalScope || JsonData.String(basis, "checkout") != mapping.Root ||
                !HasTarget(basis, "record", intent, null) || !HasTarget(basis, "record", recordId, null, stage == "create"))
                throw new InvalidDataException("Preparation basis does not cover the exact project, intent and record.");
            var intentTarget = basis.GetProperty("targets").EnumerateArray().First(target => JsonData.String(target,"kind") == "record" && JsonData.String(target,"id") == intent);
            var recordTarget = basis.GetProperty("targets").EnumerateArray().First(target => JsonData.String(target,"kind") == "record" && JsonData.String(target,"id") == recordId);
            if (!JsonData.TryLong(intentTarget,"expected_revision",out var expectedIntent) || expectedIntent != intentRevision ||
                stage == "create" && JsonData.Property(review,"record_revision") is not { ValueKind: JsonValueKind.Null } ||
                stage == "associate" && (!JsonData.TryLong(review,"record_revision",out var observedRecord) ||
                    !JsonData.TryLong(recordTarget,"expected_revision",out var expectedRecord) || observedRecord != expectedRecord))
                throw new InvalidDataException("Preparation review revisions disagree with its exact write basis.");
            if (reads.EnumerateArray().Any(row => AttentionReadOperation(row.EnumerateArray().Select(token => token.GetString()!).ToImmutableArray(), mapping.Root, project.KnownScopes) is null))
                throw new InvalidDataException("Preparation returned unsupported follow-up arguments.");
            if (noop) {
                if (JsonData.Property(data, "input") is not { ValueKind: JsonValueKind.Null }) throw new InvalidDataException("No-op preparation has a mutation input.");
                return new(null, "Already linked · " + summary, null);
            }
            if (!JsonData.TryObject(data, "input", out var input) ||
                stage == "create" && (JsonData.String(input, "mode") != "create" || !JsonData.TryObject(input, "record", out var created) || JsonData.String(created, "id") != recordId) ||
                stage == "associate" && (JsonData.String(input, "mode") != "update" || JsonData.String(input, "id") != intent ||
                    !JsonData.TryObject(input, "set", out _) || !JsonData.TryArray(input, "remove", out var remove) || remove.GetArrayLength() != 0))
                throw new InvalidDataException("Malformed prepared put input; no request was frozen.");
            if (stage == "associate" && (!JsonData.TryObject(input.GetProperty("set"), "data", out var changed) ||
                input.GetProperty("set").EnumerateObject().Any(property => property.Name != "data") ||
                changed.EnumerateObject().Any(property => property.Name is not ("continuation" or "acceptance"))))
                throw new InvalidDataException("Association response changes fields outside context/acceptance.");
            if (stage == "create") {
                var preparedRecord = input.GetProperty("record");
                var expectedKind = JsonData.String(draft.GetProperty("record"),"type") == "research" ? "research" : "knowledge";
                if (JsonData.String(preparedRecord,"kind") != expectedKind || JsonData.String(preparedRecord,"scope") != mapping.CanonicalScope ||
                    !JsonData.TryObject(preparedRecord,"semantics",out var semantics) || JsonData.String(semantics,"context_role") != "on_demand" ||
                    !JsonData.TryObject(semantics,"applicability",out var applicability) || JsonData.String(applicability,"project") != project.Id ||
                    JsonData.String(applicability,"checkout") != mapping.Root)
                    throw new InvalidDataException("Prepared creation does not preserve the ordinary captured kind and exact project/checkout applicability.");
            }
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var request = CanonicalRequest(requestId, instance, epoch, mapping.CanonicalScope, mapping.Root, author,
                basis, JsonNode.Parse(input.GetRawText())!);
            var frozen = new FrozenMutation(requestId, stage == "create" ? recordId : intent, runtime, instance, epoch,
                JsonSerializer.SerializeToUtf8Bytes(request), Path.Combine(_journalRoot, requestId), "put", mapping.Root, project.Id, mapping.CanonicalScope);
            return new(frozen, summary + "\nStage: " + stage + " · record " + recordId + "\nIntent: " + intent +
                "\nIntent SHA-256: " + hash + "\nDatabase revision: " + revision + "\nChanges: " + string.Join(", ", changes.EnumerateArray().Select(item => item.GetString())), null);
        } catch (OperationCanceledException) { throw; }
        catch (Exception error) { return new(null, "", "Capture preparation failed. No write was dispatched. " + error.Message); }
        finally { if (file is not null && File.Exists(file)) File.Delete(file); }
    }

    public async Task<CliResult> ReadAttentionAsync(ProjectSummary project, string? intentRecordId = null,
        CancellationToken cancellation = default)
    {
        static CliResult Rejected(string message) => new(false, null, "unsupported_attention", message, null, "", 0);
        if (!SupportsOperatorRead("work.attention")) return Rejected("Selected core does not support this action.");
        var runtime = Runtime; var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (!mapping.Matched || mapping.Root is null) return Rejected(mapping.Error ?? "Project root no longer matches.");
        var args = new List<string> { "work", "attention", "--cwd", mapping.Root };
        if (!string.IsNullOrWhiteSpace(intentRecordId)) { args.Add("--"); args.Add(intentRecordId); }
        var result = await CallAsync("work.attention", args, cancellation);
        if (!result.Success) return result;
        if (Runtime != runtime || result.Envelope is not { } envelope || JsonData.String(envelope, "operation") != "work.attention" ||
            !JsonData.TryLong(envelope, "revision", out var revision) || revision < 0 ||
            string.IsNullOrWhiteSpace(JsonData.String(envelope, "database_instance_id")) || string.IsNullOrWhiteSpace(JsonData.String(envelope, "database_epoch")) ||
            !JsonData.TryObject(envelope, "data", out var data) || !JsonData.TryInt(data, "version", out var version) || version != 1 ||
            !JsonData.TryObject(data, "project", out var observed) || JsonData.String(observed, "id") != project.Id ||
            JsonData.String(data, "selected_intent_id") != (string.IsNullOrWhiteSpace(intentRecordId) ? null : intentRecordId) ||
            !JsonData.TryArray(data, "intents", out _) || !JsonData.TryBool(data, "complete", out _) ||
            !JsonData.TryArray(data, "read_required", out _) || !JsonData.TryObject(data, "sections", out var sections) ||
            new[] { "work", "pending", "acceptance", "context" }.Any(name => !JsonData.TryObject(sections, name, out var section) ||
                JsonData.String(section, "state") is not ("observed" or "partial" or "unavailable" or "not_selected") ||
                !JsonData.TryBool(section, "complete", out _) || !JsonData.TryBool(section, "more", out _) ||
                !JsonData.TryArray(section, "items", out _) || !JsonData.TryArray(section, "issues", out _) || !JsonData.TryArray(section, "read_args", out _)))
            return Rejected("Malformed or obsolete attention response. Refresh the selected project.");
        return result;
    }

    public async Task<CliResult> ReadAttentionFollowUpAsync(ProjectSummary project, ImmutableArray<string> arguments,
        CancellationToken cancellation = default)
    {
        var runtime = Runtime; var mapping = await ValidateProjectContextAsync(project, cancellation);
        if (Runtime != runtime || !mapping.Matched || mapping.Root is null || mapping.CanonicalScope is null)
            return new(false, null, "project_context_mismatch", "Runtime or project changed. Refresh attention.", null, "", 0);
        // Catalog membership is narrower than the fresh migration mapping. Only
        // this verified project read can admit historical inventory scopes.
        var scopes = mapping.HistoricalScopes.Prepend(mapping.CanonicalScope).Distinct(StringComparer.Ordinal);
        if (AttentionReadOperation(arguments, mapping.Root, scopes) is not { } operation)
            return new(false, null, "unsupported_attention_read", "This attention read is not allowlisted for the verified current and historical scopes. No follow-up command was dispatched.", null, "", 0);
        return await CallAsync(operation, arguments, cancellation);
    }

    internal static string? AttentionReadOperation(ImmutableArray<string> args, string? root, IEnumerable<string>? scopes = null)
    {
        if (args.IsDefaultOrEmpty || args.Any(token => token.Contains('\0') || JsonData.HasInvalidUnicode(token))) return null;
        if (IntentContinuityReadout.ReadOperation(args, root) is { } existing) return existing;
        if (args.Length == 6 && args[0] == "find" && args[1] == "--all" && args[2] == "--scope" &&
            scopes?.Contains(args[3], StringComparer.Ordinal) == true && args[4] == "--kind" && args[5] == "knowledge") return "find";
        if (args.Length == 4 && args[2] == "--cwd" && args[3] == root &&
            (args[0] == "work" && args[1] == "status" || args[0] == "pending" && args[1] == "list" || args[0] == "decision" && args[1] == "show"))
            return args[0] + "." + args[1];
        if (args.Length == 6 && args[0] == "work" && args[1] == "check" && args[2] == "--cwd" && args[3] == root && args[4] == "--" && args[5].Length > 0)
            return "work.check";
        return null;
    }

    private static void ValidatePreparedBasis(JsonElement basis)
    {
        var targets = basis.GetProperty("targets"); var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var target in targets.EnumerateArray()) {
            if (target.ValueKind != JsonValueKind.Object || JsonData.String(target, "kind") is not ("record" or "decision") ||
                !target.TryGetProperty("expected_revision", out var revision) || revision.ValueKind != JsonValueKind.Null &&
                    (!revision.TryGetInt64(out var number) || number < 0 || number > 9007199254740991) ||
                JsonData.String(target, JsonData.String(target, "kind") == "record" ? "id" : "key") is not { Length: > 0 } ||
                !keys.Add(TargetKey(target))) throw new InvalidDataException("Preparation returned malformed or duplicate basis targets.");
        }
    }
}
