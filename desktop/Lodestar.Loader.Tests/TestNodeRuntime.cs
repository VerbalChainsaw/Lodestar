internal static class TestNodeRuntime
{
    internal static string Resolve() => Resolve(
        Environment.GetEnvironmentVariable("LODESTAR_TEST_NODE"),
        Environment.GetEnvironmentVariable("PATH"));

    internal static string Resolve(string? explicitNode, string? searchPath)
    {
        if (explicitNode is not null) return explicitNode;
        var executable = OperatingSystem.IsWindows() ? "node.exe" : "node";
        return (searchPath ?? "").Split(Path.PathSeparator)
            .Where(directory => !string.IsNullOrWhiteSpace(directory))
            .Select(directory => Path.Combine(directory, executable))
            .FirstOrDefault(File.Exists) ?? throw new InvalidOperationException(
                "Node was not found for the native tests. Set LODESTAR_TEST_NODE to a supported Node executable or put supported Node on PATH.");
    }
}
