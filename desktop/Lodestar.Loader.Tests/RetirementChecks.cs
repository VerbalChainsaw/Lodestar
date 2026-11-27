using System.Diagnostics;
using Lodestar.Loader;

public static class RetirementChecks
{
    public static async Task RunAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), "ll-retirement-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var start = new ProcessStartInfo(TestNodeRuntime.Resolve()) { UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "generate-fixture.mjs"));start.ArgumentList.Add(root);
            using (var child = Process.Start(start)!)
            {
                var output = child.StandardOutput.ReadToEndAsync();var errors = child.StandardError.ReadToEndAsync();
                await child.WaitForExitAsync();await output;
                if (child.ExitCode != 0) throw new Exception(await errors);
            }
            var runtime = await RuntimeConfig.LoadAsync(Path.Combine(root, "interfaces.json"));
            await using var service = new LodestarService(runtime, journalRoot: Path.Combine(root, "native"));
            await service.DiscoverAsync();var project = (await service.LoadLibraryAsync()).Projects.Single();
            var action = await service.PrepareOperatorActionAsync("retire-record", new Dictionary<string,string> {
                ["author"] = "Alex", ["id"] = "fact:loader-editable", ["reason"] = "Superseded by new findings" }, project);
            if (action.Request is null) throw new Exception("Retirement unavailable: " + action.Error);
            var saved = await service.SaveAsync(action.Request);if (!saved.Saved) throw new Exception(saved.Error);
            var record = (await service.GetRecordAsync("fact:loader-editable")).Record;
            if (record?.Lifecycle != "historical") throw new Exception("Retirement did not preserve a historical record.");
            if (record.Json.GetProperty("data").GetProperty("notes").GetString() != "Original") throw new Exception("Retirement rewrote content.");
            var rejected = await service.PrepareOperatorActionAsync("retire-record", new Dictionary<string,string> {
                ["author"] = "Alex", ["id"] = "project:loader-fixture", ["reason"] = "Wrong target" }, project);
            if (rejected.Request is not null) throw new Exception("Ordinary retirement admitted a project catalog record.");
        }
        finally { Directory.Delete(root, true); }
    }
}
