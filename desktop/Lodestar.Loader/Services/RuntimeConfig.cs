using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Lodestar.Loader;

public static class RuntimeConfig
{
    private const string NumericCorrection = "Correct the named field to an exact numeric value: version must be 1 and core byte counts must be nonnegative integers. Keep the required field numeric, then reload.";

    public static async Task<RuntimeSelection> LoadAsync(string configPath, CancellationToken cancellation = default)
    {
        var full = Path.GetFullPath(configPath);
        if (!File.Exists(full)) throw new FileNotFoundException("Interface config is missing.", full);
        using var document = await ReadBindingDocumentAsync(full, cancellation);
        var root = document.RootElement;
        if (!JsonData.TryInt(root, "v", out var version) || version != 1)
            throw BindingError(full, "/v", "The binding version must be integer 1.", action: NumericCorrection);
        if (!JsonData.TryString(root, "generation", out var generation) ||
            !Regex.IsMatch(generation, @"\A[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant) ||
            !JsonData.TryObject(root, "runtime", out var runtime))
            throw new InvalidDataException("interfaces.json needs v:1, a UUID generation, and runtime.");
        var directory = Path.GetDirectoryName(full)!;
        var node = Resolve(directory, JsonData.String(runtime, "node"), "Node executable");
        var cli = Resolve(directory, JsonData.String(runtime, "cli"), "Lodestar CLI");
        var database = Resolve(directory, JsonData.String(runtime, "database"), "database");
        if (!File.Exists(node) || !File.Exists(cli))
            throw new FileNotFoundException("The configured Node executable or Lodestar CLI does not exist.");
        if (!File.Exists(database))
            throw new FileNotFoundException("The configured database does not exist. Loading will not initialize it.", database);
        var core = await RuntimeSourceFingerprintAsync(directory, cli, cancellation);
        if (core.Basis == "verified_manifest_core") AdmitPortableDatabase(full, directory, database);
        var nodeInfo = new FileInfo(node);
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n',
            generation, node, nodeInfo.Length, nodeInfo.LastWriteTimeUtc.Ticks, cli, core.Digest, database)))).ToLowerInvariant();
        return new(full, generation, node, cli, database, fingerprint, core.Digest, core.Basis);
    }

    private static string Resolve(string directory, string? value, string label)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0') || JsonData.HasInvalidUnicode(value))
            throw new InvalidDataException($"The configured {label} path is invalid.");
        return Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(directory, value));
    }

    private static void AdmitPortableDatabase(string config, string directory, string database)
    {
        const string action = "Select an existing database outside the app, staging and previous-generation directories, using plain directories without reparse or symlink ancestors, then reload. The current config and store bytes were preserved.";
        InvalidDataException Reject(string reason, Exception? cause = null) =>
            BindingError(config, "/runtime/database", $"{reason} Database: {database}.", cause, action);
        foreach (var protectedRoot in new[] { directory, directory + ".lodestar-stage", directory + ".lodestar-previous" })
        {
            var boundary = Path.TrimEndingDirectorySeparator(protectedRoot);
            if (database.Equals(boundary, StringComparison.OrdinalIgnoreCase) ||
                database.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw Reject($"The portable database is inside a protected directory: {protectedRoot}.");
        }
        // Reject aliases rather than interpreting a lexical external path as safely outside owned directories.
        foreach (var start in new[] { directory, database })
        {
            for (string? current = start; current is not null; current = Path.GetDirectoryName(current))
            {
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                { throw Reject($"Cannot verify the selected path ancestor: {current}.", error); }
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw Reject($"The selected path contains a reparse or symlink ancestor: {current}.");
            }
        }
    }

    private static async Task<JsonDocument> ReadBindingDocumentAsync(string path, CancellationToken cancellation)
    {
        var bytes = await File.ReadAllBytesAsync(path, cancellation);
        JsonDocument? document = null;
        try
        {
            var text = new UTF8Encoding(false, true).GetString(bytes);
            if (text.StartsWith('\uFEFF')) text = text[1..];
            document = JsonDocument.Parse(text);
            if (JsonData.DuplicateMember(document.RootElement) is { } pointer)
                throw BindingError(path, pointer, "Duplicate JSON member name.");
            return document;
        }
        catch (DecoderFallbackException error)
        {
            document?.Dispose();
            throw BindingError(path, "/", "Invalid UTF-8 bytes.", error);
        }
        catch (JsonException error)
        {
            document?.Dispose();
            throw BindingError(path, error.Path ?? "/", $"Invalid JSON at line {error.LineNumber}, byte {error.BytePositionInLine}.", error);
        }
        catch
        {
            document?.Dispose();
            throw;
        }
    }

    private static InvalidDataException BindingError(string path, string field, string reason, Exception? cause = null,
        string? action = null) =>
        new($"{path} at {field}: {reason} Next action: {action ?? "Correct the named field in this binding document using valid JSON, valid UTF-8 and unique member names, then reload."} The original bytes were preserved.", cause);

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellation)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellation)).ToLowerInvariant();
    }

    private static async Task<(string Digest, string Basis)> RuntimeSourceFingerprintAsync(string configDirectory, string cli,
        CancellationToken cancellation)
    {
        var manifestPath = Path.Combine(configDirectory, "bundle-manifest.json");
        if (File.Exists(manifestPath)) return (await VerifyManifestAsync(configDirectory, manifestPath, cli, cancellation), "verified_manifest_core");
        var packagedCli = Path.GetFullPath(Path.Combine(configDirectory, "core", "lodestar.mjs"));
        if (Path.GetFullPath(cli).Equals(packagedCli, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The portable core manifest is missing.");
        var sourceRoot = Path.GetDirectoryName(cli)!;
        var selected = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var name in new[] { "lodestar.mjs", "package.json", ".mcp.json" })
        {
            var file = Path.Combine(sourceRoot, name);
            if (File.Exists(file)) selected[name] = file;
        }
        foreach (var directory in new[] { "src", "managed-assets", "codex-plugin", "docs" })
        {
            var path = Path.Combine(sourceRoot, directory);
            if (!Directory.Exists(path)) continue;
            foreach (var file in ConfinedFiles(path))
                selected[Path.GetRelativePath(sourceRoot, file).Replace('\\', '/')] = file;
        }
        // Tiny standalone CLI fixtures have no package tree, but their entry bytes still bind the request.
        if (selected.Count == 0) selected[Path.GetFileName(cli)] = cli;
        var digest = new StringBuilder();
        foreach (var (name, file) in selected)
            digest.Append(name).Append('\0').Append(new FileInfo(file).Length).Append('\0')
                .Append(await HashFileAsync(file, cancellation)).Append('\n');
        return (Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(digest.ToString()))).ToLowerInvariant(), "source_inventory");
    }

    private static IEnumerable<string> ConfinedFiles(string root)
    {
        var boundary = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var pending = new Stack<string>(); pending.Push(root);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            var info = new DirectoryInfo(directory);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Runtime source directory contains a symlink.");
            foreach (var file in Directory.EnumerateFiles(directory))
            {
                var full = Path.GetFullPath(file);
                if (!full.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) ||
                    (File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Runtime source file escapes its declared root.");
                yield return full;
            }
            foreach (var child in Directory.EnumerateDirectories(directory)) pending.Push(child);
        }
    }

    private static async Task<string> VerifyManifestAsync(string directory, string path, string cli,
        CancellationToken cancellation)
    {
        using var document = await ReadBindingDocumentAsync(path, cancellation);
        var root = document.RootElement;
        if (!JsonData.TryInt(root, "v", out var version) || version != 1)
            throw BindingError(path, "/v", "The manifest version must be integer 1.", action: NumericCorrection);
        if (!JsonData.TryArray(root, "files", out var files))
            throw new InvalidDataException("The portable bundle manifest has an unsupported shape.");
        var coreRoot = Path.GetFullPath(Path.Combine(directory, "core"));
        var boundary = coreRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var entries = new SortedDictionary<string, (string Path, long Size, string Hash)>(StringComparer.Ordinal);
        var index = 0;
        foreach (var entry in files.EnumerateArray())
        {
            var pointer = $"/files/{index++}/bytes";
            var relative = JsonData.String(entry, "path");
            if (relative is null || !relative.StartsWith("core/", StringComparison.Ordinal)) continue;
            if (!JsonData.TryLong(entry, "bytes", out var bytes) || bytes < 0)
                throw BindingError(path, pointer, "The core byte count must be a nonnegative integer.", action: NumericCorrection);
            if (!JsonData.TryString(entry, "sha256", out var hash) || hash.Length != 64 ||
                relative.Split('/').Any(segment => segment is "" or "." or "..") ||
                relative.Contains('\\') || Path.IsPathRooted(relative))
                throw new InvalidDataException("A core manifest entry is invalid.");
            var full = Path.GetFullPath(Path.Combine(directory, relative.Replace('/', Path.DirectorySeparatorChar)));
            if (!full.StartsWith(boundary, StringComparison.OrdinalIgnoreCase) || entries.ContainsKey(relative))
                throw new InvalidDataException("A core manifest path escapes the bundle or is duplicated.");
            entries[relative] = (full, bytes, hash.ToLowerInvariant());
        }
        if (entries.Count == 0 || !entries.Values.Any(e => Path.GetFullPath(e.Path).Equals(Path.GetFullPath(cli),
            StringComparison.OrdinalIgnoreCase)))
            throw new InvalidDataException("The manifest does not describe the configured core CLI.");
        var digest = new StringBuilder();
        foreach (var (name, entry) in entries)
        {
            if (!File.Exists(entry.Path) || new FileInfo(entry.Path).Length != entry.Size ||
                !string.Equals(await HashFileAsync(entry.Path, cancellation), entry.Hash, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"Portable core drifted from its manifest: {name}");
            digest.Append(name).Append('\0').Append(entry.Size).Append('\0').Append(entry.Hash).Append('\n');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(digest.ToString()))).ToLowerInvariant();
    }

}
