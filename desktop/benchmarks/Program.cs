using System.Diagnostics;
using System.Text.Json;
using Lodestar.Loader;

if (args.Length != 3) throw new ArgumentException("Usage: benchmarks CONFIG FIXTURE_MANIFEST OUTPUT_JSON");
var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(args[1])).RootElement.Clone();
if (fixture.GetProperty("fixture").GetString() != "synthetic-benchmark") throw new InvalidDataException("Expected a disposable benchmark fixture.");
var runtime = await LodestarService.LoadRuntimeAsync(args[0]);
if (Path.GetFullPath(runtime.DatabasePath) != Path.GetFullPath(fixture.GetProperty("database").GetString()!))
    throw new InvalidDataException("Fixture identity differs from config.");
await using var service = new LodestarService(runtime);
await service.DiscoverAsync();
var timer = Stopwatch.StartNew();
var snapshots = new List<object>();
var result = await service.LoadLibraryAsync();
void Capture() => snapshots.Add(new { elapsed_ms = timer.ElapsedMilliseconds, result.LoadedCount,
    records = result.Records.Length, result.Complete, result.HasMore, result.CanContinue,
    result.Revision, errors = result.RecordErrors.Length, result.Error });
Capture();
while (result.CanContinue && snapshots.Count < 10)
{
    Console.WriteLine($"Continue after {result.LoadedCount} rows");
    result = await service.ContinueLibraryAsync();
    Capture();
}
var expected = fixture.GetProperty("currentRecords").GetInt32();
var exact = result.Complete && result.Error is null && result.RecordErrors.Length == 0 &&
    result.Records.Length == expected && result.Records.Select(r => r.Id).Distinct().Count() == expected &&
    result.Projects.Length == fixture.GetProperty("projects").GetInt32();
using var process = Process.GetCurrentProcess();
process.Refresh();
var report = new { result = exact ? "PASS" : "FAIL", at = DateTimeOffset.UtcNow, expectedCurrentRecords = expected,
    elapsed_ms = timer.ElapsedMilliseconds, process.PeakWorkingSet64, process.WorkingSet64,
    snapshots, libraryRevision = result.Revision, projectCount = result.Projects.Length };
await File.WriteAllTextAsync(args[2], JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(report));
return exact ? 0 : 1;
