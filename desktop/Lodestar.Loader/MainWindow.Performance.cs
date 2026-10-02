using System.Diagnostics;
using System.Windows.Threading;

namespace Lodestar.Loader;

// Opt-in fixture instrumentation. It exercises the actual WPF event and read paths.
public partial class MainWindow
{
    public async Task<object> MeasureFixtureInteractionsAsync(int durationSeconds)
    {
        if (_service is null || _library?.Complete != true || _editing || _saving)
            throw new InvalidOperationException("Performance fixture must be ready and complete.");
        var warm = Stopwatch.StartNew();
        await RefreshAsync();
        await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
        warm.Stop();
        if (_library?.Complete != true || _library.Error is not null)
            throw new InvalidOperationException("Warm fixture refresh failed.");

        var filterSamples = new List<object>();
        _workspace = "projects";
        ConfigureWorkspace();
        foreach (var query in new[] { "Benchmark", "0001", "project", "active", "0007", "paused", "no-match", "" })
        {
            var timer = Stopwatch.StartNew();
            SearchBox.Text = query;
            while (_filterTimer.IsEnabled) await Task.Delay(5, _lifetime.Token);
            await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
            UpdateLayout();
            filterSamples.Add(new { query, elapsed_ms = timer.Elapsed.TotalMilliseconds, projectRows = DashboardList.Items.Count });
        }

        var memory = new List<object>();
        using var process = Process.GetCurrentProcess();
        var navigation = Stopwatch.StartNew();
        var operations = 0;
        void Sample(string phase)
        {
            process.Refresh();
            memory.Add(new { phase, elapsed_ms = navigation.ElapsedMilliseconds, operations,
                working_set_bytes = process.WorkingSet64, private_bytes = process.PrivateMemorySize64,
                managed_bytes = GC.GetTotalMemory(false), total_allocated_bytes = GC.GetTotalAllocatedBytes(false) });
        }
        Sample("before-navigation");
        var projects = _library.Projects.Take(12).ToArray();
        if (projects.Length == 0) throw new InvalidDataException("The benchmark fixture has no projects.");
        var blocks = 0;
        do
        {
            for (var index = 0; index < 12; index++)
            {
                var project = projects[index % projects.Length];
                await SelectProjectAsync(project);
                if (RecordProjection.AssociatedRecords(_library, project).FirstOrDefault(r => r.Kind != "project") is { } record)
                    await SelectRecordAsync(record);
                await Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
                ClearDetailForNavigation();
                operations++;
                await Task.Delay(durationSeconds > 0 ? 250 : 1, _lifetime.Token);
            }
            Sample("navigation-block-" + ++blocks);
        } while (navigation.Elapsed.TotalSeconds < durationSeconds);
        Sample("after-navigation");
        _project = null;
        _workspace = "health";
        ApplyFilters();
        ConfigureWorkspace();
        await Task.Delay(3000, _lifetime.Token);
        Sample("settled");
        // A separate retained-heap diagnostic, never used to disguise the observed working set.
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        Sample("diagnostic-full-gc");
        return new { at = DateTimeOffset.UtcNow, warm_refresh_ms = warm.Elapsed.TotalMilliseconds,
            filter_path = "TextBox.Text -> TextChanged -> existing debounce -> ApplyFilters -> WPF idle/layout",
            filters = filterSamples, navigation_duration_ms = navigation.ElapsedMilliseconds,
            navigation_operations = operations, memory, library_complete = _library.Complete,
            current_records = _library.Records.Length, projects = _library.Projects.Length };
    }
}
