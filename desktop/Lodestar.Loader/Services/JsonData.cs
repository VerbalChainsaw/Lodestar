using System.Text;
using System.Text.Json;

namespace Lodestar.Loader;

internal static class JsonData
{
    public static string DecodeUtf8(byte[] bytes)
    {
        try { return new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException error)
        { throw new InvalidDataException("Invalid UTF-8 bytes. Preserve the original bytes and inspect the response or journal before retrying.", error); }
    }

    public static JsonDocument ParseDocument(byte[] bytes) => ParseDocument(DecodeUtf8(bytes));

    public static JsonDocument ParseDocument(string text)
    {
        if (text.StartsWith('\uFEFF')) text = text[1..];
        var document = JsonDocument.Parse(text);
        try
        {
            if (DuplicateMember(document.RootElement) is { } pointer)
                throw new InvalidDataException("Duplicate JSON member at " + pointer +
                    ". Preserve the original bytes and inspect the response or journal before retrying.");
            return document;
        }
        catch { document.Dispose(); throw; }
    }

    public static string? DuplicateMember(JsonElement value, string pointer = "")
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                var child = pointer + "/" + property.Name.Replace("~", "~0").Replace("/", "~1");
                if (!names.Add(property.Name)) return child;
                if (DuplicateMember(property.Value, child) is { } duplicate) return duplicate;
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var item in value.EnumerateArray())
                if (DuplicateMember(item, pointer + "/" + index++) is { } duplicate) return duplicate;
        }
        return null;
    }

    public static bool HasInvalidUnicode(string text)
    {
        for (var index = 0; index < text.Length; index++)
        {
            if (char.IsHighSurrogate(text[index]))
            {
                if (++index >= text.Length || !char.IsLowSurrogate(text[index])) return true;
            }
            else if (char.IsLowSurrogate(text[index])) return true;
        }
        return false;
    }
    public static bool TryObject(JsonElement parent, string name, out JsonElement value)
    {
        value = default;
        return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Object;
    }
    public static bool TryArray(JsonElement parent, string name, out JsonElement value)
    {
        value = default;
        return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Array;
    }
    public static bool TryString(JsonElement parent, string name, out string value)
    {
        value = "";
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var item) ||
            item.ValueKind != JsonValueKind.String) return false;
        value = item.GetString()!; return true;
    }
    public static bool TryBool(JsonElement parent, string name, out bool value)
    {
        value = false;
        if (parent.ValueKind != JsonValueKind.Object || !parent.TryGetProperty(name, out var item) ||
            item.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return false;
        value = item.GetBoolean(); return true;
    }
    public static bool TryInt(JsonElement parent, string name, out int value)
    {
        value = 0;
        return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var item) &&
            item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out value);
    }
    public static bool TryLong(JsonElement parent, string name, out long value)
    {
        value = 0;
        return parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(name, out var item) &&
            item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out value);
    }
    public static string? String(JsonElement parent, string name) => TryString(parent, name, out var value) ? value : null;
    public static JsonElement? Property(JsonElement parent, string name) => parent.ValueKind == JsonValueKind.Object &&
        parent.TryGetProperty(name, out var value) ? value : null;
    public static string Pretty(JsonElement value) => JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = true });
    public static DateTimeOffset? Date(JsonElement parent, string name) =>
        TryString(parent, name, out var value) && DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;
}
