using System.Diagnostics;
using System.ComponentModel;
using System.Text;
using System.Text.Json;

namespace Lodestar.Loader;

public sealed class CliTransport : IAsyncDisposable
{
    private const int OutputLimit = 16 * 1024 * 1024;
    private static readonly string[] RemovedEnvironment = [
        "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "OPENCODE_SESSION_ID",
        "CODEX_AGENT_NAME", "LODESTAR_AGENT", "LODESTAR_HARNESS", "LODESTAR_DB",
        "NODE_OPTIONS", "NODE_PATH"
    ];
    private readonly SemaphoreSlim _slots = new(2, 2);
    private readonly SemaphoreSlim _mutation = new(1, 1);
    private readonly DiagnosticLog _diagnostics;
    private readonly Func<Process, Task>? _afterStart;
    private readonly CancellationTokenSource _closing = new();
    private readonly object _lifecycle = new();
    private readonly TaskCompletionSource _drained = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _inflight;
    private int _disposed;

    public CliTransport() : this(null, null) { }

    internal CliTransport(DiagnosticLog? diagnostics, Func<Process, Task>? afterStart)
    {
        _diagnostics = diagnostics ?? new DiagnosticLog();
        _afterStart = afterStart;
    }

    public Task<CliResult> ExecuteAsync(CliInvocation invocation, CancellationToken cancellation = default)
    {
        lock (_lifecycle)
        {
            if (_disposed != 0)
                return Task.FromResult(Failure("closing", "The transport is closing.", false));
            _inflight++;
            var operation = ExecuteCoreAsync(invocation, cancellation);
            // Return this exact task. Its terminal transition, rather than its
            // finally block, proves that the admitted call has finished.
            _ = operation.ContinueWith(_ =>
            {
                lock (_lifecycle)
                {
                    _inflight--;
                    if (_disposed != 0 && _inflight == 0) _drained.TrySetResult();
                }
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return operation;
        }
    }

    private async Task<CliResult> ExecuteCoreAsync(CliInvocation invocation, CancellationToken cancellation)
    {
        if (string.IsNullOrWhiteSpace(invocation.OperationId) || invocation.Arguments.IsDefaultOrEmpty)
            return Failure("invalid_invocation", "An operation and exact arguments are required.", false);
        if (Volatile.Read(ref _disposed) != 0)
            return Failure("closing", "The transport is closing.", false);
        if (invocation.Arguments.Any(a => a.Contains('\0') || JsonData.HasInvalidUnicode(a)))
            return Failure("invalid_invocation", "Arguments contain unsupported Unicode or NUL.", false);
        if (!File.Exists(invocation.Runtime.NodePath) || !File.Exists(invocation.Runtime.CliPath))
            return Failure("runtime_missing", "The configured Node executable or Lodestar CLI is missing.", false);
        if (!File.Exists(invocation.Runtime.DatabasePath) && invocation.OperationId != "help")
            return Failure("database_missing", "The selected database does not exist; inspect the connection.", false);
        var clock = Stopwatch.StartNew();
        var mutationHeld = false;
        var slotsHeld = 0;
        Process? process = null;
        var dispatched = false;
        var outputOverflow = false;
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation, _closing.Token);
            deadline.CancelAfter(invocation.Deadline <= TimeSpan.Zero ? TimeSpan.FromSeconds(30) : invocation.Deadline);
            if (invocation.IsMutation) { await _mutation.WaitAsync(deadline.Token); mutationHeld = true; }
            await _slots.WaitAsync(deadline.Token); slotsHeld++;
            if (invocation.IsMutation) { await _slots.WaitAsync(deadline.Token); slotsHeld++; }
            var start = new ProcessStartInfo(invocation.Runtime.NodePath)
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = Path.GetDirectoryName(invocation.Runtime.CliPath)!
            };
            start.ArgumentList.Add(invocation.Runtime.CliPath);
            start.ArgumentList.Add("--db"); start.ArgumentList.Add(invocation.Runtime.DatabasePath);
            foreach (var arg in invocation.Arguments) start.ArgumentList.Add(arg);
            foreach (var name in RemovedEnvironment) start.Environment.Remove(name);
            process = new Process { StartInfo = start };
            lock (_lifecycle)
            {
                if (_disposed != 0) return Failure("closing", "The transport is closing.", false);
                deadline.Token.ThrowIfCancellationRequested();
                if (!process.Start()) return Failure("launch_failed", "Node did not start.", false);
                dispatched = true;
            }
            process.StandardInput.Close();
            if (_afterStart is not null) await _afterStart(process).WaitAsync(deadline.Token);
            using var responseCancellation = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
            using var closeReaders = responseCancellation.Token.Register(() => CloseOutputReaders(process));
            void Overflow() { outputOverflow = true; responseCancellation.Cancel(); }
            var stdout = ReadBoundedAsync(process.StandardOutput.BaseStream, Overflow, responseCancellation.Token);
            var stderr = ReadBoundedAsync(process.StandardError.BaseStream, Overflow, responseCancellation.Token);
            try { await process.WaitForExitAsync(responseCancellation.Token); }
            catch (OperationCanceledException)
            {
                KillOwned(process);
                await ReapAsync(process);
                var drained = await DrainBoth(stdout, stderr);
                if (outputOverflow) return Failure("output_overflow", "The CLI response exceeded the 16 MiB stream budget.",
                    dispatched && invocation.IsMutation, clock.ElapsedMilliseconds,
                    process.HasExited ? process.ExitCode : null, "CLI output omitted after overflow.");
                var code = cancellation.IsCancellationRequested ? "cancelled" : _closing.IsCancellationRequested ? "closing" : "timeout";
                return Failure(code, "The operation ended before a complete response was received.", dispatched && invocation.IsMutation,
                    clock.ElapsedMilliseconds, process.HasExited ? process.ExitCode : null,
                    SafeDiagnosticSummary("stderr", drained.Stderr.Text));
            }
            var streams = await DrainBoth(stdout, stderr);
            responseCancellation.Token.ThrowIfCancellationRequested();
            return Parse(invocation, process.ExitCode, streams.Stdout, streams.Stderr,
                clock.ElapsedMilliseconds, invocation.IsMutation);
        }
        catch (OperationCanceledException)
        {
            if (dispatched && process is { HasExited: false }) { KillOwned(process); await ReapAsync(process); }
            if (outputOverflow) return Failure("output_overflow", "The CLI response exceeded the 16 MiB stream budget.",
                dispatched && invocation.IsMutation, clock.ElapsedMilliseconds, diagnostics: "CLI output omitted after overflow.");
            var code = cancellation.IsCancellationRequested ? "cancelled" :
                _closing.IsCancellationRequested ? "closing" : "timeout";
            var action = dispatched
                ? "Inspect the saved exact request in Pending saves for a write, or refresh the read after checking Connection."
                : "Check Connection, then retry this operation when transport capacity is available.";
            return Failure(code,
                invocation.OperationId + (dispatched ? " ended after dispatch before a complete response." :
                    " ended before dispatch. No write was dispatched by this attempt.") + " " + action,
                dispatched && invocation.IsMutation, clock.ElapsedMilliseconds) with {
                    FailureStage = dispatched ? "response" : "admission", FailureCategory = code, Action = action
                };
        }
        catch (InvalidDataException) when (dispatched)
        {
            if (process is { HasExited: false }) { KillOwned(process); await ReapAsync(process); }
            return Failure("protocol_error", "The CLI response contains invalid UTF-8. Check that the selected CLI returns valid UTF-8 and unique JSON member names.",
                invocation.IsMutation, clock.ElapsedMilliseconds);
        }
        catch (Exception error)
        {
            if (dispatched && process is { HasExited: false }) { KillOwned(process); await ReapAsync(process); }
            var stage = dispatched ? "response" : "launch";
            var category = SafeFailureCategory(error, dispatched);
            var action = SafeFailureAction(category, dispatched);
            var correlation = Guid.NewGuid();
            var recorded = _diagnostics.RecordFailure(invocation.IsMutation ? DiagnosticOperation.Save :
                DiagnosticOperation.GenericRead, error, false, correlation);
            var unavailable = recorded.Status != DiagnosticWriteStatus.Written;
            var result = Failure("transport_error", dispatched
                ? "The CLI process failed after dispatch."
                : "The configured Node executable could not start.", dispatched && invocation.IsMutation,
                clock.ElapsedMilliseconds);
            return result with {
                Message = result.Message + " Stage: " + stage + ". Category: " + category +
                    ". Action: " + action + ". Diagnostic correlation: " + correlation.ToString("N") +
                    (unavailable ? ". diagnostics_unavailable." : "."),
                FailureStage = stage, FailureCategory = category, Action = action,
                CorrelationId = correlation.ToString("N"), DiagnosticsUnavailable = unavailable
            };
        }
        finally
        {
            process?.Dispose();
            while (slotsHeld-- > 0) _slots.Release();
            if (mutationHeld) _mutation.Release();
        }
    }

    private static async Task<(string Text, bool Overflow)> ReadBoundedAsync(Stream stream,
        Action overflowed, CancellationToken cancellation)
    {
        using var output = new MemoryStream();
        var buffer = new byte[16384];
        var overflow = false;
        try
        {
            while (true)
            {
                var count = await stream.ReadAsync(buffer.AsMemory(), cancellation);
                if (count == 0) break;
                if (output.Length + count > OutputLimit)
                {
                    overflow = true; overflowed(); break;
                }
                output.Write(buffer, 0, count);
            }
        }
        catch (Exception error) when (cancellation.IsCancellationRequested &&
            error is OperationCanceledException or ObjectDisposedException or IOException) { }
        // Cancelled bytes are diagnostic-only. A partial UTF-8 sequence cannot
        // turn an incomplete operation into a different protocol outcome.
        if (cancellation.IsCancellationRequested)
            return (overflow ? "" : Encoding.UTF8.GetString(output.ToArray()), overflow);
        return (overflow ? "" : JsonData.DecodeUtf8(output.ToArray()), overflow);
    }

    private static void CloseOutputReaders(Process process)
    {
        try { process.StandardOutput.BaseStream.Dispose(); } catch (InvalidOperationException) { }
        try { process.StandardError.BaseStream.Dispose(); } catch (InvalidOperationException) { }
    }

    private static async Task<((string Text, bool Overflow) Stdout, (string Text, bool Overflow) Stderr)> DrainBoth(
        Task<(string Text, bool Overflow)> stdout, Task<(string Text, bool Overflow)> stderr)
    {
        var result = await Task.WhenAll(stdout, stderr);
        return (result[0], result[1]);
    }

    // Journal bytes establish no process exit. Live callers may supply the observed exit;
    // both paths still require the service to bind the envelope to its frozen mutation.
    internal static CliResult ParseRecordedMutation(CliInvocation invocation, JsonElement envelope,
        int? observedExit = null) => Parse(invocation, observedExit,
            (envelope.GetRawText(), false), ("", false), 0, true);

    private static CliResult Parse(CliInvocation invocation, int? exitCode, (string Text, bool Overflow) stdout,
        (string Text, bool Overflow) stderr, long elapsed, bool mutation)
    {
        if (stdout.Overflow || stderr.Overflow)
            return Failure("output_overflow", "The CLI response exceeded the 16 MiB stream budget.", mutation,
                elapsed, exitCode, "CLI output omitted after overflow.");
        var candidates = new List<JsonElement>();
        var diagnostics = new List<string>();
        var malformed = false;
        foreach (var (stream, text) in new[] { ("stdout", stdout.Text), ("stderr", stderr.Text) })
        {
            foreach (var content in ObjectFragments(text))
            {
                if (string.IsNullOrWhiteSpace(content)) continue;
                if (TryEnvelope(content, out var result, out var invalid)) candidates.Add(result);
                else if (invalid) malformed = true;
                else diagnostics.Add(SafeDiagnosticLabel(stream, content));
            }
        }
        var diagnosticText = string.Join(Environment.NewLine, diagnostics.Distinct().Take(8));
        if (malformed)
            return Failure("protocol_error", "Malformed or ambiguous envelope-looking output was returned. Check that the selected CLI returns valid UTF-8 and unique JSON member names.", mutation,
                elapsed, exitCode, diagnosticText);
        if (candidates.Count != 1)
            return Failure("protocol_error", candidates.Count == 0 ? "No complete contract-5 envelope was returned." :
                "Conflicting or repeated CLI envelopes were returned.", mutation, elapsed, exitCode, diagnosticText);
        var envelope = candidates[0];
        if (!JsonData.TryInt(envelope, "v", out var version) || version != 5 ||
            !JsonData.TryString(envelope, "operation", out var operation) || operation != invocation.OperationId ||
            !JsonData.TryBool(envelope, "ok", out var okay))
            return Failure("protocol_error", "The CLI envelope version, operation, or result shape is invalid.", mutation,
                elapsed, exitCode, diagnosticText);
        if (!envelope.TryGetProperty("more", out var more) ||
            more.ValueKind is not (JsonValueKind.True or JsonValueKind.False) ||
            !envelope.TryGetProperty("next", out var next) || next.ValueKind != JsonValueKind.Array ||
            !envelope.TryGetProperty("revision", out var revision) ||
            revision.ValueKind != JsonValueKind.Null &&
                !(revision.ValueKind == JsonValueKind.Number && revision.TryGetInt64(out var number) &&
                    number >= 0 && number <= 9_007_199_254_740_991L) ||
            !envelope.TryGetProperty("database_instance_id", out var instance) ||
            instance.ValueKind is not (JsonValueKind.Null or JsonValueKind.String) ||
            !envelope.TryGetProperty("database_epoch", out var epoch) ||
            epoch.ValueKind is not (JsonValueKind.Null or JsonValueKind.String))
            return Failure("protocol_error", "The CLI paging, revision or database identity shape is invalid.", mutation,
                elapsed, exitCode, diagnosticText);
        if (okay && !JsonData.TryObject(envelope, "data", out _))
            return Failure("protocol_error", "A success envelope has no data object.", mutation,
                elapsed, exitCode, diagnosticText);
        JsonElement error = default;
        if (!okay && (!JsonData.TryObject(envelope, "error", out error) ||
            !JsonData.TryString(error, "code", out _) || !JsonData.TryString(error, "message", out _)))
            return Failure("protocol_error", "An error envelope has no structured error.", mutation,
                elapsed, exitCode, diagnosticText);
        if (okay && exitCode.HasValue && exitCode != 0 && !(exitCode == 4 && DiagnosticExitAllowed(invocation)))
            return Failure("protocol_error", "A success envelope had an unexpected process exit code.", mutation,
                elapsed, exitCode, diagnosticText);
        if (!okay && exitCode == 0)
            return Failure("protocol_error", "An error envelope had a successful process exit code.", mutation,
                elapsed, exitCode, diagnosticText);
        var code = okay ? null : JsonData.String(error, "code") ?? "core_error";
        var message = okay ? (exitCode == 4 ? "Diagnostic result needs attention." : "OK") :
            JsonData.String(error, "message") ?? "Lodestar returned an error.";
        if (!okay)
        {
            var action = JsonData.String(error, "action");
            if (!string.IsNullOrWhiteSpace(action))
                message += " Action: " + action;
            if (JsonData.TryObject(error, "identifiers", out var identifiers))
            {
                foreach (var name in new[] { "request_id", "record_id", "id", "receipt_id" })
                {
                    var id = JsonData.String(identifiers, name);
                    if (!string.IsNullOrWhiteSpace(id) && id.Length <= 160 &&
                        !id.Any(char.IsControl)) message += " " + name + ": " + id;
                }
                if (identifiers.TryGetProperty("committed_revision", out var committed) &&
                    committed.ValueKind == JsonValueKind.Number && committed.TryGetInt64(out var committedRevision) &&
                    committedRevision >= 0 && committedRevision <= 9_007_199_254_740_991L)
                    message += " committed_revision: " + committedRevision;
            }
        }
        var deliveryFailure = mutation && code == "response_delivery_failed";
        if (!okay && exitCode.HasValue && (exitCode < 1 || exitCode > 5 || (mutation && exitCode == 1)))
            return Failure("protocol_error", "Core report '" + code + "': " + message +
                " Observed process exit " + exitCode + " cannot settle the write outcome. Inspect the original request and receipt before preparing a new write.",
                mutation, elapsed, exitCode, diagnosticText) with { Envelope = envelope,
                    FailureStage = "response", FailureCategory = "inconsistent_exit",
                    Action = JsonData.String(error, "action") ?? "Inspect the saved exact request and original receipt in Pending saves." };
        var committedOutcome = !okay && JsonData.TryObject(error, "identifiers", out var outcomeIdentifiers) &&
            (JsonData.String(outcomeIdentifiers, "committed") == "unknown" ||
                JsonData.TryBool(outcomeIdentifiers, "committed", out var committedFlag) && committedFlag);
        var unresolvedWrite = mutation && !okay && (deliveryFailure || code == "database_commit_outcome_unknown" || committedOutcome);
        if (deliveryFailure && exitCode.HasValue && exitCode != 5)
            return Failure("protocol_error", "Response delivery failure had an unexpected exit code.", mutation,
                elapsed, exitCode, diagnosticText);
        if (unresolvedWrite)
            message += " The write outcome is unknown to Loader until the saved request and receipt are verified. Inspect the saved request in Pending saves.";
        return new(okay, envelope, code, message, exitCode, diagnosticText, elapsed,
            unresolvedWrite, deliveryFailure ? "response_delivery" : null,
            deliveryFailure ? "committed_response_delivery_failed" : null,
            unresolvedWrite ? JsonData.String(error, "action") ?? "Inspect the saved exact request in Pending saves and verify its receipt." : null);
    }

    private static IEnumerable<string> ObjectFragments(string text)
    {
        using var lines = new StringReader(text);
        var fragment = new StringBuilder();
        var depth = 0;
        var quoted = false;
        var escaped = false;
        while (lines.ReadLine() is { } line)
        {
            if (fragment.Length == 0 && !EnvelopeText(line).StartsWith('{'))
            { yield return line; continue; }
            if (fragment.Length > 0) fragment.Append('\n');
            fragment.Append(line);
            foreach (var character in line)
            {
                if (quoted)
                {
                    if (escaped) escaped = false;
                    else if (character == '\\') escaped = true;
                    else if (character == '"') quoted = false;
                }
                else if (character == '"') quoted = true;
                else if (character == '{') depth++;
                else if (character == '}') depth--;
            }
            if (depth <= 0)
            {
                yield return fragment.ToString();
                fragment.Clear(); depth = 0; quoted = false; escaped = false;
            }
        }
        if (fragment.Length > 0) yield return fragment.ToString();
    }

    private static bool TryEnvelope(string text, out JsonElement element, out bool malformed)
    {
        element = default;
        malformed = false;
        text = EnvelopeText(text);
        if (!text.StartsWith('{')) return false;
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !(root.TryGetProperty("v", out _) || root.TryGetProperty("ok", out _) ||
                  root.TryGetProperty("operation", out _) || root.TryGetProperty("error", out _) ||
                  root.TryGetProperty("data", out _)))
                return false;
            if (!root.TryGetProperty("v", out _) || JsonData.DuplicateMember(root) is not null)
            { malformed = true; return false; }
            element = root.Clone(); return true;
        }
        catch (JsonException) { malformed = LooksLikeEnvelope(text); return false; }
    }

    private static string EnvelopeText(string text)
    {
        var trimmed = text.Trim();
        return trimmed.StartsWith('\uFEFF') ? trimmed[1..].TrimStart() : trimmed;
    }

    private static bool LooksLikeEnvelope(string text)
    {
        var trimmed = EnvelopeText(text);
        if (!trimmed.StartsWith('{')) return false;
        if (trimmed.Contains("\"v\"") ||
            trimmed.Contains("\"ok\"") || trimmed.Contains("\"operation\"") ||
            trimmed.Contains("\"error\"") || trimmed.Contains("\"data\"")) return true;
        var bytes = Encoding.UTF8.GetBytes(trimmed);
        var offset = 0;
        while (offset < bytes.Length)
        {
            var quote = bytes.AsSpan(offset).IndexOf((byte)'"');
            if (quote < 0) break;
            offset += quote;
            // A protocol name has at most nine characters, each at most six escaped bytes.
            // Read only a possible string token so preceding malformed syntax cannot hide it.
            var reader = new Utf8JsonReader(bytes.AsSpan(offset, Math.Min(56, bytes.Length - offset)),
                isFinalBlock: false, state: default);
            try
            {
                if (reader.Read() && reader.TokenType == JsonTokenType.String)
                {
                    if (reader.ValueTextEquals("v") || reader.ValueTextEquals("ok") || reader.ValueTextEquals("operation") ||
                        reader.ValueTextEquals("error") || reader.ValueTextEquals("data")) return true;
                    offset += (int)reader.BytesConsumed;
                    continue;
                }
            }
            catch (JsonException) { }
            offset++;
        }
        return false;
    }

    private static bool DiagnosticExitAllowed(CliInvocation invocation)
    {
        string[]? prefix = invocation.OperationId switch
        {
            "doctor" => ["doctor"],
            "agents.verify" => ["agents", "verify"],
            "setup" => ["setup"],
            "skills.verify" => ["skills", "verify"],
            "skills.status" => ["skills"],
            _ => null
        };
        if (prefix is null) return false;
        var positionals = new List<string>();
        var values = new HashSet<string>(StringComparer.Ordinal) { "--db", "--output", "--source",
            "--cwd", "--mode", "--target", "--home", "--codex-root", "--codex-home",
            "--claude-home", "--xdg-config-home", "--hermes-home", "--opencode-root",
            "--wsl-shim", "--posix-shim" };
        var booleans = new HashSet<string>(StringComparer.Ordinal) { "--human", "--apply",
            "--replace-local", "--migration-preflight", "--recovery-preflight" };
        for (var index = 0; index < invocation.Arguments.Length; index++)
        {
            var token = invocation.Arguments[index];
            if (values.Contains(token))
            {
                if (++index >= invocation.Arguments.Length ||
                    invocation.Arguments[index].StartsWith("--", StringComparison.Ordinal)) return false;
            }
            else if (booleans.Contains(token)) continue;
            else if (token.StartsWith("--", StringComparison.Ordinal)) return false;
            else positionals.Add(token);
        }
        return positionals.SequenceEqual(prefix);
    }

    private static string SafeDiagnosticLabel(string stream, string text)
    {
        foreach (var warning in new[] { "ExperimentalWarning:", "DeprecationWarning:", "Warning:" })
            if (text.TrimStart().StartsWith(warning, StringComparison.Ordinal))
                return stream + ": " + warning[..^1];
        return stream + ": text omitted";
    }

    private static string SafeDiagnosticSummary(string stream, string text) =>
        string.Join(Environment.NewLine, text.Split('\n').Where(line => !string.IsNullOrWhiteSpace(line))
            .Select(line => SafeDiagnosticLabel(stream, line)).Distinct().Take(8));

    private static string SafeFailureCategory(Exception error, bool dispatched) => error switch
    {
        UnauthorizedAccessException => "access_denied",
        Win32Exception { NativeErrorCode: 5 } => "access_denied",
        FileNotFoundException or DirectoryNotFoundException => "path_missing",
        Win32Exception { NativeErrorCode: 2 or 3 } => "path_missing",
        Win32Exception { NativeErrorCode: 193 or 216 } or BadImageFormatException => "invalid_executable",
        IOException when dispatched => "response_io_failed",
        IOException => "launch_io_failed",
        _ => dispatched ? "response_failed" : "launch_failed"
    };

    private static string SafeFailureAction(string category, bool dispatched) => dispatched
        ? "Inspect Pending saves for a write, or use Refresh for a read, after checking Connection."
        : category switch
    {
        "access_denied" => "Check access to the selected Node executable and its working directory in Connection.",
        "path_missing" => "Check the selected Node executable and Lodestar CLI paths in Connection.",
        "invalid_executable" => "Select a valid Node executable in Connection.",
        _ => "Check the selected runtime in Connection before retrying."
    };
    private static CliResult Failure(string code, string message, bool uncertain, long elapsed = 0,
        int? exit = null, string diagnostics = "") => new(false, null, code,
        message + (uncertain
            ? " The write outcome is unknown. Inspect the saved request in Pending saves and replay only that exact request after checking the configured Node, CLI, database and arguments."
            : " Check the configured Node, CLI, database and arguments before retrying."), exit,
        diagnostics, elapsed, uncertain);

    private static void KillOwned(Process process)
    {
        try { if (!process.HasExited) process.Kill(); }
        catch (InvalidOperationException) { }
    }
    private static async Task ReapAsync(Process process)
    {
        try { using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await process.WaitForExitAsync(limit.Token); }
        catch (OperationCanceledException) { }
    }

    public async ValueTask DisposeAsync()
    {
        bool firstClose;
        lock (_lifecycle)
        {
            firstClose = _disposed == 0;
            _disposed = 1;
            if (_inflight == 0) _drained.TrySetResult();
        }
        // Each admitted call owns cancellation, reaping and handle disposal for its child.
        // Cancel outside the gate: waiter continuations also need the lifecycle lock.
        if (firstClose) _closing.Cancel();
        await _drained.Task;
    }
}
