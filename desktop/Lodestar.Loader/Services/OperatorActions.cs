using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Lodestar.Loader;

public sealed partial class LodestarService
{
    private static readonly HashSet<string> OperatorActionNames = new(StringComparer.Ordinal) {
        "project", "note", "research", "research-review", "rejection", "decision", "retire-pending", "retire-record"
    };

    public async Task<EditReview> PrepareOperatorActionAsync(string action,
        IReadOnlyDictionary<string, string> fields, ProjectSummary? project,
        CancellationToken cancellation = default)
    {
        if (!OperatorActionNames.Contains(action))
            return new(null, "", "This operator action is not supported.");
        if (fields is null) return new(null, "", "Action fields are required.");
        fields = new Dictionary<string, string>(fields, StringComparer.Ordinal);
        var selectedRuntime = Runtime;
        try
        {
            var allowed = action switch {
                "project" => new[] { "author", "name", "root" },
                "note" => ["author", "name", "body"],
                "research" => ["author", "name", "source", "body", "claim", "limitations"],
                "research-review" => ["author", "id", "reviewed_at", "review_qualifiers", "source_version", "source_reference", "body_sha256"],
                "rejection" => ["author", "name", "subject", "reason"],
                "decision" => ["author", "key", "value", "reason", "reference", "instruction"],
                _ => new[] { "author", "id", "reason" }
            };
            if (fields.Keys.Any(key => !allowed.Contains(key, StringComparer.Ordinal)))
                throw new InvalidDataException("The action contains an unsupported field.");
            var author = Required(fields, "author");
            if (author != author.Trim() || JsonData.HasInvalidUnicode(author) ||
                author.Any(char.IsControl))
                throw new InvalidDataException("Author must be an exact nonempty operator identifier.");
            // Validate operator attestation before any reads or mutation can be dispatched.
            var reviewFields = action == "research-review" ? ResearchReviewFields(fields, author) : null;

            string? root = null, projectId = null, scope = null;
            CliResult anchor;
            JsonElement baseBasis;
            if (action == "project")
            {
                if (project is not null) throw new InvalidDataException("New project creation has no selected project.");
                var suppliedRoot = Required(fields, "root");
                if (!Path.IsPathFullyQualified(suppliedRoot))
                    throw new InvalidDataException("The project root must be an absolute path.");
                root = Path.GetFullPath(suppliedRoot);
                if (!Directory.Exists(root)) throw new InvalidDataException("The project root does not exist.");
                anchor = await CallAsync("find", ["find", "--all", "--limit", "1"], cancellation);
                baseBasis = default;
            }
            else
            {
                if (project is null) throw new InvalidDataException("Select a project for this action.");
                root = project.Roots.FirstOrDefault(Directory.Exists);
                if (root is null) throw new InvalidDataException("The selected project has no resolving root.");
                anchor = await StartProjectAsync(root, cancellation);
                var start = RequireData(anchor, "Fresh project context");
                if (!JsonData.TryObject(start, "project", out var mapped) ||
                    JsonData.String(mapped, "id") != project.Id ||
                    (scope = JsonData.String(mapped, "scope")) is null ||
                    !project.KnownScopes.Contains(scope))
                    throw new InvalidDataException("The selected root no longer resolves to this project.");
                projectId = project.Id;
                baseBasis = RequireBasis(start, "Fresh project context");
                if (JsonData.String(baseBasis, "project_scope") != scope ||
                    JsonData.String(baseBasis, "checkout") != root)
                    throw new InvalidDataException("The project context has no matching checkout basis.");
            }
            var envelope = RequireEnvelope(anchor, "Fresh action context");
            if (!JsonData.TryLong(envelope, "revision", out var revision) || revision < 0)
                throw new InvalidDataException("The read did not report a store revision.");
            var instance = JsonData.String(envelope, "database_instance_id") ?? "";
            var epoch = JsonData.String(envelope, "database_epoch") ?? "";
            if (string.IsNullOrWhiteSpace(instance) || string.IsNullOrWhiteSpace(epoch))
                throw new InvalidDataException("The read did not identify the selected store.");

            string target, operation;
            JsonNode input;
            JsonElement actionBasis;
            if (action is "project" or "note" or "research" or "rejection")
            {
                target = action + ":" + Guid.NewGuid().ToString("D");
                operation = "put";
                var absent = await CallAsync("get", ["get", target], cancellation);
                if (absent.Success || absent.Code != "record_not_found" || absent.Envelope is null ||
                    !JsonData.TryObject(absent.Envelope.Value, "error", out var error) ||
                    !JsonData.TryObject(error, "identifiers", out var identifiers))
                    throw new InvalidDataException("The new record has no fresh absence basis.");
                actionBasis = RequireBasis(identifiers, "Absent record");
                if (!HasTarget(actionBasis, "record", target, null, expectedAbsent: true))
                    throw new InvalidDataException("The absence basis does not name the new record.");
                input = CreateInput(action, target, scope, fields, root!);
            }
            else if (action == "research-review")
            {
                target = Required(fields, "id"); operation = "put";
                var exact = await CallAsync("get", ["get", "--", target], cancellation);
                var data = RequireData(exact, "Fresh research read");
                CheckReadIdentity(exact, revision, instance, epoch);
                if (JsonData.String(data, "id") != target || JsonData.String(data, "kind") != "research" ||
                    JsonData.String(data, "scope") != scope ||
                    JsonData.TryObject(data, "semantics", out var semantics) &&
                        JsonData.String(semantics, "lifecycle") is "historical" or "superseded")
                    throw new InvalidDataException("The selected record is not current research in this project. Refresh the selected research record.");
                if (!JsonData.TryObject(data, "data", out var source) || string.IsNullOrWhiteSpace(JsonData.String(source, "source_reference")))
                    throw new InvalidDataException("The research record has no saved source reference. Inspect its stored provenance before review.");
                foreach (var field in new[] { "source_reference", "body_sha256" })
                    if (!fields.TryGetValue(field, out var displayed) || displayed != (JsonData.String(source, field) ?? ""))
                        throw new InvalidDataException("The saved source reference or hash changed, or its displayed baseline is missing. Refresh the selected record and inspect the source before reviewing again.");
                actionBasis = RequireBasis(data, "Fresh research read");
                if (!HasTarget(actionBasis, "record", target, null))
                    throw new InvalidDataException("The research read has no exact record basis. Refresh before review.");
                input = new JsonObject { ["mode"] = "update", ["id"] = target,
                    ["set"] = new JsonObject { ["data"] = reviewFields }, ["remove"] = new JsonArray() };
            }
            else if (action == "retire-record")
            {
                target = Required(fields, "id"); operation = "delete";
                var snapshot = await GetRecordAsync(target, cancellation);
                if (!RecordEditor.CanEdit(snapshot, out var reason) || snapshot.Record?.Kind == "project" ||
                    snapshot.Record?.Scope != scope)
                    throw new InvalidDataException("Select a current ordinary record owned by this project. " + reason);
                if (snapshot.Revision != revision || snapshot.DatabaseInstanceId != instance || snapshot.DatabaseEpoch != epoch)
                    throw new InvalidDataException("The retirement target changed; refresh it before review.");
                actionBasis = snapshot.WriteBasis ?? throw new InvalidDataException("The retirement read has no basis.");
                if (!HasTarget(actionBasis, "record", target, null)) throw new InvalidDataException("Retirement requires an exact current record basis.");
                input = new JsonObject { ["id"] = target, ["reason"] = Required(fields, "reason") };
            }
            else if (action == "decision")
            {
                target = Required(fields, "key");
                if (target != target.Trim() || target.Any(char.IsControl))
                    throw new InvalidDataException("Decision key must preserve exact text without boundary whitespace.");
                operation = "decision.set";
                var shown = await CallAsync("decision.show", ["decision", "show", "--cwd", root!,
                    "--at-revision", revision.ToString(System.Globalization.CultureInfo.InvariantCulture), "--", target], cancellation);
                var data = RequireData(shown, "Decision read");
                CheckReadIdentity(shown, revision, instance, epoch);
                if (!JsonData.TryBool(data, "complete", out var complete) || !complete)
                    throw new InvalidDataException("The decision read is incomplete.");
                actionBasis = RequireBasis(data, "Decision read");
                if (!HasTarget(actionBasis, "decision", target, scope))
                    throw new InvalidDataException("The decision read did not return the exact key basis.");
                input = new JsonObject { ["key"] = target, ["value"] = Required(fields, "value"),
                    ["reason"] = Required(fields, "reason"), ["status"] = "accepted",
                    ["direction"] = new JsonObject { ["kind"] = "user", ["attribution"] = "asserted",
                        ["reference"] = Required(fields, "reference"),
                        ["instruction"] = Required(fields, "instruction") } };
            }
            else
            {
                target = Required(fields, "id");
                operation = "pending.drop";
                var listed = await CallAsync("pending.list", ["pending", "list", "--cwd", root!,
                    "--at-revision", revision.ToString(System.Globalization.CultureInfo.InvariantCulture)], cancellation);
                var data = RequireData(listed, "Pending read");
                CheckReadIdentity(listed, revision, instance, epoch);
                if (!JsonData.TryBool(data, "complete", out var complete) || !complete ||
                    !JsonData.TryArray(data, "records", out var records) ||
                    !records.EnumerateArray().Any(row => JsonData.String(row, "id") == target))
                    throw new InvalidDataException("The pending item is not in a complete current project list.");
                actionBasis = RequireBasis(data, "Pending read");
                var exact = await CallAsync("get", ["get", target], cancellation);
                var exactData = RequireData(exact, "Pending item");
                if (JsonData.String(exactData, "id") != target || JsonData.String(exactData, "kind") != "pending")
                    throw new InvalidDataException("The selected item is not an exact pending record.");
                CheckReadIdentity(exact, revision, instance, epoch);
                var itemBasis = RequireBasis(exactData, "Pending item");
                actionBasis = CombineBasis(actionBasis, itemBasis);
                if (!HasTarget(actionBasis, "record", target, null))
                    throw new InvalidDataException("The pending item has no exact record basis.");
                input = new JsonObject { ["id"] = target, ["reason"] = Required(fields, "reason") };
            }

            var pinned = await CallAsync("find", ["find", "--all", "--limit", "1", "--at-revision",
                revision.ToString(System.Globalization.CultureInfo.InvariantCulture)], cancellation);
            CheckReadIdentity(pinned, revision, instance, epoch);
            if (!Runtime.Equals(selectedRuntime))
                throw new InvalidDataException("The selected runtime changed during action preparation.");
            var targets = baseBasis.ValueKind == JsonValueKind.Object
                ? CombineBasis(baseBasis, actionBasis) : actionBasis;
            CheckBasisIdentity(targets, instance, epoch);
            var requestId = "ll-" + Guid.NewGuid().ToString("D");
            var request = CanonicalRequest(requestId, instance, epoch, scope, action == "project" ? null : root,
                author, targets, input);
            var bytes = JsonSerializer.SerializeToUtf8Bytes(request);
            var frozen = new FrozenMutation(requestId, target, selectedRuntime, instance, epoch, bytes,
                Path.Combine(_journalRoot, requestId), operation,
                action == "project" ? null : root, projectId, scope);
            var subject = action switch {
                "decision" => "Value: " + Required(fields, "value") + Environment.NewLine +
                    "Reason: " + Required(fields, "reason"),
                "retire-pending" or "retire-record" => "Reason: " + Required(fields, "reason"),
                "rejection" => "Subject: " + Required(fields, "subject") + Environment.NewLine +
                    "Reason: " + Required(fields, "reason"),
                "research" => "Source reference: " + Required(fields, "source") + Environment.NewLine +
                    "Claim: " + Required(fields, "claim"),
                "research-review" => "Source review: operator attestation" + Environment.NewLine +
                    "Observed on: " + Required(fields, "reviewed_at") + Environment.NewLine +
                    "Qualifiers: " + Required(fields, "review_qualifiers") + Environment.NewLine +
                    "Stored source reference, content and hash are preserved; no external source was fetched.",
                _ => "Name: " + Required(fields, "name")
            };
            var summary = action + " · " + target + Environment.NewLine +
                subject + Environment.NewLine + "Operator: " + author + Environment.NewLine +
                "Store: " + selectedRuntime.DatabasePath +
                (root is null ? "" : Environment.NewLine + "Root: " + root);
            return new(frozen, summary, null);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception error) { return new(null, "", action + " preparation failed. No write was dispatched by this attempt. " + error.Message + " Correct the fields or refresh the selected project before Review change."); }
    }

    private static JsonObject ResearchReviewFields(IReadOnlyDictionary<string, string> fields, string author)
    {
        var date = Required(fields, "reviewed_at").Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(date, @"^[0-9]{4}-[0-9]{2}-[0-9]{2}$") || !ActualReviewDate(date))
            throw new InvalidDataException("Source observation date must be an actual calendar date in YYYY-MM-DD form.");
        var version = fields.TryGetValue("source_version", out var supplied) && supplied.Length > 0
            ? Required(fields, "source_version").Trim() : null;
        if (version is not null && (version.Length == 0 || version.Any(char.IsControl)))
            throw new InvalidDataException("Applicable source version must be supplied as plain text or left empty.");
        return new JsonObject { ["reviewed_at"] = date, ["reviewed_by"] = author,
            ["review_qualifiers"] = Required(fields, "review_qualifiers"), ["source_version"] = version,
            ["review_acquisition"] = "operator_attested" };
    }

    private static bool ActualReviewDate(string date)
    {
        // The shared JavaScript contract accepts the proleptic Gregorian year 0000.
        var year = int.Parse(date.AsSpan(0, 4), System.Globalization.CultureInfo.InvariantCulture);
        var month = int.Parse(date.AsSpan(5, 2), System.Globalization.CultureInfo.InvariantCulture);
        var day = int.Parse(date.AsSpan(8, 2), System.Globalization.CultureInfo.InvariantCulture);
        if (month is < 1 or > 12 || day < 1) return false;
        var leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        var days = month switch { 2 => leap ? 29 : 28, 4 or 6 or 9 or 11 => 30, _ => 31 };
        return day <= days;
    }

    private static string Required(IReadOnlyDictionary<string, string> fields, string key) =>
        fields.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) &&
        !JsonData.HasInvalidUnicode(value) && !value.Any(ch => ch == '\0' || ch == '\u007f')
            ? value : throw new InvalidDataException(key + " is required as valid text.");

    private static JsonElement RequireEnvelope(CliResult result, string label) =>
        result.Success && result.Envelope is { ValueKind: JsonValueKind.Object } envelope
            ? envelope : throw new InvalidDataException(label + " failed: " + result.Message);

    private static JsonElement RequireData(CliResult result, string label)
    {
        var envelope = RequireEnvelope(result, label);
        return JsonData.TryObject(envelope, "data", out var data) ? data :
            throw new InvalidDataException(label + " returned no data.");
    }

    private static JsonElement RequireBasis(JsonElement source, string label) =>
        JsonData.TryObject(source, "write_basis", out var basis) &&
        JsonData.TryArray(basis, "targets", out _) ? basis :
            throw new InvalidDataException(label + " returned no write basis.");

    private static void CheckReadIdentity(CliResult result, long revision, string instance, string epoch)
    {
        var envelope = RequireEnvelope(result, "Pinned read");
        if (!JsonData.TryLong(envelope, "revision", out var actual) || actual != revision ||
            JsonData.String(envelope, "database_instance_id") != instance ||
            JsonData.String(envelope, "database_epoch") != epoch)
            throw new InvalidDataException("Public reads crossed a store revision or identity.");
    }

    private static void CheckBasisIdentity(JsonElement basis, string instance, string epoch)
    {
        if (JsonData.String(basis, "database_instance_id") != instance ||
            JsonData.String(basis, "database_epoch") != epoch)
            throw new InvalidDataException("Write bases identify different stores.");
    }

    private static bool HasTarget(JsonElement basis, string kind, string id, string? scope,
        bool expectedAbsent = false) => JsonData.TryArray(basis, "targets", out var targets) &&
        targets.EnumerateArray().Any(target => JsonData.String(target, "kind") == kind &&
            (kind == "record" ? JsonData.String(target, "id") == id :
                JsonData.String(target, "key") == id && JsonData.String(target, "scope") == scope) &&
            (!expectedAbsent || JsonData.Property(target, "expected_revision")?.ValueKind == JsonValueKind.Null));

    private static JsonElement CombineBasis(JsonElement left, JsonElement right)
    {
        CheckBasisIdentity(right, JsonData.String(left, "database_instance_id") ?? "",
            JsonData.String(left, "database_epoch") ?? "");
        var node = JsonNode.Parse(left.GetRawText())!.AsObject();
        var leftTargets = node["targets"]!.AsArray();
        if (!JsonData.TryArray(right, "targets", out var rightTargets))
            throw new InvalidDataException("A read returned no write-basis targets.");
        foreach (var target in rightTargets.EnumerateArray())
        {
            var key = TargetKey(target);
            var existing = leftTargets.FirstOrDefault(item => item is not null && TargetKey(JsonSerializer.SerializeToElement(item)) == key);
            if (existing is null) leftTargets.Add(JsonNode.Parse(target.GetRawText()));
            else if (!JsonNode.DeepEquals(existing, JsonNode.Parse(target.GetRawText())))
                throw new InvalidDataException("Returned bases disagree about a target revision.");
        }
        return JsonSerializer.SerializeToElement(node);
    }

    private static string TargetKey(JsonElement target) => JsonData.String(target, "kind") switch {
        "record" => "record:" + JsonData.String(target, "id"),
        "decision" => "decision:" + JsonData.String(target, "scope") + ":" + JsonData.String(target, "key"),
        _ => throw new InvalidDataException("A public basis returned an unsupported target.")
    };

    private static JsonObject CanonicalRequest(string requestId, string instance, string epoch,
        string? scope, string? checkout, string author, JsonElement basis, JsonNode input)
    {
        var preconditions = new JsonArray();
        foreach (var item in basis.GetProperty("targets").EnumerateArray())
        {
            var target = JsonNode.Parse(item.GetRawText())!.AsObject();
            var revision = target["expected_revision"]?.DeepClone();
            target.Remove("expected_revision");
            preconditions.Add(new JsonObject { ["target"] = target, ["expected_revision"] = revision });
        }
        return new JsonObject { ["v"] = 5, ["request_id"] = requestId,
            ["database_instance_id"] = instance, ["database_epoch"] = epoch,
            ["project_scope"] = scope, ["checkout"] = checkout,
            ["actor"] = new JsonObject { ["id"] = "user:" + author, ["agent"] = "human",
                ["harness"] = "loader", ["session"] = null },
            ["preconditions"] = preconditions, ["input"] = input };
    }

    private static JsonNode CreateInput(string action, string id, string? scope,
        IReadOnlyDictionary<string, string> fields, string root)
    {
        var data = new JsonObject();
        switch (action)
        {
            case "project":
                data["roots"] = new JsonArray(root);
                data["status"] = "active";
                break;
            case "note": data["body"] = Required(fields, "body"); break;
            case "research":
                var body = Required(fields, "body");
                data["body"] = body;
                data["body_sha256"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body))).ToLowerInvariant();
                data["source_reference"] = Required(fields, "source");
                data["claim"] = Required(fields, "claim");
                data["limitations"] = Required(fields, "limitations");
                data["acquisition"] = "operator_supplied";
                break;
            case "rejection":
                data["subject"] = Required(fields, "subject");
                data["reason"] = Required(fields, "reason");
                data["verdict"] = "rejected";
                break;
        }
        var project = action == "project" ? id : scope;
        var record = new JsonObject { ["id"] = id, ["kind"] = action,
            ["name"] = Required(fields, "name"), ["scope"] = action == "project" ? "global" : scope,
            ["availability"] = "known", ["data"] = data,
            ["aliases"] = new JsonArray(), ["links"] = new JsonArray(), ["sources"] = new JsonArray(),
            ["semantics"] = new JsonObject { ["lifecycle"] = "current", ["context_role"] = "orientation",
                ["basis"] = "asserted", ["applicability"] = new JsonObject {
                    ["project"] = project, ["checkout"] = null } } };
        return new JsonObject { ["mode"] = "create", ["record"] = record };
    }

    private static string DispatchHash(string operation, string? root, string requestHash) =>
        Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new {
            operation, cwd = root, request_sha256 = requestHash
        }))).ToLowerInvariant();

    private static bool MatchesFrozenRequest(JsonElement request, string requestId, string target,
        string operation, string? root, string? scope)
    {
        if (JsonData.String(request, "request_id") != requestId ||
            !JsonData.TryObject(request, "input", out var input)) return false;
        var bodyTarget = operation switch {
            "put" when JsonData.String(input, "mode") is "create" or "replace" &&
                JsonData.TryObject(input, "record", out var record) => JsonData.String(record, "id"),
            "put" when JsonData.String(input, "mode") == "update" => JsonData.String(input, "id"),
            "decision.set" => JsonData.String(input, "key"),
            "pending.drop" or "delete" => JsonData.String(input, "id"),
            _ => null
        };
        if (bodyTarget != target) return false;
        if (root is null) return true;
        return JsonData.String(request, "project_scope") == scope &&
            JsonData.String(request, "checkout") == root &&
            JsonData.TryObject(request, "actor", out var actor) &&
            (JsonData.String(actor, "id")?.StartsWith("user:", StringComparison.Ordinal) == true) &&
            JsonData.String(actor, "agent") == "human" &&
            JsonData.String(actor, "harness") == "loader";
    }
}
