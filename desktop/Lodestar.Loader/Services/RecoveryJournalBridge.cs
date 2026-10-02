using System.Text.Json;
using System.Security.Cryptography;

namespace Lodestar.Loader;

public sealed partial class LodestarService
{
    private IReadOnlyList<PendingSave> _sharedPending = [];
    private string? _sharedRecoveryError;
    private Dictionary<string, (string Context, string Request)> _sharedSettled = new(StringComparer.OrdinalIgnoreCase);

    // Refresh belongs to explicit discovery/library refresh, never a polling loop.
    private async Task RefreshSharedRecoveryAsync(CancellationToken cancellation)
    {
        if (Capabilities?.Operations.Any(operation => operation.Id == "recovery.list") != true) return;
        var result = await CallAsync("recovery.list", ["recovery", "list", "--interface-config", Runtime.ConfigPath], cancellation);
        try
        {
            if (!result.Success || result.Envelope is not { } envelope ||
                !JsonData.TryObject(envelope, "data", out var data) ||
                !JsonData.TryArray(data, "journals", out var rows) ||
                !JsonData.TryBool(data, "complete", out var complete))
                throw new InvalidDataException(result.Message);
            var items = new List<PendingSave>();
            foreach (var row in rows.EnumerateArray())
            {
                var key = JsonData.String(row, "key");
                var id = JsonData.String(row, "request_id");
                var folder = JsonData.String(row, "folder");
                if (key is null || key.Length != 64 || !key.All(Uri.IsHexDigit) ||
                    string.IsNullOrEmpty(id) || string.IsNullOrEmpty(folder) || !Path.IsPathFullyQualified(folder) ||
                    !JsonData.TryBool(row, "replay_eligible", out var eligible))
                    throw new InvalidDataException("Shared recovery returned an invalid journal descriptor.");
                DateTimeOffset.TryParse(JsonData.String(row, "created_at"), out var created);
                items.Add(new(id, JsonData.String(row, "record_id") ?? "", JsonData.String(row, "database") ?? "",
                    created, folder, eligible,
                    (JsonData.String(row, "issue") ?? "") + " Action: " + JsonData.String(row, "action"),
                    JsonData.String(row, "operation") ?? "unknown", RecoveryKey: key));
            }
            var settled = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase);
            if (JsonData.TryArray(data, "settled_journals", out var completed))
                foreach (var item in completed.EnumerateArray())
                {
                    var folder = JsonData.String(item, "folder");
                    var context = JsonData.String(item, "context_sha256");
                    var request = JsonData.String(item, "request_sha256");
                    if (folder is null || !Path.IsPathFullyQualified(folder) || context?.Length != 64 || request?.Length != 64 ||
                        !context.All(Uri.IsHexDigit) || !request.All(Uri.IsHexDigit))
                        throw new InvalidDataException("Shared recovery returned an invalid settled descriptor.");
                    settled[folder] = (context, request);
                }
            _sharedSettled = settled;
            _sharedPending = items;
            _sharedRecoveryError = complete ? null :
                "Shared recovery inspection is incomplete. Run recovery list with this interface config; preserve all journals and correct the reported storage access before replay.";
        }
        catch (Exception error) when (error is InvalidDataException or JsonException)
        {
            _sharedRecoveryError = "Shared recovery could not refresh; the last listing is retained. " + error.Message +
                " Action: Use recovery list --interface-config with the selected configuration and restore readable local storage before replay.";
        }
    }

    private IReadOnlyList<PendingSave> MergeSharedRecovery(IReadOnlyList<PendingSave> local)
    {
        var result = local.Where(item => !HasMatchingSettledSnapshot(item.JournalDirectory))
            .ToDictionary(item => Path.GetFullPath(item.JournalDirectory), StringComparer.OrdinalIgnoreCase);
        foreach (var item in _sharedPending)
        {
            // Keep the existing native validator/replay for its own valid journals.
            // A Manager descriptor can replace a local format-mismatch descriptor.
            var key = Path.GetFullPath(item.JournalDirectory);
            if (!result.TryGetValue(key, out var own) || !own.ReplayEligible) result[key] = item;
        }
        return result.Values.OrderBy(item => item.JournalDirectory, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private bool HasMatchingSettledSnapshot(string folder)
    {
        if (!_sharedSettled.TryGetValue(folder, out var proof)) return false;
        try
        {
            if ((File.GetAttributes(folder) & FileAttributes.ReparsePoint) != 0) return false;
            foreach (var (name, expected) in new[] { ("context.json", proof.Context), ("request.json", proof.Request) })
            {
                var file = Path.Combine(folder, name);
                if ((File.GetAttributes(file) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0 ||
                    new FileInfo(file).Length > 16 * 1024 * 1024 ||
                    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file))).ToLowerInvariant() != expected) return false;
            }
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
    }

    private async Task<SaveResult> RecoverSharedAsync(PendingSave item, CancellationToken cancellation)
    {
        try
        {
            if (!item.ReplayEligible || item.RecoveryKey is null)
                return new(false, true, true, item.RequestId, "Replay is blocked. " + item.Issue, null);
            var requestFile = Path.Combine(item.JournalDirectory, "request.json");
            using var contextDocument = JsonData.ParseDocument(await ReadSharedJournalBytesAsync(
                Path.Combine(item.JournalDirectory, "context.json"), cancellation));
            var context = contextDocument.RootElement;
            var bytes = await ReadSharedJournalBytesAsync(requestFile, cancellation);
            if (JsonData.String(context, "request_sha256") !=
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant())
                throw new InvalidDataException("Saved request bytes changed after the recovery listing.");
            var frozen = new FrozenMutation(item.RequestId, item.RecordId, Runtime,
                JsonData.String(context, "database_instance_id") ?? "",
                JsonData.String(context, "database_epoch") ?? "", bytes, item.JournalDirectory, item.OperationId);
            var result = await CallAsync(item.OperationId,
                ["recovery", "replay", item.RecoveryKey, "--interface-config", Runtime.ConfigPath],
                cancellation, mutation: true, requestFile: requestFile);
            if (result.Envelope is { } envelope)
                result = ValidateMutationResponse(envelope, frozen, result.ExitCode,
                    verifyTarget: item.OperationId is "put" or "delete" or "decision.set" or "pending.drop");
            await RefreshSharedRecoveryAsync(cancellation);
            return new(result.Success, !result.Success, !result.Success, item.RequestId,
                result.Success ? null : "The original outcome remains unresolved. " + result.Message +
                    " Preserve the saved bytes and inspect their original receipt before another request.", result);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidDataException)
        {
            return new(false, true, true, item.RequestId,
                error.Message + " Action: Preserve " + item.JournalDirectory +
                "; use recovery list with the selected interface config and reconcile the original receipt before replay.", null);
        }
    }

    private static async Task<byte[]> ReadSharedJournalBytesAsync(string file, CancellationToken cancellation)
    {
        for (var candidate = Path.GetFullPath(file); candidate is not null; candidate = Path.GetDirectoryName(candidate))
            if ((File.GetAttributes(candidate) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Shared recovery contains a reparse link; no replay was dispatched.");
        await using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 4096, options: FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length > 16 * 1024 * 1024)
            throw new InvalidDataException("Shared recovery exceeds the bounded local journal limit (16 MiB); no replay was dispatched.");
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellation);
        if (stream.Length != bytes.Length)
            throw new InvalidDataException("Shared recovery changed while reading; no replay was dispatched.");
        return bytes;
    }
}
