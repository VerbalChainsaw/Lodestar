using System.Collections.Immutable;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace Lodestar.Loader;

public partial class MainWindow : Window
{
    private sealed record ProjectRow(ProjectSummary Project, string Name, string Secondary,
        string Status, string Update, string Count)
    {
        public DateTimeOffset? UpdatedAt => Project.CatalogRecord.Lifecycle is "historical" or "superseded"
            ? Project.CatalogRecord.UpdatedAt : Project.LatestCurrentUpdate;
        public int CountValue => Project.CurrentRecordCount;
        public string GroupStatus => Project.RecordedStatus ?? "No status recorded";
        public string Lifecycle => Project.CatalogRecord.Lifecycle ?? "current";
    }
    private sealed record ProjectIssueRow(RecordIssue Issue, string Name, string Secondary);
    private sealed record RecordRow(LibraryRecord Record, string Name, string Secondary)
    {
        public string Kind => Record.Kind;
        public string State
        {
            get
            {
                var data = JsonData.Property(Record.Json, "data");
                if (data is { ValueKind: JsonValueKind.Object } body &&
                    JsonData.String(body, "status") is { } status) return "Status: " + status;
                return Record.Lifecycle is { } lifecycle ? "Lifecycle: " + lifecycle :
                    Record.Availability is { } availability ? "Availability: " + availability : "Not recorded";
            }
        }
        public string Availability => Record.Availability ?? "Not recorded";
        public string Lifecycle => Record.Lifecycle ?? "current";
        public string Scope => Record.Scope;
        public DateTimeOffset? UpdatedAt => Record.UpdatedAt;
        public string Update => Record.UpdatedAt?.ToLocalTime().ToString("g") ?? "Unknown";
        public override string ToString() => Name + "\n" + Secondary;
    }
    private sealed record IssueRow(RecordIssue Issue)
    {
        public string Name => Issue.Id ?? "Unknown ID";
        public string Secondary => "Needs correction · " + Issue.Message;
        public override string ToString() => (Issue.Id ?? "Unknown ID") + " · needs correction · " + Issue.Message;
    }
    private sealed record CommandRow(CapabilityOperation Operation)
    {
        public string Name => FriendlyCommandLabel(Operation.Id);
        public string Secondary => Operation.Id + " · " + CommandAvailability(Operation) + " · " + Operation.Summary;
        public override string ToString() => Name + " · " + Secondary;
    }
    private sealed record RecoveryQuestionRow
    {
        public string Name => "Did my save complete?";
        public string Secondary => "Local UI route · Open Pending saves to inspect exact saved requests and receipts";
    }
    private sealed record PendingRow(PendingSave Item)
    {
        public string Name => Item.RecordId;
        public string Secondary => (Item.CommitReported ? "CLI reports commit · verify receipt" :
            "Save outcome unknown") + " · " + Item.CreatedAt.ToLocalTime().ToString("g");
        public override string ToString() => Item.RecordId + " · " + Secondary;
    }
    private sealed record NoteRow(string Text)
    {
        public string Name => Text;
        public string Secondary => "";
        public override string ToString() => Text;
    }

    private readonly string _configPath;
    private readonly string? _journalRoot;
    private readonly string? _initialProjectId;
    private readonly string? _initialRecordId;
    private LodestarService? _service;
    private LibrarySnapshot? _library;
    private ImmutableArray<ProjectSummary> _historicalProjects = [];
    private bool _historicalLoaded;
    private ProjectSummary? _project;
    private ProjectContextResult? _context;
    private LibraryRecord? _selectedRecord;
    private RecordIssue? _selectedIssue;
    private RecordSnapshot? _detail;
    private EditReview? _review;
    private CapabilityOperation? _operation;
    private PendingSave? _pending;
    private readonly Dictionary<string, Func<string?>> _commandInputs = new(StringComparer.Ordinal);
    private readonly Dictionary<LibraryRecord, string> _recordSearchCache = new(ReferenceEqualityComparer.Instance);
    private string _workspace = "health";
    private int _generation;
    private int _projectContextGeneration;
    private bool _loading;
    private bool _editing;
    private bool _draftDirty;
    private bool _settingDraft;
    private bool _saving;
    private bool _closingAfterSave;
    private bool _closeApproved;
    private bool _closeQueued;
    private bool _shutdownStarted;
    private bool _switchingRuntime;
    private bool _refreshingCapabilities;
    private ImmutableArray<LibraryRecord> _historicalScopeRecords = [];
    private string? _historicalScopeSummary;
    private bool _disposed;
    private bool _compact;
    private bool _showingCompactDetail;
    private readonly System.Windows.Threading.DispatcherTimer _filterTimer;
    private readonly CancellationTokenSource _lifetime = new();

    public MainWindow(string configPath, string? initialProjectId, string? initialRecordId,
        string? journalRoot = null)
    {
        InitializeComponent();
        _configPath = Path.GetFullPath(configPath);
        _journalRoot = journalRoot;
        _initialProjectId = initialProjectId;
        _initialRecordId = initialRecordId;
        _filterTimer = new() { Interval = TimeSpan.FromMilliseconds(50) };
        _filterTimer.Tick += (_, _) => { _filterTimer.Stop(); ApplyFilters(); };
        ProjectSort.SelectedIndex = 0;
        EditAvailability.ItemsSource = new[] { "known", "known_empty", "unavailable", "unknown", "stale" };
        KindFilter.ItemsSource = new[] { "All kinds" };
        AvailabilityFilter.ItemsSource = new[] { "All availability", "known", "known_empty", "unavailable", "unknown", "stale" };
        LifecycleFilter.ItemsSource = new[] { "All lifecycle", "current", "historical", "superseded" };
        KindFilter.SelectedIndex = AvailabilityFilter.SelectedIndex = LifecycleFilter.SelectedIndex = 0;
        var rowTemplate = (DataTemplate)FindResource("WrappedListRow");
        foreach (var list in new[] { ActivityList, WorkList, DecisionList,
            RejectionList, SpecialList }) list.ItemTemplate = rowTemplate;
        InitializeOperatorConsole();
        SetDetailActions(false);
        DetailText.Text = "Select a record to read its content, source, history, and supported corrections.";
        SetStatus("Connecting to the selected Lodestar runtime…");
    }

    public async Task InitializeAsync()
    {
        try
        {
            var runtime = await LodestarService.LoadRuntimeAsync(_configPath, _lifetime.Token);
            App.ConfigureDiagnostics(runtime);
            _service = new(runtime, _journalRoot);
            await RefreshAsync();
            if (_initialProjectId is { } id)
            {
                var row = ProjectList.Items.OfType<ProjectRow>().FirstOrDefault(x => x.Project.Id == id);
                if (row is not null) { ProjectList.SelectedItem = row; await SelectProjectAsync(row.Project); }
                else SetStatus("Requested project ID is not in the loaded catalog: " + id);
            }
            if (_initialRecordId is { } recordId)
            {
                var record = _library?.Records.FirstOrDefault(x => x.Id == recordId);
                if (record is not null) await SelectRecordAsync(record);
                else if (_library?.Issues.FirstOrDefault(x => x.Id == recordId) is { } issue)
                    await SelectIssueAsync(issue);
                else SetStatus("Requested record ID is not in the loaded view: " + recordId);
            }
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.Startup, error); ShowStartupError(error); }
    }

    public void ShowStartupError(Exception error)
    {
        _loading = false;
        _library = null; _project = null; _selectedRecord = null; _detail = null;
        _doctorResult = null; _doctorReadAt = null;
        ProjectList.ItemsSource = Array.Empty<object>();
        LibraryFoot.Text = "No loaded catalog";
        LibraryCaption.Text = "PROJECT LIBRARY";
        _workspace = "connection";
        ConfigureWorkspace();
        PageTitle.Text = "Connection needed";
        PageSubtitle.Text = "Select a valid interfaces.json and refresh. No database was created.";
        CoverageText.Text = "No successful library read from this connection.";
        DetailTitle.Text = "Connection error";
        DetailText.Text = error.Message;
        SpecialList.ItemsSource = new object[] { new NoteRow("Connection failed: " + error.Message),
            new NoteRow("Select a valid interfaces.json. The selected database was not initialized or changed.") };
        MetricOne.Text = "Runtime unavailable"; MetricTwo.Text = "No catalog read"; MetricThree.Text = "No service";
        RenderHealth();
        ShowDetailPane();
        SetStatus("Connection failed · " + error.Message);
    }

    public object StartupDiagnostics(long uiReadyElapsedMilliseconds)
    {
        using var process = Process.GetCurrentProcess();
        process.Refresh();
        var heap = GC.GetGCMemoryInfo();
        return new
        {
            v = 1, capturedAt = DateTimeOffset.UtcNow, uiReadyElapsedMilliseconds,
            ready = _library is { Error: null, Complete: true },
            memory = new { managedBytes = GC.GetTotalMemory(false), heapSizeBytes = heap.HeapSizeBytes,
                fragmentedBytes = heap.FragmentedBytes, workingSetBytes = process.WorkingSet64,
                privateBytes = process.PrivateMemorySize64 },
            libraryLoad = _service?.LastLibraryLoadDiagnostics,
            library = new { complete = _library?.Complete, catalogOnly = _library?.CatalogOnly,
                projects = _library?.Projects.Length, currentRecords = _library?.Records.Length,
                databaseInstanceId = _library?.DatabaseInstanceId, databaseEpoch = _library?.DatabaseEpoch,
                revision = _library?.Revision }
        };
    }

    private async Task<RefreshOutcome> RefreshAsync(bool afterSave = false)
    {
        var service = _service;
        RefreshOutcome Incomplete(string reason) => new(false, _library?.Revision, _library?.ReadAt, reason);
        if (service is null || _loading || _switchingRuntime || (_saving && !afterSave))
            return Incomplete("Library refresh could not start. Select Refresh when the current operation finishes.");
        if (_editing)
        {
            const string reason = "Draft retained. Save or discard it before refreshing the library.";
            SetStatus(reason);
            return Incomplete(reason);
        }
        var previousProject = _project?.Id;
        var previousRecord = _selectedRecord?.Id;
        var previousIssue = _selectedIssue?.Id;
        ++_generation;
        ++_projectContextGeneration;
        _loading = true;
        SetStatus("Reading capability descriptions and project library…");
        RefreshButton.IsEnabled = false;
        ProjectList.IsEnabled = DashboardList.IsEnabled = RecordList.IsEnabled = HealthActivity.IsEnabled = SpecialList.IsEnabled = false;
        bool IsCurrentService() => !_disposed && !_lifetime.IsCancellationRequested &&
            ReferenceEquals(_service, service);
        try
        {
            await service.DiscoverAsync(cancellation: _lifetime.Token);
            if (!IsCurrentService()) return Incomplete("Runtime changed during library refresh.");
            var loaded = await service.LoadLibraryAsync(_lifetime.Token, catalog =>
            {
                if (!IsCurrentService() || !catalog.CatalogOnly || service.LastCompleteLibrary is not null) return;
                _library = catalog;
                _project = null; _context = null;
                _historicalProjects = [];
                _historicalLoaded = false;
                ProjectList.IsEnabled = DashboardList.IsEnabled = false;
                ApplyFilters();
                ConfigureWorkspace();
                SetStatus($"Catalog ready · {catalog.Projects.Length:N0} projects · records loading · revision {catalog.Revision?.ToString() ?? "unknown"}");
            });
            if (!IsCurrentService()) return Incomplete("Runtime changed during library refresh.");
            _library = loaded;
            _recordSearchCache.Clear();
            _historicalProjects = [];
            _historicalLoaded = false;
            _historicalScopeRecords = [];
            _historicalScopeSummary = null;
            _context = null;
            if (HistoryToggle.IsChecked == true && loaded.Error is null)
                await LoadHistoricalProjectsAsync();
            if (!IsCurrentService()) return Incomplete("Runtime changed during library refresh.");
            if (loaded.Error is not null) SetStatus("Library refresh incomplete · " + loaded.Error);
            else SetStatus($"Read {loaded.LoadedCount:N0} rows · {(loaded.Complete ? "complete" : "partial")} · revision {loaded.Revision?.ToString() ?? "unknown"}");
            if (previousProject is not null)
                _project = loaded.Projects.Concat(_historicalProjects).FirstOrDefault(x => x.Id == previousProject);
            ApplyFilters();
            if (_project is not null)
            {
                ConfigureWorkspace();
                await ValidateContextAsync(_project);
            }
            else ConfigureWorkspace();
            await RestoreSelectionAfterLibraryReadAsync(loaded, previousRecord, previousIssue);
            UpdateFooter();
            RenderHealth();
            return new(loaded.Error is null && loaded.Complete, loaded.Revision, loaded.ReadAt,
                loaded.Error ?? (loaded.Complete ? null : "Library read returned partial coverage."));
        }
        catch (OperationCanceledException)
        {
            if (IsCurrentService()) SetStatus("Read cancelled.");
            return Incomplete("Library read was cancelled.");
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.LibraryLoad, error);
            if (IsCurrentService()) SetStatus("Refresh failed · " + error.Message);
            return Incomplete("Library refresh failed: " + error.Message);
        }
        finally
        {
            _loading = false;
            _allowLoadNavigation = false;
            if (IsCurrentService())
            {
                RefreshButton.IsEnabled = true;
                ProjectList.IsEnabled = DashboardList.IsEnabled = RecordList.IsEnabled = HealthActivity.IsEnabled = SpecialList.IsEnabled = true;
                ConfigureRecordWorkspace();
                UpdateContinueState();
            }
        }
    }

    private async Task RestoreSelectionAfterLibraryReadAsync(LibrarySnapshot loaded,
        string? recordId, string? issueId)
    {
        if (_editing || (recordId ?? issueId) is not { } id) return;
        var record = loaded.Records.Concat(loaded.Projects.Select(project => project.CatalogRecord))
            .FirstOrDefault(item => item.Id == id);
        var issue = loaded.Issues.IsDefaultOrEmpty ? null : loaded.Issues.FirstOrDefault(item => item.Id == id);
        if (record is not null || issue is not null)
        {
            _allowLoadNavigation = true;
            try
            {
                if (record is not null) await SelectRecordAsync(record);
                else await SelectIssueAsync(issue!);
            }
            finally { _allowLoadNavigation = false; }
        }
        else if (loaded.Complete && loaded.Error is null && !loaded.CatalogOnly)
        {
            ClearDetailForNavigation();
            DetailTitle.Text = "Record absent from refreshed library";
            DetailMeta.Text = id + " · complete revision " + loaded.Revision;
            DetailText.Text = "The complete refreshed library no longer contains " + id +
                ". Its previous detail and edit basis were cleared. Select a current record to continue.";
            ShowDetailPane();
            SetStatus(id + " absent from complete refreshed library · revision " + loaded.Revision);
        }
    }

    private void UpdateFooter()
    {
        if (_library is null) return;
        if (_library.CatalogOnly)
        {
            LibraryFoot.Text = $"{_library.Projects.Length} current projects · records loading · catalog-only coverage\nCatalog read {_library.ReadAt.ToLocalTime():g}";
            CoverageText.Text = $"Project catalog ready · database {_library.DatabaseInstanceId ?? "unknown"} · epoch {_library.DatabaseEpoch ?? "unknown"} · revision {_library.Revision?.ToString() ?? "unknown"} · current records loading";
            return;
        }
        LibraryFoot.Text = $"{_library.Projects.Length} current projects" +
            (HistoryToggle.IsChecked == true && _historicalLoaded ? $" + {_historicalProjects.Length} historical" : "") +
            $" · {_library.GlobalKnowledge.Length} global · " +
            $"{(_library.Complete ? "complete" : "partial coverage")}\nRead {_library.ReadAt.ToLocalTime():g}";
        CoverageText.Text = $"Recorded data · revision {_library.Revision?.ToString() ?? "unknown"} · " +
            $"read {_library.ReadAt.ToLocalTime():g} · {(_library.Complete ? "complete snapshot" : "incomplete snapshot")}" +
            (_library.RecordErrors.Length > 0 ? $" · {_library.RecordErrors.Length} normalization errors" : "");
    }

    private void ApplyFilters()
    {
        if (_library is null) return;
        var search = SearchBox.Text.Trim();
        var projects = (HistoryToggle.IsChecked == true
            ? _library.Projects.Concat(_historicalProjects) : _library.Projects).AsEnumerable();
        if (search.Length > 0)
            projects = projects.Where(p => p.Name.Contains(search, StringComparison.CurrentCultureIgnoreCase) ||
                p.Id.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                (p.RecordedStatus?.Contains(search, StringComparison.CurrentCultureIgnoreCase) ?? false) ||
                SearchText(p.CatalogRecord).Contains(search, StringComparison.CurrentCultureIgnoreCase));
        projects = (_projectSortPath, _projectSortDirection) switch
        {
            ("UpdatedAt", ListSortDirection.Descending) => projects.OrderByDescending(p => p.LatestCurrentUpdate)
                .ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase),
            ("UpdatedAt", _) => projects.OrderBy(p => p.LatestCurrentUpdate)
                .ThenBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase),
            ("Status", ListSortDirection.Descending) => projects.OrderByDescending(p => p.RecordedStatus,
                StringComparer.CurrentCultureIgnoreCase),
            ("Status", _) => projects.OrderBy(p => p.RecordedStatus, StringComparer.CurrentCultureIgnoreCase),
            ("CountValue", ListSortDirection.Descending) => projects.OrderByDescending(p => p.CurrentRecordCount),
            ("CountValue", _) => projects.OrderBy(p => p.CurrentRecordCount),
            ("Name", ListSortDirection.Descending) => projects.OrderByDescending(p => p.Name,
                StringComparer.CurrentCultureIgnoreCase),
            _ => projects.OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase)
        };
        var rows = projects.Select(p => {
            var historical = p.CatalogRecord.Lifecycle is "historical" or "superseded";
            var status = p.RecordedStatus ?? "Not recorded";
            var loading = _library.CatalogOnly && !historical;
            var update = loading ? "Loading" : (historical ? p.CatalogRecord.UpdatedAt : p.LatestCurrentUpdate)
                ?.ToLocalTime().ToString("g") ?? "Unknown";
            var count = loading ? "Loading" : historical ? "—" : p.CurrentRecordCount.ToString(CultureInfo.CurrentCulture);
            return new ProjectRow(p, p.Name,
                historical ? $"Historical · {status} · count unavailable · saved {update}" :
                    loading ? $"{status} · records loading · latest update loading" :
                    $"{status} · {count} {(p.CurrentRecordCount == 1 ? "record" : "records")} · {update}",
                status, update, count);
        })
            .ToArray();
        var issues = _library.Issues.Where(i => search.Length == 0 ||
            (i.Id?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false) ||
            i.Message.Contains(search, StringComparison.CurrentCultureIgnoreCase))
            .Select(i => new ProjectIssueRow(i, i.Id ?? "Unknown ID", "Needs correction · " + Trim(i.Message, 110)))
            .ToArray();
        var selectedId = _project?.Id;
        _suppressSelection = true;
        try
        {
            ProjectList.ItemsSource = rows.Cast<object>().Concat(issues).ToArray();
            if (selectedId is not null) ProjectList.SelectedItem = rows.FirstOrDefault(r => r.Project.Id == selectedId);
            DashboardList.ItemsSource = rows;
            ApplyProjectView();
        }
        finally { _suppressSelection = false; }
        if (_project is null && search.Length > 0 && rows.Length + issues.Length == 0)
        {
            OverviewText.Text = "No loaded project or correction item matches ‘" + search + "’. Clear Search to return to the library.";
            OverviewList.ItemsSource = Array.Empty<object>();
        }
        else if (_project is null)
        {
            OverviewText.Text = _library.CatalogOnly ?
                "Project catalog ready. Current records, dates, and counts are loading." :
                "Loaded projects · status from project data.status · latest saved current-record update. Select a row to open its workspace.";
            OverviewList.ItemsSource = Array.Empty<object>();
        }
        LibraryCaption.Text = search.Length > 0 && rows.Length + issues.Length == 0 ? "NO MATCHING PROJECTS" :
            $"PROJECT LIBRARY · {rows.Length}" + (issues.Length > 0 ? $" · {issues.Length} needs correction" : "") +
            (HistoryToggle.IsChecked == true ? " · history included" : "");
        if (_project is null && _workspace == "projects")
        {
            MetricOne.Text = $"{rows.Length} {(search.Length > 0 ? "matching" : "visible")} projects";
            MetricTwo.Text = $"{issues.Length} needs correction";
            MetricThree.Text = _library.CatalogOnly ? "Records loading" :
                _library.Complete ? "Complete loaded view" : "Partial coverage";
        }
        if (_workspace == "search") FillAllRecords(); else FillProjectLists();
        if (_workspace == "global") FillSpecial(_library.GlobalKnowledge);
        if (_workspace == "commands") FillCommands();
        if (_workspace == "health") RenderHealthActivity();
        UpdateFooter();
    }

    private IEnumerable<LibraryRecord> AssociatedRecords(ProjectSummary? project)
    {
        if (_library is null || project is null) return [];
        if (project.CatalogRecord.Lifecycle is "historical" or "superseded")
            return [project.CatalogRecord];
        var associated = RecordProjection.AssociatedRecords(_library, project);
        return associated.Any(record => record.Id == project.Id) ? associated :
            associated.Prepend(project.CatalogRecord);
    }

    private void FillProjectLists()
    {
        if (_workspace == "search") { FillAllRecords(); return; }
        if (_library is null || _project is null) return;
        var records = AssociatedRecords(_project).ToArray();
        var historical = _project.CatalogRecord.Lifecycle is "historical" or "superseded";
        var search = SearchBox.Text.Trim();
        IEnumerable<LibraryRecord> filtered = records;
        if (KindFilter.SelectedItem is string kind && kind != "All kinds") filtered = filtered.Where(r => r.Kind == kind);
        if (AvailabilityFilter.SelectedItem is string availability && availability != "All availability") filtered = filtered.Where(r => r.Availability == availability);
        if (LifecycleFilter.SelectedItem is string lifecycle && lifecycle != "All lifecycle") filtered = filtered.Where(r => (r.Lifecycle ?? "current") == lifecycle);
        if (search.Length > 0) filtered = filtered.Where(r => Matches(r, search));
        _suppressSelection = true;
        try
        {
            RecordList.ItemsSource = Rows(filtered);
            OverviewList.ItemsSource = Rows(records.OrderByDescending(r => r.UpdatedAt).Take(12));
            ApplyRecordView();
        }
        finally { _suppressSelection = false; }
        _suppressSelection = true;
        try
        {
            var activity = Rows(records.OrderByDescending(r => r.UpdatedAt)).Cast<object>().ToList();
            if (_historicalScopeSummary is not null)
            {
                activity.Add(new NoteRow(_historicalScopeSummary));
                activity.AddRange(Rows(_historicalScopeRecords.OrderByDescending(r => r.UpdatedAt)));
            }
            ActivityList.ItemsSource = activity.Count == 0 ? [new NoteRow("No dated recorded activity in this loaded view.")] : activity;
            HistoricalScopeButton.IsEnabled = _context?.Matched == true && !_context.HistoricalScopes.IsDefaultOrEmpty;
            HistoricalScopeButton.ToolTip = HistoricalScopeButton.IsEnabled ? "Read explicitly mapped historical scopes" :
                _context?.Error ?? "No verified historical scope is available for this project.";
            WorkList.ItemsSource = RowsOrNote(records.Where(r => r.Kind is "work" or "handoff" or "handoff-packet"),
                "No recorded work or handoff in this loaded view. This does not describe live process activity.");
            DecisionList.ItemsSource = RowsOrNote(records.Where(r => r.Kind is "decision-event" or "pending"),
                "No recorded decision events or pending items in this loaded view.");
            RejectionList.ItemsSource = RowsOrNote(records.Where(r => r.Kind.Contains("rejection", StringComparison.OrdinalIgnoreCase)),
                "No rejection records in this loaded view.");
        }
        finally { _suppressSelection = false; }
        var selectedKind = KindFilter.SelectedItem as string ?? "All kinds";
        var kinds = new[] { "All kinds" }.Concat(records.Select(r => r.Kind).Distinct().Order()).ToArray();
        if (KindFilter.ItemsSource is not IEnumerable<string> priorKinds || !priorKinds.SequenceEqual(kinds))
        {
            KindFilter.ItemsSource = kinds;
            KindFilter.SelectedItem = kinds.Contains(selectedKind) ? selectedKind : "All kinds";
        }
        RecordList.ToolTip = $"{RecordList.Items.Count:N0} matching records in loaded project coverage";
        RecordResultCount.Text = $"{RecordList.Items.Count:N0} rows";
        OverviewText.Text = (historical ? "Historical project catalog entry · historical records are not part of current counts.\n" : "") +
            $"Recorded status: {_project.RecordedStatus ?? "No project status recorded"} (project data.status)\n" +
            $"{_project.CurrentRecordCount} loaded current records · {_project.RecordedOpenWorkCount} recorded open work · " +
            $"latest current-record update {_project.LatestCurrentUpdate?.ToLocalTime().ToString("g") ?? "unknown"}\n" +
            $"Roots: {(_project.Roots.IsDefaultOrEmpty ? "none recorded" : string.Join(" · ", _project.Roots))}\n" +
            $"Work outcomes: {records.Count(r => r.Kind == "work")} work records · " +
            $"handoffs: {records.Count(r => r.Kind is "handoff" or "handoff-packet")} · " +
            $"rejections: {records.Count(r => r.Kind.Contains("rejection", StringComparison.OrdinalIgnoreCase))}";
        MetricOne.Text = historical ? "Historical catalog entry" :
            $"{_project.CurrentRecordCount} {(_project.CurrentRecordCount == 1 ? "record" : "records")}";
        MetricTwo.Text = historical ? "Current counts unavailable" : $"{_project.RecordedOpenWorkCount} recorded open work";
        MetricThree.Text = historical ? $"Saved {_project.CatalogRecord.UpdatedAt?.ToLocalTime().ToString("g") ?? "unknown"}" :
            $"Latest {_project.LatestCurrentUpdate?.ToLocalTime().ToString("g") ?? "unknown"}";
        PageTitle.Text = _project.Name;
        PageSubtitle.Text = $"{_project.RecordedStatus ?? "No project status recorded"} · project data.status · " +
            $"{(_context?.Matched == true ? "root verified" : _context?.Error ?? "root not checked")}";
        DashboardPanel.Visibility = Visibility.Collapsed;
        OverviewList.Visibility = Visibility.Visible;
    }

    private bool Matches(LibraryRecord r, string search) =>
        r.Id.Contains(search, StringComparison.OrdinalIgnoreCase) ||
        (r.Name?.Contains(search, StringComparison.CurrentCultureIgnoreCase) ?? false) ||
        SearchText(r).Contains(search, StringComparison.CurrentCultureIgnoreCase);

    private string SearchText(LibraryRecord record)
    {
        if (_recordSearchCache.TryGetValue(record, out var text)) return text;
        text = record.Json.GetRawText();
        _recordSearchCache[record] = text;
        return text;
    }

    private Task LoadHistoricalProjectsAsync()
    {
        if (_library is null) return Task.CompletedTask;
        var currentIds = _library.Projects.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        _historicalProjects = _library.HistoricalProjects
            .Where(r => !currentIds.Contains(r.Id))
            .DistinctBy(r => r.Id).Select(HistoricalSummary).ToImmutableArray();
        _historicalLoaded = true;
        SetStatus($"Historical catalog loaded · {_historicalProjects.Length} additional project IDs");
        ApplyFilters();
        return Task.CompletedTask;
    }

    private static ProjectSummary HistoricalSummary(LibraryRecord record)
    {
        var data = JsonData.Property(record.Json, "data");
        var roots = data is { ValueKind: JsonValueKind.Object } && JsonData.TryArray(data.Value, "roots", out var values)
            ? values.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String).Select(x => x.GetString()!).ToImmutableArray()
            : ImmutableArray<string>.Empty;
        var scopes = new List<string>();
        if (RecordProjection.ApplicabilityProject(record.Json) is { } project) scopes.Add(project);
        if (record.Scope != "global") scopes.Add(record.Scope);
        return new(record.Id, record.Name ?? record.Id,
            data is { ValueKind: JsonValueKind.Object } ? JsonData.String(data.Value, "status") : null,
            roots, scopes.Distinct(StringComparer.Ordinal).ToImmutableArray(), 0, 0,
            record.UpdatedAt, record.Id, false, record);
    }

    private static RecordRow ToRow(LibraryRecord r) => new(r, r.Name ?? r.Id,
        $"{r.Kind} · {r.Availability ?? "availability unknown"} · " +
        $"{r.UpdatedAt?.ToLocalTime().ToString("g") ?? "date unknown"} · {Trim(RecordProjection.DescribeRecord(r), 125)}");

    private static RecordRow[] Rows(IEnumerable<LibraryRecord> records) => records.Select(ToRow).ToArray();

    private static object[] RowsOrNote(IEnumerable<LibraryRecord> records, string empty)
    {
        var rows = Rows(records);
        return rows.Length == 0 ? [new NoteRow(empty)] : rows.Cast<object>().ToArray();
    }

    private static string Trim(string value, int length) => value.Length > length ? value[..length] + "…" : value;
    private void SetStatus(string value)
    {
        var notice = App.Diagnostics.Status.Notice;
        StatusText.Text = notice is null || value.Contains(notice, StringComparison.Ordinal)
            ? value : value + " " + notice;
    }

    internal void ShowDiagnosticNotice() => SetStatus(StatusText.Text);

    private void ConfigureWorkspace()
    {
        SearchPlaceholder.Text = _workspace == "commands" ? "Command or question…" : "Search loaded items…";
        SearchBox.ToolTip = _workspace == "commands" ? "Search core questions and commands" : "Search the loaded view";
        UpdateProjectNavigation();
        HealthButton.Tag = _workspace == "health" ? "active" : null;
        UpdateProjectNavigationTags();
        GlobalButton.Tag = _workspace == "global" ? "active" : null;
        CommandsButton.Tag = _workspace == "commands" ? "active" : null;
        RecoveryButton.Tag = _workspace == "recovery" ? "active" : null;
        HealthPanel.Visibility = _workspace == "health" ? Visibility.Visible : Visibility.Collapsed;
        MainTabs.Visibility = _workspace is "projects" or "search" ? Visibility.Visible : Visibility.Collapsed;
        SpecialPanel.Visibility = _workspace is not ("projects" or "health" or "search") ? Visibility.Visible : Visibility.Collapsed;
        RunCommandButton.Visibility = _workspace == "commands" && _operation is { } selectedOperation &&
            (SafeGeneric(selectedOperation) || IsIntentRead(selectedOperation)) ? Visibility.Visible : Visibility.Collapsed;
        RunCommandInspectorButton.Visibility = RunCommandButton.Visibility;
        ReplayButton.Visibility = _workspace == "recovery" && _pending is not null ? Visibility.Visible : Visibility.Collapsed;
        ReplayInspectorButton.Visibility = ReplayButton.Visibility;
        RefreshCapabilitiesButton.Visibility = _workspace is "commands" or "connection" ? Visibility.Visible : Visibility.Collapsed;
        RefreshCapabilitiesTopButton.Visibility = _workspace == "connection" ? Visibility.Visible : Visibility.Collapsed;
        SelectRuntimeButton.Visibility = _workspace == "connection" ? Visibility.Visible : Visibility.Collapsed;
        SelectRuntimeTopButton.Visibility = SelectRuntimeButton.Visibility;
        if (_workspace == "health")
        {
            RenderHealth();
        }
        else if (_workspace == "search") FillAllRecords();
        else if (_workspace == "projects")
        {
            Eyebrow.Text = _project is null ? "PROJECT LIBRARY" : "PROJECT RECORDS";
            if (_project is null)
            {
                PageTitle.Text = "Projects";
                PageSubtitle.Text = _library?.CatalogOnly == true ?
                    "Project catalog ready. Current records are loading." :
                    _library?.Projects.Length == 0 ? "Create your first project, then add knowledge and decisions." :
                    "Select a project to inspect its recorded knowledge.";
                MetricOne.Text = $"{_library?.Projects.Length ?? 0} projects";
                MetricTwo.Text = $"{_library?.Issues.Length ?? 0} needs correction";
                MetricThree.Text = _library?.CatalogOnly == true ? "Records loading" :
                    _library?.Complete == true ? "Complete loaded view" : "Partial coverage";
                OverviewText.Text = _library?.CatalogOnly == true ?
                    "Project catalog ready. Current records, dates, and counts are loading." :
                    "Loaded projects · status from project data.status · latest saved current-record update. Select a row to open its workspace.";
                DashboardPanel.Visibility = Visibility.Visible;
                OverviewList.Visibility = Visibility.Collapsed;
                ApplyFilters();
            }
            else FillProjectLists();
        }
        else
        {
            Eyebrow.Text = "LODESTAR";
            switch (_workspace)
            {
                case "global":
                    PageTitle.Text = "Global knowledge";
                    PageSubtitle.Text = _library?.CatalogOnly == true ?
                        "Project catalog ready; global records are loading." :
                        "Records without an exact project mapping. Ambiguous records remain separate.";
                    FillSpecial(_library?.GlobalKnowledge ?? []);
                    break;
                case "commands":
                    PageTitle.Text = "Commands / questions";
                    PageSubtitle.Text = "Search a command or question, for example research, evidence, remaining work or decisions. Select a result for guidance and typed inputs.";
                    FillCommands();
                    break;
                case "recovery":
                    PageTitle.Text = "Pending saves";
                    PageSubtitle.Text = "Inspect unresolved or incomplete journals. Eligible requests can be replayed with their exact saved identity.";
                    FillRecovery();
                    break;
                case "connection":
                    PageTitle.Text = "Connection";
                    PageSubtitle.Text = "Exact selected runtime and last read. Selecting a config does not install or initialize anything.";
                    FillConnection();
                    break;
                case "record-errors":
                    PageTitle.Text = "Record errors";
                    PageSubtitle.Text = "Normalization errors and correction items from the loaded library.";
                    FillRecordErrors();
                    break;
            }
            MetricOne.Text = _workspace == "global" ? _library?.CatalogOnly == true ?
                "Global records loading" : $"{_library?.GlobalKnowledge.Length ?? 0} global records" : "Selected runtime";
            MetricTwo.Text = _workspace == "global" ? _library?.CatalogOnly == true ?
                "Unassigned records loading" : $"{_library?.Unassigned.Length ?? 0} unassigned" : "One-shot CLI";
            MetricThree.Text = _workspace == "global" ? $"{_library?.Issues.Length ?? 0} needs correction" : "No resident service";
        }
        ConfigureRecordWorkspace();
        UpdateDomainActions();
        UpdateFooter();
        UpdateContinueState();
    }

    private void UpdateDomainActions()
    {
        var enabled = _project is not null && _context?.Matched == true;
        RefreshAttentionButton.IsEnabled = enabled && _service?.SupportsOperatorRead("work.attention") == true;
        RefreshAttentionButton.ToolTip = RefreshAttentionButton.IsEnabled ? "Explicitly read one coherent database observation and a separate recovery observation" : "Selected core does not support this action, or the project root needs verification.";
        if (_attentionProjectId != _project?.Id) {
            _attentionGeneration++; _attentionProjectId = null;
            AttentionText.Text = "Project attention has not been read for this project. Select Refresh attention.";
            AttentionRecoveryText.Text = "Recovery observation is separate from database attention. Global Recovery retains uncertain requests.";
            AttentionReadChoices.ItemsSource = null;
            AttentionIntentChoices.ItemsSource = ProjectIntents().Select(record => new IntentChoice(record.Id, record.Name ?? record.Id)).Prepend(new IntentChoice(null, "Choose intent / no selection")).ToArray();
            AttentionIntentChoices.SelectedIndex = 0;
        }
        foreach (var button in new[] { WorkStatusButton, WorkHistoryButton, HandoffStatusButton,
            HandoffHistoryButton, DecisionStreamButton, PendingItemsButton })
        {
            button.IsEnabled = enabled;
            button.ToolTip = enabled ? "Read the selected project's recorded domain state" :
                _context?.Error ?? "Select a project with a verified root for this read.";
        }
        HistoricalScopeButton.IsEnabled = enabled && _context is { HistoricalScopes.IsDefaultOrEmpty: false };
        HistoricalScopeButton.ToolTip = HistoricalScopeButton.IsEnabled ? "Read explicitly mapped historical scopes" :
            _context?.Error ?? "No verified historical scope is available for this project.";
    }

    private void ClearDetailForNavigation()
    {
        ++_generation;
        _inspectorActive = false;
        _showingCompactDetail = false;
        ApplyResponsiveLayout();
        _selectedRecord = null; _selectedIssue = null; _detail = null; _operation = null; _pending = null;
        ApplyResponsiveLayout();
        SetDetailActions(false);
        ReadoutSections.ItemsSource = null;
        DetailTitle.Text = "Select an item";
        DetailMeta.Text = "Recorded details and evidence appear here.";
        DetailText.Text = "Choose a row or a read action to inspect its recorded content.";
        RunCommandButton.Visibility = ReplayButton.Visibility = Visibility.Collapsed;
        RunCommandInspectorButton.Visibility = ReplayInspectorButton.Visibility = Visibility.Collapsed;
    }

    private void FillSpecial(IEnumerable<LibraryRecord> records)
    {
        var search = SearchBox.Text.Trim();
        var items = records.Where(r => search.Length == 0 || Matches(r, search)).Select(r => (object)
            new RecordRow(r, r.Name ?? r.Id, $"{r.Kind} · {r.Scope} · {Trim(RecordProjection.DescribeRecord(r), 110)}")).ToList();
        if (_workspace == "global" && _library?.CatalogOnly == true)
            items.Add(new NoteRow("Project catalog ready; global and unassigned records are still loading."));
        else if (_workspace == "global" && _library is not null)
        {
            items.Add(new NoteRow($"Unassigned / ambiguous · {_library.Unassigned.Length} records"));
            items.AddRange(_library.Unassigned.Where(r => search.Length == 0 || Matches(r, search))
                .Select(r => (object)new RecordRow(r, r.Name ?? r.Id, "Unassigned · " + r.Scope)));
            items.AddRange(_library.Issues.Select(i => (object)new IssueRow(i)));
        }
        if (items.Count == 0) items.Add(new NoteRow("No records in this loaded view."));
        _suppressSelection = true;
        try { SpecialList.ItemsSource = items; }
        finally { _suppressSelection = false; }
    }

    private void FillCommands()
    {
        var search = SearchBox.Text.Trim();
        var operations = _service?.Capabilities?.Operations ?? [];
        _suppressSelection = true;
        try
        {
            var rows = operations.Where(o => search.Length == 0 ||
                o.Id.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                o.Summary.Contains(search, StringComparison.CurrentCultureIgnoreCase) ||
                CommandQuestionText(o).Contains(search, StringComparison.CurrentCultureIgnoreCase))
                .OrderBy(o => SafeGeneric(o) ? 0 : IsProjectDomainRead(o) ? 1 : 2)
                .ThenBy(o => o.Id, StringComparer.OrdinalIgnoreCase)
                .Select(o => (object)new CommandRow(o));
            const string recoveryQuestions = "Did my save complete? pending saves save outcome recovery receipt";
            SpecialList.ItemsSource = (search.Length == 0 || recoveryQuestions.Contains(search, StringComparison.CurrentCultureIgnoreCase)
                ? rows.Append(new RecoveryQuestionRow()) : rows).ToArray();
        }
        finally { _suppressSelection = false; }
        if (operations.IsDefaultOrEmpty && _service?.Capabilities?.Error is { } error)
            DetailText.Text = error;
        SearchPlaceholder.Text = "Command or question…";
        SearchBox.ToolTip = "Search the core's questions and commands; for example research, evidence, work remains or decided.";
    }

    private static string CommandQuestionText(CapabilityOperation operation) =>
        JsonData.TryArray(operation.Description, "questions", out var questions)
            ? string.Join("\n", questions.EnumerateArray().Where(question => question.ValueKind == JsonValueKind.String)
                .Select(question => question.GetString())) : "";

    private void FillRecovery()
    {
        var listing = _service?.ReadPendingSaves();
        var pending = listing?.Items ?? [];
        if (listing?.Error is { } error)
        {
            var notice = error + " Journal root: " + listing.JournalRoot;
            PageSubtitle.Text = "Pending saves read failed. Previous items remain listed when available.";
            SpecialList.ItemsSource = new object[] { new NoteRow(notice) }
                .Concat(pending.Select(x => (object)new PendingRow(x))).ToArray();
            DetailTitle.Text = "Pending saves needs attention";
            DetailMeta.Text = listing.Category ?? "journal_read_failed";
            DetailText.Text = notice;
            SetStatus(notice);
            ShowDetailPane();
            return;
        }
        SpecialList.ItemsSource = pending.Count > 0 ? pending.Select(x => (object)new PendingRow(x)).ToArray() :
            [new NoteRow("No unresolved journaled saves.")];
    }

    private void FillConnection()
    {
        var runtime = _service?.Runtime;
        var capability = _service?.Capabilities;
        DetailTitle.Text = "Exact runtime";
        DetailMeta.Text = runtime?.ConfigPath ?? _configPath;
        DetailText.Text = runtime is null ? "No valid runtime is selected." :
            $"Configuration\n{runtime.ConfigPath}\nGeneration  {runtime.Generation}\n\n" +
            $"Node executable\n{runtime.NodePath}\nVersion  {NodeVersion(runtime.NodePath)}\n\n" +
            $"Lodestar CLI\n{runtime.CliPath}\nPackage version  {CoreVersion(runtime.CliPath)}\n\n" +
            $"Reported release  {capability?.ReleaseVersion ?? "unavailable"}\nContract support  {capability?.ContractVersion?.ToString() ?? "unavailable"}\nSchema support  {capability?.SchemaVersion?.ToString() ?? "unavailable"}\n" +
            $"Core source digest (SHA-256)\n{runtime.CoreSourceDigest ?? "unavailable"}\nBasis  {runtime.CoreSourceBasis ?? "unavailable"}\n" +
            (runtime.CoreSourceBasis == "verified_manifest_core" ? "Verified manifest core entries only; full bundle and installed hooks not checked.\n\n" : "Source bytes observed; packaged payload unverified.\n\n") +
            LoaderIdentity() + "\n\n" +
            $"Database\n{runtime.DatabasePath}\n\nRuntime fingerprint\n{runtime.Fingerprint}\n\n" +
            $"Capability contract  {capability?.Version?.ToString() ?? "unavailable"}\n" +
            $"Last capability read  {capability?.ReadAt.ToLocalTime().ToString("g") ?? "unknown"}\n" +
            $"Database instance  {_library?.DatabaseInstanceId ?? "unknown"}\n" +
            $"Database epoch  {_library?.DatabaseEpoch ?? "unknown"}\n" +
            $"Observed database revision  {_library?.Revision?.ToString() ?? "unknown"}\n" +
            $"Last library read  {_library?.ReadAt.ToLocalTime().ToString("g") ?? "none"}\n" +
            $"Runtime issue  {capability?.Error ?? "none"}";
        var diagnosticStatus = App.Diagnostics.Status;
        DetailText.Text += "\n\nLocal diagnostics\nFolder  " + App.Diagnostics.RootPath;
        DetailText.Text += diagnosticStatus.Summary is { } diagnostic
            ? $"\n\nLatest local diagnostic\n{diagnostic.Timestamp.ToLocalTime():g} · {diagnostic.Operation}\n" +
              $"{diagnostic.ExceptionType}\nEvent {diagnostic.EventId}\n{diagnostic.Path}"
            : diagnosticStatus.Availability == DiagnosticAvailability.Empty ? "\nNo recorded diagnostic event." : "";
        if (diagnosticStatus.Notice is { } notice) DetailText.Text += "\n" + notice;
        DetailText.Text += "\n\nSQLite storage assumption\n" + StorageAssumption(runtime?.DatabasePath) +
            "\n\nSupport sharing\nCopy support summary includes only selected version, coverage and diagnostic metadata. Saved requests and responses are private exact journals; inspect their contents locally before sharing.";
        SpecialList.ItemsSource = new object[] {
            new NoteRow("Select interfaces.json to switch runtime deliberately."),
            new NoteRow("Refresh capabilities rereads the selected core help contract."),
            new NoteRow("The selected config is never written by browsing.") };
        SetDetailActions(false);
        CopySupportButton.Visibility = Visibility.Visible;
        ShowDetailPane();
    }

    private static string StorageAssumption(string? databasePath) =>
        "Use one Windows owner with the SQLite database on storage that provides reliable local locking. " +
        (databasePath?.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) == true ||
            databasePath?.StartsWith(@"\\", StringComparison.Ordinal) == true && !databasePath.StartsWith(@"\\?\", StringComparison.Ordinal) && !databasePath.StartsWith(@"\\.\", StringComparison.Ordinal) ||
            databasePath?.StartsWith("//", StringComparison.Ordinal) == true
            ? "The selected path uses UNC spelling and may refer to network storage. " : "") +
        "Storage location is unverified: path spelling and drive letters do not prove local storage. Network, mapped or synchronized storage may have different locking and durability behavior. Select a local store deliberately in Connection; no drive or network probe was run.";

    private string BuildSupportSummary()
    {
        var lines = new List<string> { "Lodestar Loader support summary", "Paths, record bodies, arguments and private exact journals are excluded.",
            "Loader version: " + typeof(MainWindow).Assembly.GetName().Version,
            ".NET runtime: " + Environment.Version,
            "Process architecture: " + System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture,
            "Runtime selected: " + (_service is not null ? "yes" : "no"),
            "Capability contract: " + (_service?.Capabilities?.Version?.ToString(CultureInfo.InvariantCulture) ?? "unavailable"),
            "Library coverage: " + (_library is null ? "unread" : _library.CatalogOnly ? "catalog only" : _library.Complete ? "complete" : "partial"),
            "Library revision: " + (_library?.Revision?.ToString(CultureInfo.InvariantCulture) ?? "unavailable"),
            "Loaded records: " + (_library?.LoadedCount.ToString(CultureInfo.InvariantCulture) ?? "unavailable"),
            "Projects: " + (_library?.Projects.Length.ToString(CultureInfo.InvariantCulture) ?? "unavailable"),
            "Library read UTC: " + (_library?.ReadAt.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) ?? "unavailable"),
            "Capability state: " + (_service?.Capabilities is null ? "unread" : _service.Capabilities.Error is null ? "available" : "needs attention") };
        var diagnosticStatus = App.Diagnostics.Status;
        lines.Add("Local diagnostic availability: " + diagnosticStatus.Availability.ToString().ToLowerInvariant());
        if (diagnosticStatus.Notice is { } notice) lines.Add(notice);
        if (diagnosticStatus.Summary is { } diagnostic)
        {
            lines.Add("Diagnostic UTC: " + diagnostic.Timestamp.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
            if (Enum.IsDefined(diagnostic.Operation)) lines.Add("Diagnostic operation: " + diagnostic.Operation);
            lines.Add("Diagnostic fatal: " + diagnostic.Fatal);
            if (Guid.TryParseExact(diagnostic.EventId, "N", out var eventId)) lines.Add("Diagnostic event: " + eventId.ToString("N"));
        }
        else if (diagnosticStatus.Availability == DiagnosticAvailability.Empty) lines.Add("Local diagnostic: none recorded");
        return string.Join(Environment.NewLine, lines);
    }

    private void CopySupportClicked(object sender, RoutedEventArgs e)
        => CopySupportSummary(Clipboard.SetText);

    private void CopySupportSummary(Action<string> copy)
    {
        try { copy(BuildSupportSummary()); SetStatus("Support summary copied. It excludes paths, record content and private exact journals."); }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.GenericRead, error);
            SetStatus("Copy support summary failed; clipboard outcome is unconfirmed. Retry Copy support summary when the clipboard is available. Inspect Connection locally for exact diagnostics.");
        }
    }

    private static string NodeVersion(string path)
    {
        try { return FileVersionInfo.GetVersionInfo(path).ProductVersion ?? "not in file metadata"; }
        catch { return "unknown"; }
    }
    private static string CoreVersion(string cli)
    {
        try
        {
            var package = Path.Combine(Path.GetDirectoryName(cli)!, "package.json");
            if (!File.Exists(package)) return "package metadata unavailable";
            using var document = JsonDocument.Parse(File.ReadAllText(package));
            return JsonData.String(document.RootElement, "version") ?? "unknown";
        }
        catch { return "unknown"; }
    }

    private static bool SafeGeneric(CapabilityOperation operation)
    {
        if (!operation.CanRunGenericRead || operation.Effect != "read") return false;
        if (operation.Id != "doctor") return true;
        return !operation.Description.GetRawText().Contains("--recovery-preflight", StringComparison.Ordinal);
    }

    private async Task SelectProjectAsync(ProjectSummary project)
    {
        if (_library?.CatalogOnly == true)
        { SetStatus("Project catalog ready; wait for current records before opening a project."); return; }
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "projects";
        _project = project;
        _context = null;
        _historicalScopeRecords = [];
        _historicalScopeSummary = null;
        ConfigureWorkspace();
        await ValidateContextAsync(project);
    }

    private async Task ValidateContextAsync(ProjectSummary project)
    {
        var service = _service;
        if (service is null) return;
        var library = _library;
        var generation = ++_projectContextGeneration;
        bool IsCurrent() => !_disposed && !_shutdownStarted && !_switchingRuntime &&
            !_lifetime.IsCancellationRequested && generation == _projectContextGeneration &&
            ReferenceEquals(service, _service) && ReferenceEquals(project, _project) &&
            ReferenceEquals(library, _library);
        try
        {
            var result = await service.ValidateProjectContextAsync(project, _lifetime.Token);
            if (!IsCurrent()) return;
            _context = result;
            UpdateDomainActions();
            UpdateIntentCheckAction();
            PageSubtitle.Text = $"{project.RecordedStatus ?? "No project status recorded"} · project data.status · " +
                (result.Matched ? "root verified" : result.Error ?? "root unresolved");
            if (!result.Matched) SetStatus(result.Error ?? "Project root context could not be verified.");
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.ProjectLoad, error); if (IsCurrent()) SetStatus("Project context read failed · " + error.Message); }
    }

    private async Task SelectRecordAsync(LibraryRecord record)
    {
        if (!CanLeaveDraft() || _service is null) return;
        _selectedRecord = record;
        _selectedIssue = null;
        _detail = null;
        _operation = null;
        var generation = ++_generation;
        ShowDetailPane();
        DetailTitle.Text = record.Name ?? record.Id;
        DetailMeta.Text = $"{record.Kind} · {record.Id} · loading fresh record…";
        DetailText.Text = "Reading current record and its exact source…";
        SetDetailActions(false);
        try
        {
            var current = await _service.GetRecordAsync(record.Id, _lifetime.Token);
            if (generation != _generation || _selectedRecord?.Id != record.Id) return;
            _detail = current;
            RenderRecordDetail();
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.RecordRead, error); if (generation == _generation) DetailText.Text = "Record read failed · " + error.Message; }
    }

    private async Task SelectIssueAsync(RecordIssue issue)
    {
        if (!CanLeaveDraft()) return;
        _selectedIssue = issue;
        _selectedRecord = null;
        _detail = null;
        ++_generation;
        ShowDetailPane();
        DetailTitle.Text = issue.Id ?? "Needs correction";
        DetailMeta.Text = issue.Code + " · normalized catalog entry unavailable";
        DetailText.Text = issue.Message + "\n\nEvidence\n" + JsonData.Pretty(issue.Evidence) +
            "\n\nUse Raw or History for the exact stored record when an ID is available.";
        SetDetailActions(issue.Id is not null);
        EditButton.Visibility = Visibility.Collapsed;
        await Task.CompletedTask;
    }

    private void RenderRecordDetail()
    {
        var record = _detail?.Record ?? _selectedRecord;
        if (record is null) return;
        DetailTitle.Text = record.Name ?? record.Id;
        DetailMeta.Text = $"{record.Kind} · {record.Id}\n{record.Scope} · {record.Availability ?? "availability unknown"} · " +
            $"updated {DateLabel(record.Json, "updated_at")}";
        var lines = new List<string> { RecordProjection.DescribeRecord(record), "", "RECORDED CONTENT" };
        if (JsonData.Property(record.Json, "data") is { ValueKind: JsonValueKind.Object } data)
            foreach (var member in data.EnumerateObject())
                lines.Add($"{member.Name}\n{Readable(member.Value)}\n");
        else if (JsonData.Property(record.Json, "data") is { } other) lines.Add(Readable(other));
        foreach (var name in new[] { "sources", "source", "provenance", "links", "semantics" })
            if (JsonData.Property(record.Json, name) is { } value)
                lines.Add($"{name.ToUpperInvariant()}\n{Readable(value)}\n");
        lines.Add("FULL NORMALIZED JSON\n" + JsonData.Pretty(record.Json));
        if (_detail?.Error is { } error) lines.Insert(0, "Fresh read issue: " + error + "\n");
        DetailText.Text = string.Join("\n", lines);
        SetDetailActions(true);
        RenderReadableRecord(record);
        UpdateIntentCheckAction();
        EditButton.IsEnabled = _detail is not null && RecordEditor.CanEdit(_detail, out _) &&
            _service?.Capabilities?.Version == 1;
        EditButton.ToolTip = EditButton.IsEnabled ? "Edit supported user fields from this fresh record" :
            "This record has no supported fresh edit basis or belongs to a dedicated command family.";
        ReviewSourceButton.Visibility = record.Kind == "research" && record.Lifecycle is not ("historical" or "superseded")
            ? Visibility.Visible : Visibility.Collapsed;
        ReviewSourceButton.IsEnabled = _project is not null && _context?.Matched == true && _context.CanonicalScope == record.Scope && !_saving && !_loading;
        ReviewSourceButton.ToolTip = "Record your source observation date, qualifiers and applicable version through Review change and Save.";
    }

    private static string Readable(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? "",
        JsonValueKind.Null => "Not recorded",
        JsonValueKind.Object or JsonValueKind.Array => JsonData.Pretty(value),
        _ => value.GetRawText()
    };

    private static string DateLabel(JsonElement value, string field)
    {
        var raw = JsonData.String(value, field);
        return DateTimeOffset.TryParse(raw, out var parsed) ? $"{parsed.ToLocalTime():g} ({raw})" : raw ?? "unknown";
    }

    private void SetDetailActions(bool record)
    {
        DetailTabButton.Visibility = HistoryButton.Visibility = RawButton.Visibility =
            EditButton.Visibility = LinksButton.Visibility = record ? Visibility.Visible : Visibility.Collapsed;
        CheckIntentButton.Visibility = Visibility.Collapsed;
        ContinuityReadActions.Visibility = Visibility.Collapsed;
        ContinuityReadChoices.ItemsSource = null;
        ReviewSourceButton.Visibility = CopySupportButton.Visibility = Visibility.Collapsed;
        EditorPanel.Visibility = Visibility.Collapsed;
        CommandPanel.Visibility = Visibility.Collapsed;
        ReadablePanel.Visibility = Visibility.Collapsed;
        DetailText.Visibility = Visibility.Visible;
        CancelEditButton.Visibility = ReviewButton.Visibility = SaveButton.Visibility = Visibility.Collapsed;
    }

    private void UpdateIntentCheckAction()
    {
        var record = _detail?.Record;
        var available = _workspace == "projects" && _project is not null && _context?.Matched == true &&
            _context.CanonicalScope == record?.Scope && record?.Kind == "knowledge" &&
            record.Lifecycle is not ("historical" or "superseded") &&
            record.Availability is not ("unavailable" or "stale") &&
            JsonData.Property(record.Json, "data") is { ValueKind: JsonValueKind.Object } data &&
            JsonData.TryObject(data, "intent", out _) &&
            _service?.Capabilities?.Version == 1 &&
            _service.Capabilities.Operations.Any(operation => operation.Id == "work.check" && operation.Effect == "read");
        CheckIntentButton.Visibility = available ? Visibility.Visible : Visibility.Collapsed;
        CheckIntentButton.IsEnabled = available && !_loading && !_saving && !_editing && !_switchingRuntime;
        CheckIntentButton.ToolTip = available
            ? "Read the selected record's supplied plan and evidence through the verified project root. This does not run tests."
            : "Select a current intent knowledge record in a project with a verified root.";
    }

    private async void CheckIntentClicked(object sender, RoutedEventArgs e) => await CheckIntentUiAsync();

    private async Task CheckIntentUiAsync()
    {
        UpdateIntentCheckAction();
        if (!CheckIntentButton.IsEnabled || !CanLeaveDraft() || _service is not { } service ||
            _project is not { } project || _detail?.Record is not { } record) return;
        var generation = ++_generation;
        var id = record.Id;
        CheckIntentButton.IsEnabled = false;
        ContinuityReadActions.Visibility = Visibility.Collapsed;
        ContinuityReadChoices.ItemsSource = null;
        ReadablePanel.Visibility = Visibility.Collapsed;
        DetailText.Visibility = Visibility.Visible;
        DetailText.Text = "Reading recorded plan and supplied evidence…";
        ShowDetailPane();
        try
        {
            var result = await service.CheckIntentAsync(project, id, _lifetime.Token);
            if (_disposed || generation != _generation || !ReferenceEquals(service, _service) ||
                _workspace != "projects" || _project?.Id != project.Id || _selectedRecord?.Id != id ||
                _detail?.Record?.Id != id || _context?.Matched != true) return;
            DetailText.Text = FormatIntentCheck(result);
            if (result.Success && result.Envelope is { } envelope &&
                JsonData.Property(envelope, "data") is { ValueKind: JsonValueKind.Object } data)
            {
                var actions = IntentContinuityReadout.Reads(data, _context.Root);
                ContinuityReadChoices.ItemsSource = actions;
                ContinuityReadChoices.SelectedIndex = actions.IsEmpty ? -1 : 0;
                ContinuityReadActions.Visibility = actions.IsEmpty ? Visibility.Collapsed : Visibility.Visible;
                ContinuityReadButton.IsEnabled = !actions.IsEmpty;
            }
            SetStatus(result.Success ? "Recorded plan and evidence read · " + id :
                "Plan and evidence read failed · " + result.Message);
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.GenericRead, error);
            if (generation == _generation) DetailText.Text = "Plan and evidence read failed · " + error.Message;
        }
        finally { if (!_disposed && generation == _generation) UpdateIntentCheckAction(); }
    }

    private async void ReadContinuityClicked(object sender, RoutedEventArgs e) => await ReadContinuityUiAsync();

    private async Task ReadContinuityUiAsync()
    {
        if (_disposed || _editing || _saving || _loading || _switchingRuntime ||
            ContinuityReadActions.Visibility != Visibility.Visible || !ContinuityReadButton.IsEnabled ||
            _service is not { } service || _project is not { } project || _context?.Matched != true ||
            _detail?.Record is not { } intent || _selectedRecord?.Id != intent.Id ||
            ContinuityReadChoices.SelectedItem is not ContinuityReadAction selected) return;
        var generation = ++_generation;
        ContinuityReadButton.IsEnabled = false;
        CheckIntentButton.IsEnabled = false;
        try
        {
            var result = await service.ReadContinuityAsync(project, selected.Arguments, _lifetime.Token);
            if (_disposed || generation != _generation || !ReferenceEquals(service, _service) ||
                _workspace != "projects" || _project?.Id != project.Id || _selectedRecord?.Id != intent.Id ||
                _detail?.Record?.Id != intent.Id || _editing || _context?.Matched != true) return;
            DetailText.Text = "CONTEXT FOLLOW-UP READ\n" + selected.Label + "\nLiteral arguments: " +
                JsonSerializer.Serialize(selected.Arguments) + "\n\n" +
                (result.Success ? "Recorded read result" : (result.Code ?? "read_failed") + ": " + result.Message) +
                (result.Envelope is { } envelope ? "\n" + JsonData.Pretty(envelope) : "") +
                "\n\nRefresh Plan / evidence / context to resolve current coverage. A read does not establish acceptance or past agent delivery.";
            SetStatus(result.Success ? "Context read · " + selected.Label : "Context read failed · " + result.Message);
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.GenericRead, error);
            if (!_disposed && generation == _generation) DetailText.Text = "Context read failed · " + error.Message +
                "\nNo write was dispatched. Refresh Plan / evidence / context and inspect the local diagnostic if the read still fails.";
        }
        finally
        {
            if (!_disposed && generation == _generation)
            { ContinuityReadButton.IsEnabled = true; UpdateIntentCheckAction(); }
        }
    }

    private static string FormatIntentCheck(CliResult result)
    {
        if (result.Envelope is not { } envelope)
            return "WORK CHECK\n" + (result.Code ?? "read_failed") + ": " + result.Message;
        if (!result.Success || JsonData.Property(envelope, "data") is not { ValueKind: JsonValueKind.Object } data)
            return "WORK CHECK FAILED\n" + (result.Code ?? "read_failed") + ": " + result.Message +
                "\n\nEXACT PUBLIC RESPONSE\n" + JsonData.Pretty(envelope);
        var ready = JsonData.TryBool(data, "ready_to_review", out var value) && value;
        var complete = JsonData.TryBool(data, "complete", out var completeValue) && completeValue;
        var plan = JsonData.Property(data, "plan");
        var actual = JsonData.Property(data, "actual");
        var delta = JsonData.Property(data, "delta");
        var lines = new List<string> {
            "RECORDED PLAN / SUPPLIED EVIDENCE",
            "Record " + (JsonData.String(data, "intent_record_id") ?? "unknown") +
                " · read revision " + (JsonData.TryLong(envelope, "revision", out var revision) ? revision.ToString() : "unknown"),
            "Review mapping: " + (ready ? "ready for human review" : "needs attention") +
                " · referenced records readable: " + (complete ? "yes" : "no"),
            "This read checks recorded mappings and identities. Supplied results are assertions; run required acceptance checks and review relevance yourself.",
            "", "BRIEF", plan is { } p ? JsonData.String(p, "brief") ?? "No brief supplied" : "No plan returned", ""
        };
        if (plan is { } planValue && JsonData.TryArray(planValue, "requirements", out var requirements))
        {
            var rows = requirements.EnumerateArray().ToArray();
            var depths = IntentContinuityReadout.RequirementDepths(rows);
            var states = delta is { } d && JsonData.TryArray(d, "requirements", out var stateRows)
                ? stateRows.EnumerateArray().Where(row => JsonData.TryString(row, "id", out _))
                    .ToDictionary(row => JsonData.String(row, "id")!, StringComparer.Ordinal)
                : new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            lines.Add("REQUIREMENT TREE / DERIVED DELTA");
            foreach (var row in rows)
            {
                var id = JsonData.String(row, "id") ?? "?";
                var depth = depths.GetValueOrDefault(id);
                states.TryGetValue(id, out var state);
                lines.Add(new string(' ', depth * 2) + "• " + id + " · " +
                    StatusLabel(JsonData.String(state, "status")) + " · " +
                    (JsonData.String(row, "text") ?? "no text"));
                lines.Add(new string(' ', depth * 2 + 2) + "Acceptance: " +
                    (JsonData.String(row, "acceptance") ?? "not recorded"));
            }
            lines.Add("");
        }
        if (JsonData.Property(data, "continuation") is { ValueKind: JsonValueKind.Object } continuation)
        {
            lines.Add("NEXT RECORDED ACTION");
            lines.Add(JsonData.String(continuation, "next_action") ?? "No next action recorded.");
            if (JsonData.TryArray(continuation, "active_requirement_ids", out var active))
                lines.Add("Active requirements: " + string.Join(", ", active.EnumerateArray().Select(item => item.GetString())));
            lines.Add("");
        }
        if (actual is { } actualValue && JsonData.TryArray(actualValue, "requirements", out var supplied))
        {
            lines.Add("RECORDED RESULTS");
            foreach (var row in supplied.EnumerateArray())
            {
                lines.Add("• " + JsonData.String(row, "id") + " · " + StatusLabel(JsonData.String(row, "supplied_status")));
                if (JsonData.String(row, "notes") is { Length: > 0 } notes) lines.Add("  " + notes);
                if (JsonData.TryArray(row, "current_evidence", out var evidence) && evidence.GetArrayLength() > 0)
                    foreach (var reference in evidence.EnumerateArray())
                        lines.Add("  Evidence: " + JsonData.String(reference, "id") + " · revision " +
                            (JsonData.TryLong(reference, "revision", out var evidenceRevision) ? evidenceRevision.ToString() : "unknown"));
                else lines.Add("  No current supporting evidence matched.");
            }
            lines.Add("");
        }
        if (JsonData.TryArray(data, "issues", out var issues) && issues.GetArrayLength() > 0)
        {
            lines.Add("NEEDS ATTENTION");
            foreach (var issue in issues.EnumerateArray())
            {
                var requirement = JsonData.String(issue, "requirement_id");
                lines.Add("• " + (requirement is null ? "" : requirement + ": ") + JsonData.String(issue, "message"));
                if (JsonData.String(issue, "action") is { Length: > 0 } action) lines.Add("  Next: " + action);
            }
            lines.Add("");
        }
        lines.Add(IntentContinuityReadout.Format(data));
        lines.Add("EXACT PUBLIC RESPONSE\n" + JsonData.Pretty(envelope));
        return string.Join("\n", lines);

        static string StatusLabel(string? status) => status switch {
            "not_started" or "missing" => "No result recorded",
            "unverified" => "Needs verification",
            "failed" => "Reported failed",
            "passed" => "Reported passed",
            "stale_intent" => "Plan changed; review the result again",
            "stale_evidence" => "Evidence changed; review it again",
            "awaiting_descendants" => "Child outcomes still need attention",
            "reported_complete_needs_evidence" => "Reported complete; evidence needs attention",
            "reported_complete_with_current_evidence" => "Reported complete; current evidence linked",
            _ => status?.Replace('_', ' ') ?? "Status unknown"
        };
    }

    private void ShowDetailPane()
    {
        _inspectorActive = true;
        _showingCompactDetail = true;
        ApplyResponsiveLayout();
    }

    private void ReturnFromDetail()
    {
        RememberInspectorWidth();
        _inspectorActive = false;
        _showingCompactDetail = false;
        ApplyResponsiveLayout();
    }

    private async void ProjectSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection) return;
        if (_library?.CatalogOnly == true) return;
        if (ProjectList.SelectedItem is ProjectRow row && _project?.Id != row.Project.Id)
        {
            await SelectProjectAsync(row.Project);
            if (_project?.Id != row.Project.Id)
            {
                _suppressSelection = true;
                try { ProjectList.SelectedItem = ProjectList.Items.OfType<ProjectRow>()
                    .FirstOrDefault(item => item.Project.Id == _project?.Id); }
                finally { _suppressSelection = false; }
            }
        }
        else if (ProjectList.SelectedItem is ProjectIssueRow issue)
        {
            if (!CanLeaveDraft())
            {
                _suppressSelection = true;
                try { ProjectList.SelectedItem = ProjectList.Items.OfType<ProjectRow>()
                    .FirstOrDefault(item => item.Project.Id == _project?.Id); }
                finally { _suppressSelection = false; }
                return;
            }
            _project = null; ClearDetailForNavigation(); ConfigureWorkspace(); await SelectIssueAsync(issue.Issue);
        }
    }
    private async void DashboardSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection) return;
        if (_library?.CatalogOnly == true) return;
        if (DashboardList.SelectedItem is ProjectRow row && _project?.Id != row.Project.Id)
        {
            await SelectProjectAsync(row.Project);
            if (_project?.Id != row.Project.Id)
            {
                _suppressSelection = true;
                try { DashboardList.SelectedItem = DashboardList.Items.OfType<ProjectRow>()
                    .FirstOrDefault(item => item.Project.Id == _project?.Id); }
                finally { _suppressSelection = false; }
            }
        }
    }
    private async void ProjectDoubleClicked(object sender, MouseButtonEventArgs e)
    {
        if (_library?.CatalogOnly == true) return;
        if (ProjectList.SelectedItem is ProjectRow row) await SelectProjectAsync(row.Project);
        else if (ProjectList.SelectedItem is ProjectIssueRow issue) await SelectIssueAsync(issue.Issue);
    }
    private async void RecordSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection) return;
        if (sender is Selector list && list.SelectedItem is RecordRow row && _selectedRecord?.Id != row.Record.Id)
        {
            await SelectRecordAsync(row.Record);
            if (_selectedRecord?.Id != row.Record.Id)
            {
                _suppressSelection = true;
                try { list.SelectedItem = list.Items.OfType<RecordRow>()
                    .FirstOrDefault(item => item.Record.Id == _selectedRecord?.Id); }
                finally { _suppressSelection = false; }
            }
        }
        else if (sender is Selector issueList && issueList.SelectedItem is IssueRow issue)
            await SelectIssueAsync(issue.Issue);
    }
    private async void RecordDoubleClicked(object sender, MouseButtonEventArgs e)
    {
        if (sender is Selector { SelectedItem: RecordRow row }) await SelectRecordAsync(row.Record);
    }
    private async void SpecialSelected(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelection) return;
        switch (SpecialList.SelectedItem)
        {
            case RecordRow row: await SelectRecordAsync(row.Record); break;
            case IssueRow issue: await SelectIssueAsync(issue.Issue); break;
            case CommandRow command: ShowCommand(command.Operation); break;
            case RecoveryQuestionRow: RecoveryClicked(this, new RoutedEventArgs()); break;
            case PendingRow pending: ShowPending(pending.Item); break;
        }
    }
    private void TabChanged(object sender, SelectionChangedEventArgs e)
    {
        if (e.Source == MainTabs) UpdateProjectNavigationTags();
        if (e.Source == MainTabs && _project is not null)
            SetStatus($"{_project.Name} · {((MainTabs.SelectedItem as TabItem)?.Header ?? "Overview")} · " +
                (MainTabs.SelectedIndex is 2 or 3 or 4 ? "loaded records; use explicit reads for mapped history" :
                    "loaded records"));
    }
    private void SearchChanged(object sender, TextChangedEventArgs e)
    {
        if (SearchPlaceholder is not null) SearchPlaceholder.Visibility = string.IsNullOrEmpty(SearchBox.Text)
            ? Visibility.Visible : Visibility.Collapsed;
        _filterTimer.Stop(); _filterTimer.Start();
    }
    private void KindChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_workspace == "search") { FillAllRecords(); return; }
        if (_library is not null && _project is not null && sender is ComboBox)
        {
            _suppressSelection = true;
            try
            {
                RecordList.ItemsSource = Rows(FilteredProjectRecords());
                ApplyRecordView();
                RecordResultCount.Text = $"{RecordList.Items.Count:N0} rows";
            }
            finally { _suppressSelection = false; }
        }
    }
    private IEnumerable<LibraryRecord> FilteredProjectRecords()
    {
        IEnumerable<LibraryRecord> rows = AssociatedRecords(_project);
        if (KindFilter.SelectedItem is string kind && kind != "All kinds") rows = rows.Where(r => r.Kind == kind);
        if (AvailabilityFilter.SelectedItem is string availability && availability != "All availability")
            rows = rows.Where(r => r.Availability == availability);
        if (LifecycleFilter.SelectedItem is string lifecycle && lifecycle != "All lifecycle")
            rows = rows.Where(r => (r.Lifecycle ?? "current") == lifecycle);
        var search = SearchBox.Text.Trim();
        return search.Length == 0 ? rows : rows.Where(r => Matches(r, search));
    }
    private async void HistoryToggled(object sender, RoutedEventArgs e)
    {
        if (HistoryToggle.IsChecked == true && !_historicalLoaded)
            await LoadHistoricalProjectsAsync();
        ApplyFilters();
    }
    private void SortChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_settingProjectSort) return;
        (_projectSortPath, _projectSortDirection) = ProjectSort.SelectedIndex switch
        {
            1 => ("UpdatedAt", ListSortDirection.Descending),
            2 => ("Status", ListSortDirection.Ascending),
            3 => ("CountValue", ListSortDirection.Descending),
            _ => ("Name", ListSortDirection.Ascending)
        };
        ApplyFilters();
    }
    private async void RefreshClicked(object sender, RoutedEventArgs e) => await RefreshAsync();
    private void ProjectsClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _project = null; _context = null;
        ProjectList.SelectedIndex = -1;
        DashboardList.SelectedIndex = -1;
        MainTabs.SelectedIndex = 0;
        _workspace = "projects"; ConfigureWorkspace();
    }
    private void GlobalClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "global"; ConfigureWorkspace();
    }
    private void CommandsClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "commands"; ConfigureWorkspace();
    }
    private void RecoveryClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "recovery"; ConfigureWorkspace();
    }
    private void ConnectionClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "connection"; ConfigureWorkspace();
    }

    private async void HistoricalScopeClicked(object sender, RoutedEventArgs e)
    {
        if (_service is null || _project is not { } project || _context?.Matched != true ||
            _context.HistoricalScopes.IsDefaultOrEmpty) return;
        var generation = ++_generation;
        var scopes = _context.HistoricalScopes.Distinct(StringComparer.Ordinal).ToArray();
        HistoricalScopeButton.IsEnabled = false;
        SetStatus("Reading explicitly mapped historical scopes…");
        try
        {
            var records = new List<LibraryRecord>();
            var notes = new List<string>();
            foreach (var scope in scopes)
            {
                var read = await _service.LoadHistoricalScopeAsync(project, scope, _lifetime.Token);
                if (generation != _generation || _project?.Id != project.Id) return;
                if (read.Error is { } error) { notes.Add(scope + ": " + error); continue; }
                records.AddRange(read.Records);
                if (!read.Complete || read.RecordErrors.Length > 0 || read.Advisories.Length > 0)
                    notes.Add(scope + ": partial; " + read.RecordErrors.Length + " record errors; " +
                        string.Join("; ", read.Advisories));
            }
            _historicalScopeRecords = records.DistinctBy(r => r.Id).ToImmutableArray();
            _historicalScopeSummary = $"MAPPED HISTORICAL SCOPES · {_historicalScopeRecords.Length} loaded records from {scopes.Length} scopes" +
                (notes.Count > 0 ? " · partial: " + string.Join(" | ", notes) : " · complete returned pages");
            FillProjectLists();
            SetStatus(_historicalScopeSummary);
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.HistoryRead, error); if (generation == _generation) SetStatus("Historical scope read failed · " + error.Message); }
        finally { if (generation == _generation) UpdateDomainActions(); }
    }

    private async void DomainReadClicked(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string operationId } || _service is null ||
            _project is not { } project || _context?.Matched != true) return;
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        var generation = _generation;
        DetailTitle.Text = (sender as Button)?.Content?.ToString() ?? operationId;
        DetailMeta.Text = operationId + " · selected project · bounded read";
        DetailText.Text = "Reading recorded domain state…";
        ShowDetailPane();
        SetStatus("Reading " + operationId + "…");
        try
        {
            var result = await _service.ReadProjectDomainAsync(project, operationId,
                cancellation: _lifetime.Token);
            if (generation != _generation || _project?.Id != project.Id) return;
            DetailText.Text = FormatDomainRead(result, operationId);
            SetStatus(operationId + (result.Success ? " · returned at " : " · failed at ") +
                DateTimeOffset.Now.ToString("g"));
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.GenericRead, error);
            if (generation == _generation) DetailText.Text = operationId + " failed · " + error.Message;
        }
    }

    private static string FormatDomainRead(CliResult result, string operationId)
    {
        var readAt = DateTimeOffset.Now.ToString("g");
        if (result.Envelope is not { } envelope)
            return $"{operationId}\nRead {readAt}\n{result.Code ?? "read_failed"}: {result.Message}\n{result.Diagnostics}";
        var data = JsonData.Property(envelope, "data");
        var more = JsonData.TryBool(envelope, "more", out var envelopeMore) && envelopeMore ||
            data is { } content && JsonData.TryBool(content, "more", out var dataMore) && dataMore;
        bool? complete = data is { } body && JsonData.TryBool(body, "complete", out var dataComplete)
            ? dataComplete : JsonData.TryBool(envelope, "complete", out var envelopeComplete)
                ? envelopeComplete : null;
        var errors = data is { } errorsData && JsonData.TryArray(errorsData, "record_errors", out var entries)
            ? entries.GetArrayLength() : 0;
        var lines = new List<string> {
            operationId.ToUpperInvariant(), $"Read {readAt} · revision {(JsonData.TryLong(envelope, "revision", out var revision) ? revision.ToString() : "unknown")}",
            $"Coverage: {(complete == true && !more ? "complete returned result" : complete == false || more ? "partial returned result" : "unspecified")} · more: {more} · record errors: {errors}",
            "Bounded read (limit 250); returned history is not a claim of all retained history.", ""
        };
        if (JsonData.TryArray(envelope, "next", out var next))
            foreach (var advisory in next.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String))
                lines.Add("ADVISORY\n" + advisory.GetString() + "\n");
        if (data is { ValueKind: JsonValueKind.Object } objectData)
            foreach (var member in objectData.EnumerateObject())
                lines.Add(member.Name.Replace('_', ' ').ToUpperInvariant() + "\n" + Readable(member.Value) + "\n");
        else if (data is { } other) lines.Add("RETURNED DATA\n" + Readable(other));
        if (!result.Success) lines.Insert(1, "Read failed · " + result.Code + " · " + result.Message);
        lines.Add("EXACT RAW RESPONSE\n" + JsonData.Pretty(envelope));
        return string.Join("\n", lines);
    }

    private static string FriendlyCommandLabel(string name)
    {
        var words = name.Replace('.', ' ').Replace('_', ' ').Replace('-', ' ');
        return words.Length == 0 ? name : char.ToUpper(words[0], CultureInfo.CurrentCulture) + words[1..];
    }

    private static bool IsProjectDomainRead(CapabilityOperation operation) =>
        operation.Effect == "read" && operation.Id is
            ("work.status" or "work.history" or "handoff.status" or "handoff.history" or
            "decision.show" or "pending.list") &&
        JsonData.TryObject(operation.Description, "context", out var context) &&
        JsonData.TryBool(context, "project", out var project) && project &&
        JsonData.TryBool(context, "actor", out var actor) && !actor;

    private static bool IsIntentRead(CapabilityOperation operation) => operation.Id == "work.check" &&
        operation.Effect == "read" && operation.Argv.SequenceEqual(["work", "check"]) &&
        JsonData.TryObject(operation.Description, "context", out var context) &&
        JsonData.TryBool(context, "project", out var project) && project &&
        JsonData.TryBool(context, "actor", out var actor) && !actor &&
        JsonData.TryArray(operation.Description, "parameters", out var parameters) &&
        parameters.EnumerateArray().Any(parameter => JsonData.String(parameter, "name") == "intent_record_id" &&
            JsonData.String(parameter, "binding") == "positional" && JsonData.TryInt(parameter, "index", out var index) && index == 0 &&
            JsonData.TryObject(parameter, "schema", out var schema) && JsonData.String(schema, "type") == "string");

    private static string CommandAvailability(CapabilityOperation operation) => IsIntentRead(operation) ?
        "Run for selected project" : SafeGeneric(operation) ?
        "Run here" : IsProjectDomainRead(operation) ? "Project workspace" :
        operation.Effect == "read" ? "Dedicated adapter needed" :
        "Description only · " + operation.Effect + " needs a dedicated adapter";

    private void OpenProjectCommand(CapabilityOperation operation)
    {
        if (!IsProjectDomainRead(operation) || !CanLeaveDraft()) return;
        if (_project is null)
        {
            ProjectsClicked(this, new RoutedEventArgs());
            SetStatus("Select a project, then use its Work & handoff or Decisions & pending read.");
            return;
        }
        ClearDetailForNavigation();
        _workspace = "projects";
        ConfigureWorkspace();
        MainTabs.SelectedIndex = operation.Id is "decision.show" or "pending.list" ? 4 : 3;
        if (_context?.Matched != true)
        {
            SetStatus(_context?.Error ?? "This project needs a verified root before its domain read can run.");
            return;
        }
        var button = operation.Id switch {
            "work.status" => WorkStatusButton,
            "work.history" => WorkHistoryButton,
            "handoff.status" => HandoffStatusButton,
            "handoff.history" => HandoffHistoryButton,
            "decision.show" => DecisionStreamButton,
            _ => PendingItemsButton
        };
        button.Focus();
        SetStatus("Ready for " + button.Content + " on " + _project.Name + ". Run the focused project read.");
    }

    private void LinksClicked(object sender, RoutedEventArgs e)
    {
        var id = _detail?.Record?.Id;
        if (id is null || _service is null || !CanLeaveDraft()) return;
        var operation = _service.Capabilities?.Operations.FirstOrDefault(item => item.Id == "links" && SafeGeneric(item));
        if (operation is null) { SetStatus("Links read was not dispatched. Refresh the selected core capabilities and inspect links --help."); return; }
        _workspace = "commands"; ConfigureWorkspace(); ShowCommand(operation);
        foreach (var input in CommandFields.Children.OfType<TextBox>())
        {
            var key = System.Windows.Automation.AutomationProperties.GetAutomationId(input);
            if (key == "CommandInput_id") input.Text = id;
            if (key == "CommandInput_limit") input.Text = "250";
        }
        RunCommandClicked(sender, e);
    }

    private void ShowCommand(CapabilityOperation operation)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _operation = operation;
        _pending = null;
        DetailTitle.Text = FriendlyCommandLabel(operation.Id);
        DetailMeta.Text = $"{operation.Id} · {CommandAvailability(operation)} · {string.Join(" ", operation.Argv)}";
        SetDetailActions(false);
        _commandInputs.Clear();
        CommandFields.Children.Clear();
        var intentRead = IsIntentRead(operation) && _service?.Capabilities?.Version == 1;
        var runnable = SafeGeneric(operation) || intentRead;
        CommandFields.Children.Add(new TextBlock {
            Text = operation.Summary + "\n\n" + CommandAvailability(operation) +
                (runnable ? " · Supply the described inputs below." :
                    " · " + (operation.UnavailableReason ?? "Use its dedicated workspace or adapter.")),
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 12)
        });
        if (JsonData.TryObject(operation.Description, "guidance", out var guidance))
        {
            var lines = new List<string>();
            foreach (var (key, label) in new[] { ("purpose", "Purpose"), ("use", "Use"), ("scope", "Scope"), ("limits", "Limits"), ("recovery", "Recovery") })
                lines.Add(label + ": " + (JsonData.String(guidance, key) ?? "Not supplied by this core."));
            CommandFields.Children.Add(new TextBlock { Text = string.Join("\n\n", lines), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) });
        }
        else CommandFields.Children.Add(new TextBlock { Text = "Operator guidance is not supplied by this core. Inspect the exact core descriptor below.", TextWrapping = TextWrapping.Wrap });
        var questions = CommandQuestionText(operation);
        if (questions.Length > 0) CommandFields.Children.Add(new TextBlock { Text = "Questions\n" + questions, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) });
        if (IsProjectDomainRead(operation))
        {
            var open = new Button { Content = "Open project workspace", HorizontalAlignment = HorizontalAlignment.Left,
                Margin = new Thickness(0, 0, 0, 7), ToolTip = "Use the existing project read with verified root context" };
            open.Click += (_, _) => OpenProjectCommand(operation);
            System.Windows.Automation.AutomationProperties.SetAutomationId(open, "OpenProjectCommand");
            CommandFields.Children.Add(open);
        }
        if (intentRead) CommandFields.Children.Add(new TextBlock {
            Text = _project is not null && _context?.Matched == true
                ? "Selected project: " + _project.Name + ". The project root is revalidated before the read. Supply a current intent knowledge record ID."
                : "Select a project with a verified root, then reopen this question and supply its intent knowledge record ID. No read has been dispatched.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10) });
        if (runnable && JsonData.TryArray(operation.Description, "parameters", out var parameters))
            foreach (var parameter in parameters.EnumerateArray())
            {
                var name = JsonData.String(parameter, "name");
                if (name is null) continue;
                if (intentRead && name != "intent_record_id") continue;
                var required = JsonData.TryBool(parameter, "required", out var marked) && marked;
                var schema = JsonData.Property(parameter, "schema");
                var type = schema is { } shape ? JsonData.String(shape, "type") : null;
                var label = FriendlyCommandLabel(name);
                CommandFields.Children.Add(new TextBlock { Text = label + (required ? " · required" : " · optional") +
                    (type is null ? "" : " · " + type), Margin = new Thickness(0, 9, 0, 1) });
                var keyLabel = new TextBlock { Text = "Key: " + name, FontSize = 10,
                    Margin = new Thickness(0, 0, 0, 3) };
                keyLabel.SetResourceReference(TextBlock.ForegroundProperty, "Muted");
                CommandFields.Children.Add(keyLabel);
                var hint = "Exact key: " + name + (schema is { } described ?
                    " · " + (JsonData.String(described, "description") ?? "") : "");
                string[]? choices = null;
                if (schema is { } options && JsonData.TryArray(options, "enum", out var allowed))
                    choices = allowed.EnumerateArray().Select(value => value.ValueKind == JsonValueKind.String ?
                        value.GetString()! : value.GetRawText()).ToArray();
                else if (type == "boolean") choices = ["false", "true"];
                var initial = schema is { } defaultSchema && JsonData.Property(defaultSchema, "default") is { } defaultValue &&
                    defaultValue.ValueKind != JsonValueKind.Null ? Readable(defaultValue) : null;
                if (choices is not null)
                {
                    var select = new ComboBox { ToolTip = hint, MinWidth = 130, HorizontalAlignment = HorizontalAlignment.Left };
                    if (!required) select.Items.Add(new ComboBoxItem { Content = "Leave unset", Tag = null });
                    foreach (var choice in choices)
                        select.Items.Add(new ComboBoxItem { Content = type == "boolean" ?
                            (choice == "true" ? "Yes · true" : "No · false") : choice, Tag = choice });
                    select.SelectedItem = select.Items.OfType<ComboBoxItem>().FirstOrDefault(item =>
                        (string?)item.Tag == initial);
                    System.Windows.Automation.AutomationProperties.SetName(select, label + " (" + name + ")");
                    System.Windows.Automation.AutomationProperties.SetAutomationId(select, "CommandInput_" + name);
                    CommandFields.Children.Add(select);
                    _commandInputs[name] = () => (select.SelectedItem as ComboBoxItem)?.Tag as string;
                }
                else
                {
                    var box = new TextBox { ToolTip = hint, Text = initial ?? "" };
                    System.Windows.Automation.AutomationProperties.SetName(box, label + " (" + name + ")");
                    System.Windows.Automation.AutomationProperties.SetAutomationId(box, "CommandInput_" + name);
                    CommandFields.Children.Add(box);
                    _commandInputs[name] = () => string.IsNullOrEmpty(box.Text) ? null : box.Text;
                }
            }
        var descriptor = new Expander { Header = "Exact core descriptor", Margin = new Thickness(0, 16, 0, 0),
            IsExpanded = false, Content = new TextBlock { Text = JsonData.Pretty(operation.Description),
                FontFamily = new FontFamily("Cascadia Code, Consolas"), FontSize = 11,
                TextWrapping = TextWrapping.Wrap } };
        CommandFields.Children.Add(descriptor);
        DetailText.Visibility = Visibility.Collapsed;
        CommandPanel.Visibility = Visibility.Visible;
        RunCommandButton.Visibility = runnable ? Visibility.Visible : Visibility.Collapsed;
        RunCommandInspectorButton.Visibility = RunCommandButton.Visibility;
        RunCommandButton.Content = RunCommandInspectorButton.Content = "Run read";
        ShowDetailPane();
    }

    private async void RunCommandClicked(object sender, RoutedEventArgs e)
    {
        if (_service is null || _operation is null || !(SafeGeneric(_operation) || IsIntentRead(_operation)) || !CanLeaveDraft()) return;
        if (CommandPanel.Visibility != Visibility.Visible)
        {
            DetailText.Visibility = Visibility.Collapsed;
            CommandPanel.Visibility = Visibility.Visible;
            RunCommandButton.Content = RunCommandInspectorButton.Content = "Run read";
            return;
        }
        var operation = _operation;
        var generation = ++_generation;
        var values = _commandInputs.ToDictionary(pair => pair.Key, pair => pair.Value(),
            StringComparer.Ordinal);
        RunCommandButton.IsEnabled = RunCommandInspectorButton.IsEnabled = false;
        SetStatus("Running described read " + operation.Id + "…");
        try
        {
            CliResult result;
            if (IsIntentRead(operation))
            {
                if (_project is null || _context?.Matched != true)
                    result = new(false, null, "project_context_missing", "work.check was not dispatched. Select a project with a verified root, then reopen this question.", null, "", 0);
                else result = await _service.CheckIntentAsync(_project, values.GetValueOrDefault("intent_record_id") ?? "", _lifetime.Token);
            }
            else result = await _service.RunReadAsync(operation, values, _lifetime.Token);
            if (generation != _generation || _operation != operation) return;
            CommandPanel.Visibility = Visibility.Collapsed;
            DetailText.Visibility = Visibility.Visible;
            DetailText.Text = result.Envelope is { } envelope ?
                FormatCommandRead(operation.Id, result, envelope) :
                result.Code + " · " + result.Message + "\n" + result.Diagnostics;
            RunCommandButton.Content = RunCommandInspectorButton.Content = "Edit / run again";
            SetStatus($"{operation.Id} · {(result.Success ? "completed" : "failed")} · {result.ElapsedMilliseconds} ms");
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.GenericRead, error); if (generation == _generation) SetStatus("Read could not run · " + error.Message); }
        finally { RunCommandButton.IsEnabled = RunCommandInspectorButton.IsEnabled = true; }
    }

    private static string FormatCommandRead(string operationId, CliResult result, JsonElement envelope)
    {
        var lines = new List<string> { FriendlyCommandLabel(operationId).ToUpperInvariant() +
            (result.Success ? " · returned" : " · failed"),
            "Read " + DateTimeOffset.Now.ToString("g") };
        if (!result.Success) lines.Add((result.Code ?? "read_failed") + " · " + result.Message);
        if (JsonData.Property(envelope, "data") is { ValueKind: JsonValueKind.Object } data)
            foreach (var member in data.EnumerateObject())
                lines.Add("\n" + FriendlyCommandLabel(member.Name).ToUpperInvariant() + "\n" + Readable(member.Value));
        else if (JsonData.Property(envelope, "data") is { } other)
            lines.Add("\nRETURNED DATA\n" + Readable(other));
        lines.Add("\nEXACT RAW RESPONSE\n" + JsonData.Pretty(envelope));
        return string.Join("\n", lines);
    }

    private void ShowPending(PendingSave pending)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _pending = pending;
        _operation = null;
        SetDetailActions(false);
        DetailTitle.Text = pending.RecordId;
        DetailMeta.Text = (pending.ReplayEligible ? "Replay available" : "Journal needs inspection") + " · " + pending.RequestId;
        DetailText.Text = (pending.Issue is { } issue ? issue + (pending.ReplayEligible
                ? "\n\nExact replay will verify the original request with Lodestar. Unverified response bytes remain preserved.\n\n"
                : "\n\nReplay is disabled for this journal. Preserve its files while inspecting the failure.\n\n") :
            pending.CommitReported ? "The CLI reports a commit at revision " + pending.CommittedRevision +
                (pending.ReceiptId is null ? ". " : " with receipt " + pending.ReceiptId + ". ") +
                "Response delivery failed; the outcome remains unresolved until receipt verification or exact-request recovery.\n\n" :
            "This request may have committed. Lodestar retained its exact bytes.\n\n") +
            $"Request ID\n{pending.RequestId}\n\nDatabase\n{pending.DatabasePath}\n\nCreated\n{pending.CreatedAt.ToLocalTime():g}\n\n" +
            $"Journal folder\n{pending.JournalDirectory}\n\nReplay checks the selected runtime and database identity. It does not build a new request." +
            (_service is { } currentService ? "\n\nPublic recovery inspection argv\n" +
                JsonSerializer.Serialize(new[] { currentService.Runtime.NodePath, currentService.Runtime.CliPath,
                    "--db", currentService.Runtime.DatabasePath, "recovery", "list", "--interface-config", currentService.Runtime.ConfigPath }) +
                "\nRead the reported journal issue and action. Preserve request.json, context.json and response evidence; never reset a malformed journal to make replay available." : "") +
            (pending.CommitReported && pending.ReceiptId is { } receipt && _service is { } service
                ? "\n\nRead-only receipt command argv (selected runtime)\n" +
                    JsonSerializer.Serialize(new[] { service.Runtime.NodePath, service.Runtime.CliPath,
                        "--db", pending.DatabasePath, "get", receipt }) +
                    "\nCompare its request ID and revision with the saved journal before resolving this item."
                : "");
        ReplayButton.Visibility = Visibility.Visible;
        ReplayInspectorButton.Visibility = Visibility.Visible;
        ReplayButton.IsEnabled = ReplayInspectorButton.IsEnabled = pending.ReplayEligible;
        ShowDetailPane();
    }

    private async void ReplayClicked(object sender, RoutedEventArgs e)
    {
        if (_service is null || _pending is null || !_pending.ReplayEligible || _saving ||
            _switchingRuntime || _shutdownStarted || _disposed || !CanLeaveDraft()) return;
        if (MessageBox.Show($"Replay the exact saved request {_pending.RequestId} for {_pending.RecordId}?",
            "Resolve unknown save", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        var service = _service;
        var pending = _pending;
        var generation = _generation;
        _saving = true;
        SetEditorBusy(true);
        ReplayButton.IsEnabled = ReplayInspectorButton.IsEnabled = false;
        SelectRuntimeButton.IsEnabled = SelectRuntimeTopButton.IsEnabled = false;
        try
        {
            var result = await service.RecoverAsync(pending.RecoveryKey ?? pending.RequestId, _lifetime.Token);
            if (_service != service || generation != _generation || _disposed || _shutdownStarted || _closingAfterSave) return;
            DetailText.Text = result.Saved ? "Exact request is recorded as saved. Refresh to see the latest state." :
                (result.RequiresRecovery ? "Outcome remains unknown. " : "Replay failed. ") + result.Error;
            SetStatus(result.Saved ? "Pending save resolved · " + result.RequestId : "Pending save unresolved · " + result.Error);
            FillRecovery();
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.Recovery, error);
            if (_service == service && generation == _generation && !_disposed && !_shutdownStarted && !_closingAfterSave)
                SetStatus("Exact replay failed · " + error.Message);
        }
        finally
        {
            _saving = false;
            if (!_disposed && !_shutdownStarted && !_closingAfterSave)
            {
                SetEditorBusy(false);
                ReplayButton.IsEnabled = ReplayInspectorButton.IsEnabled = _pending?.ReplayEligible == true;
                SelectRuntimeButton.IsEnabled = SelectRuntimeTopButton.IsEnabled = !_switchingRuntime;
            }
        }
    }

    private async void RefreshCapabilitiesClicked(object sender, RoutedEventArgs e) =>
        await RefreshCapabilitiesUiAsync();

    private async Task RefreshCapabilitiesUiAsync()
    {
        var service = _service;
        if (service is null || _disposed || _shutdownStarted || _refreshingCapabilities) return;
        if (_editing)
        { SetStatus("Draft retained. Save or discard it before refreshing capabilities."); return; }
        if (_loading || _saving || _preparingAction || _switchingRuntime)
        { SetStatus("Wait for the current read, review or save before refreshing capabilities."); return; }
        var generation = _generation;
        bool CanPublish() => !_disposed && !_shutdownStarted && !_lifetime.IsCancellationRequested &&
            ReferenceEquals(service, _service) && generation == _generation &&
            !_editing && !_loading && !_saving && !_preparingAction && !_switchingRuntime;
        _refreshingCapabilities = true;
        RefreshCapabilitiesButton.IsEnabled = RefreshCapabilitiesTopButton.IsEnabled = false;
        try
        {
            var capabilities = await service.DiscoverAsync(cancellation: _lifetime.Token);
            if (!CanPublish()) return;
            SetStatus(capabilities.Error ?? $"Capability version {capabilities.Version} · {capabilities.Operations.Length} operations");
            ConfigureWorkspace();
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.CapabilityDiscovery, error); if (CanPublish()) SetStatus("Capability refresh failed · " + error.Message); }
        finally
        {
            _refreshingCapabilities = false;
            if (!_disposed)
                RefreshCapabilitiesButton.IsEnabled = RefreshCapabilitiesTopButton.IsEnabled = true;
        }
    }

    private async void SelectRuntimeClicked(object sender, RoutedEventArgs e)
    {
        if (_loading || _saving || _switchingRuntime || _shutdownStarted)
        { SetStatus("Wait for the active library read or save before switching runtime."); return; }
        if (!CanLeaveDraft()) return;
        var dialog = new OpenFileDialog { Title = "Select Lodestar interfaces.json", Filter = "JSON configuration (*.json)|*.json",
            FileName = "interfaces.json", CheckFileExists = true };
        if (dialog.ShowDialog(this) != true) return;
        if (_loading || _saving)
        { SetStatus("A read or save started while selecting the config. Wait for it to finish, then select again."); return; }
        _switchingRuntime = true;
        SelectRuntimeButton.IsEnabled = SelectRuntimeTopButton.IsEnabled = false;
        try
        {
            var runtime = await LodestarService.LoadRuntimeAsync(dialog.FileName, _lifetime.Token);
            App.ConfigureDiagnostics(runtime);
            if (_shutdownStarted || _disposed) return;
            if (_loading || _saving)
            { SetStatus("A read or save started while validating the config. Select it again after that finishes."); return; }
            if (_service is not null) await _service.DisposeAsync();
            if (_shutdownStarted || _disposed) return;
            _service = new(runtime, _journalRoot);
            _library = null; _project = null; _selectedRecord = null; _detail = null;
            _doctorResult = null; _doctorReadAt = null;
            _recordSearchCache.Clear();
            ++_generation;
            _switchingRuntime = false;
            await RefreshAsync();
            ConfigureWorkspace();
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.RuntimeSelection, error); SetStatus("Runtime selection failed · " + error.Message); }
        finally { _switchingRuntime = false; SelectRuntimeButton.IsEnabled = SelectRuntimeTopButton.IsEnabled = true; }
    }

    private async void ManagerClicked(object sender, RoutedEventArgs e)
    {
        if (_loading) { SetStatus("Wait for the active library read before opening Manager."); return; }
        if (_service is null) { SetStatus("Select a valid runtime before opening Manager."); return; }
        ManagerButton.IsEnabled = false;
        try
        {
            var runtime = _service.Runtime;
            var fresh = await LodestarService.LoadRuntimeAsync(runtime.ConfigPath, _lifetime.Token);
            if (!fresh.Equals(runtime)) throw new InvalidOperationException("Config changed. Refresh the connection before opening Manager.");
            if (_project is not null)
            {
                var verified = await _service.ValidateProjectContextAsync(_project, _lifetime.Token);
                _context = verified;
                if (!verified.Matched) throw new InvalidOperationException(verified.Error ?? "Selected project context is stale.");
            }
            var info = new ProcessStartInfo(runtime.NodePath) { UseShellExecute = false,
                CreateNoWindow = false, WorkingDirectory = Path.GetDirectoryName(runtime.CliPath)! };
            info.ArgumentList.Add(runtime.CliPath);
            info.ArgumentList.Add("manager");
            info.ArgumentList.Add("--interface-config");
            info.ArgumentList.Add(runtime.ConfigPath);
            if (_project is not null)
            {
                info.ArgumentList.Add("--project"); info.ArgumentList.Add(_project.Id);
                if (_context?.Root is { } root) { info.ArgumentList.Add("--cwd"); info.ArgumentList.Add(root); }
            }
            foreach (var key in new[] { "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_SESSION_ID", "OPENCODE_SESSION_ID",
                "CODEX_AGENT_NAME", "LODESTAR_AGENT", "LODESTAR_HARNESS", "LODESTAR_DB", "NODE_OPTIONS", "NODE_PATH" })
                info.Environment.Remove(key);
            using var process = Process.Start(info) ?? throw new InvalidOperationException("Node did not start.");
            SetStatus("Opened independent Lodestar Manager console · process " + process.Id);
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.ManagerLaunch, error); SetStatus("Manager launch failed · " + error.Message); }
        finally { ManagerButton.IsEnabled = true; }
    }

    private async void DetailTabClicked(object sender, RoutedEventArgs e)
    {
        if (_selectedRecord is null || !CanLeaveDraft()) return;
        var id = _selectedRecord.Id;
        var generation = ++_generation;
        if (_detail is null && _service is not null)
        {
            var read = await _service.GetRecordAsync(id, _lifetime.Token);
            if (generation != _generation || _selectedRecord?.Id != id) return;
            _detail = read;
        }
        RenderRecordDetail();
    }

    private async void HistoryClicked(object sender, RoutedEventArgs e) => await LoadHistoryAsync();

    private async Task LoadHistoryAsync()
    {
        if (_service is null || !CanLeaveDraft()) return;
        var id = _selectedRecord?.Id ?? _selectedIssue?.Id;
        if (id is null) return;
        var generation = ++_generation;
        ReadablePanel.Visibility = Visibility.Collapsed;
        DetailText.Visibility = Visibility.Visible;
        DetailText.Text = "Reading retained history…";
        ShowDetailPane();
        try
        {
            var history = await _service.GetHistoryAsync(id, _lifetime.Token);
            if (generation != _generation) return;
            if (history.Error is { } error) DetailText.Text = "History read failed · " + error;
            else
            {
                var current = await _service.GetRawAsync(id, _lifetime.Token);
                if (generation != _generation) return;
                DetailText.Text = "CURRENT RECORD\n" +
                    (_selectedRecord is { } selected ? selected.Name + " · " + selected.Id +
                        "\nUpdated " + DateLabel(selected.Json, "updated_at") +
                        "\n" + RecordProjection.DescribeRecord(selected) : id) +
                    "\n\nRETAINED VERSIONS · " + history.DecodedHistory.Length + "\n" +
                    (history.DecodedHistory.IsDefaultOrEmpty ? "No previous versions are recorded for this ID." :
                        string.Join("\n\n", history.DecodedHistory.Select(DescribeHistoryVersion))) +
                    "\n\nCURRENT EXACT RAW EVIDENCE\n" +
                    (current.RawRecord is { } raw ? DescribeStored(raw) : current.Error ?? "Raw current record unavailable.");
            }
            SetStatus("History read · " + id);
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.HistoryRead, error); if (generation == _generation) DetailText.Text = "History read failed · " + error.Message; }
    }

    private async void RawClicked(object sender, RoutedEventArgs e)
    {
        if (_service is null || !CanLeaveDraft()) return;
        var id = _selectedRecord?.Id ?? _selectedIssue?.Id;
        if (id is null) return;
        var generation = ++_generation;
        ReadablePanel.Visibility = Visibility.Collapsed;
        DetailText.Visibility = Visibility.Visible;
        DetailText.Text = "Reading exact stored record…";
        ShowDetailPane();
        try
        {
            var raw = await _service.GetRawAsync(id, _lifetime.Token);
            if (generation != _generation) return;
            DetailText.Text = raw.Error is { } error ? "Raw read failed · " + error :
                raw.RawRecord is { } stored ? "STORED RAW RECORD\n" + DescribeStored(stored) :
                raw.Record is { } current ? "Raw payload unavailable; normalized record\n" + JsonData.Pretty(current.Json) :
                "No raw record was returned.";
            SetStatus("Raw read · " + id);
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.RecordRead, error); if (generation == _generation) DetailText.Text = "Raw read failed · " + error.Message; }
    }

    private static string DescribeStored(JsonElement entry)
    {
        var raw = JsonData.Property(entry, "raw_record") ?? entry;
        var content = JsonData.String(raw, "content_json");
        if (content is null) return JsonData.Pretty(entry);
        try
        {
            using var document = JsonDocument.Parse(content);
            return $"ID  {JsonData.String(raw, "id") ?? "unknown"}\n" +
                $"Saved  {DateLabel(raw, "updated_at")}\n" +
                $"Stored content\n{JsonData.Pretty(document.RootElement)}\n\nExact raw row\n{JsonData.Pretty(entry)}";
        }
        catch (JsonException) { return "Stored content_json is malformed. Exact raw row:\n" + JsonData.Pretty(entry); }
    }

    private static string DescribeHistoryContent(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Object) return Readable(content);
        var lines = new List<string>();
        foreach (var key in new[] { "state", "value", "name", "kind", "scope", "availability", "updated_at", "data" })
            if (JsonData.Property(content, key) is { } value)
                lines.Add(key.Replace('_', ' ').ToUpperInvariant() + "\n" + Readable(value));
        return lines.Count > 0 ? string.Join("\n\n", lines) : JsonData.Pretty(content);
    }

    private static string DescribeHistoryVersion(DecodedHistoryVersion item, int index)
    {
        var row = JsonData.Property(item.RawEvidence, "raw_record");
        var name = row is { } raw ? JsonData.String(raw, "name") : null;
        return $"VERSION {index + 1}\n" +
            $"Stored name: {name ?? "unknown"}\n" +
            $"Stored record revision: {item.StoredRecordRevision?.ToString() ?? "unknown"}\n" +
            $"Replacing receipt revision: {item.ReplacingReceiptRevision?.ToString() ?? "unknown"}\n" +
            $"Receipt ID: {item.ReceiptId ?? "unknown"}\n" +
            (item.StoredContent is { } content ? "Readable stored content\n" +
                DescribeHistoryContent(content) : "Stored content could not be decoded.\n") +
            "\nExact raw evidence\n" + JsonData.Pretty(item.RawEvidence);
    }

    private void EditClicked(object sender, RoutedEventArgs e)
    {
        if (_loading) { SetStatus("Wait for the library read before editing a record."); return; }
        if (_detail is null || _service?.Capabilities?.Version != 1)
        { SetStatus("A fresh supported edit basis is unavailable."); return; }
        if (!RecordEditor.CanEdit(_detail, out var reason)) { SetStatus(reason); return; }
        if (_editing) return;
        var draft = RecordEditor.Begin(_detail);
        _settingDraft = true;
        EditName.Text = draft.Name ?? "";
        EditName.IsReadOnly = _detail.Record?.Kind == "project";
        EditName.ToolTip = EditName.IsReadOnly ? "Project name belongs to the catalog" : null;
        EditAvailability.SelectedItem = draft.Availability ?? "unknown";
        EditPriority.Text = draft.Priority?.ToString(CultureInfo.InvariantCulture) ?? "";
        EditPriority.IsReadOnly = draft.Priority is null;
        EditData.Text = UserDataForEditor(_detail.Record!);
        PrepareScalarEditors();
        EditData.IsReadOnly = JsonData.Property(_detail.Record!.Json, "data") is not { ValueKind: JsonValueKind.Object };
        if (EditData.IsReadOnly) foreach (var box in _scalarEditors.Values) box.IsEnabled = false;
        EditHint.Text = _detail.Record.Kind == "project" ?
            "Only user-maintained data keys appear here. Catalog roots, bindings, paths, and fingerprints stay read-only." :
            EditData.IsReadOnly ? "Non-object data is read-only. Other supported fields can still change." :
            "Edit the user data object. Review lists changed top-level fields and removals.";
        _settingDraft = false;
        _editing = true; _draftDirty = false; _review = null;
        DetailTabButton.Visibility = HistoryButton.Visibility = RawButton.Visibility = EditButton.Visibility = Visibility.Collapsed;
        DetailText.Visibility = Visibility.Collapsed;
        ReadablePanel.Visibility = Visibility.Collapsed;
        EditorPanel.Visibility = Visibility.Visible;
        CancelEditButton.Visibility = ReviewButton.Visibility = Visibility.Visible;
        SaveButton.Visibility = Visibility.Collapsed;
        EditorPanel.ScrollToTop();
        SetStatus("Editing draft · stored record unchanged");
        UpdateContinueState();
        EditName.Focus();
    }

    private static readonly HashSet<string> ProtectedProjectKeys = new(StringComparer.Ordinal) {
        "roots", "root", "catalog_binding", "catalog_fields", "name", "path", "aliases",
        "source_fingerprint", "source_fingerprints"
    };

    private static bool ProtectedProjectKey(string key) => ProtectedProjectKeys.Contains(key) ||
        key.StartsWith("catalog_", StringComparison.Ordinal);

    private static string UserDataForEditor(LibraryRecord record)
    {
        var data = JsonData.Property(record.Json, "data");
        if (data is not { ValueKind: JsonValueKind.Object }) return data is { } raw ? JsonData.Pretty(raw) : "null";
        if (record.Kind != "project") return JsonData.Pretty(data.Value);
        var user = new JsonObject();
        foreach (var property in data.Value.EnumerateObject())
            if (!ProtectedProjectKey(property.Name)) user[property.Name] = JsonNode.Parse(property.Value.GetRawText());
        return user.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    private string MergeEditedData()
    {
        if (_detail?.Record is not { } record) throw new InvalidOperationException("Fresh record baseline is unavailable.");
        if (record.Kind != "project") return EditData.Text;
        var original = JsonNode.Parse(record.Json.GetProperty("data").GetRawText()) as JsonObject
            ?? throw new InvalidOperationException("Project data is not an object.");
        var edited = JsonNode.Parse(EditData.Text) as JsonObject
            ?? throw new InvalidDataException("Project user data must remain a JSON object.");
        if (edited.Any(pair => ProtectedProjectKey(pair.Key)))
            throw new InvalidDataException("Catalog-owned keys cannot be entered in user data.");
        foreach (var key in original.Select(pair => pair.Key).Where(key => !ProtectedProjectKey(key)).ToArray())
            original.Remove(key);
        foreach (var pair in edited) original[pair.Key] = pair.Value?.DeepClone();
        return original.ToJsonString();
    }

    private EditDraft CurrentDraft()
    {
        int? priority = null;
        if (!string.IsNullOrWhiteSpace(EditPriority.Text))
        {
            if (!int.TryParse(EditPriority.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed))
                throw new InvalidDataException("Priority needs an integer.");
            priority = parsed;
        }
        return new(EditName.Text, EditAvailability.SelectedItem as string, priority, MergeEditedData());
    }

    private async void ReviewClicked(object sender, RoutedEventArgs e)
    {
        if (_operatorAction is not null) await ReviewOperatorActionAsync(); else ReviewDraft();
    }
    private bool ReviewDraft()
    {
        if (_service is null || _detail is null || !_editing || _saving) return false;
        try
        {
            _review = _service.ReviewEdit(_detail, CurrentDraft());
            if (_review.Error is { } error) { EditHint.Text = error; SaveButton.Visibility = Visibility.Collapsed; return false; }
            if (_review.Request is null)
            { EditHint.Text = _review.Summary; SaveButton.Visibility = Visibility.Collapsed; return false; }
            EditHint.Text = "REVIEW BEFORE SAVE\n" + _review.Summary + "\nThe stored record is changed only when Save is pressed.";
            SaveButton.Visibility = Visibility.Visible;
            Dispatcher.BeginInvoke(() => EditorPanel.ScrollToBottom(),
                System.Windows.Threading.DispatcherPriority.Loaded);
            SetStatus("Change reviewed · confirm Save or Discard");
            return true;
        }
        catch (Exception error) { EditHint.Text = "Review failed · " + error.Message; return false; }
    }

    private async void SaveClicked(object sender, RoutedEventArgs e) => await SaveDraftAsync();
    private async Task<bool> SaveDraftAsync()
    {
        if (_operatorAction is not null) return await SaveOperatorActionAsync();
        if (_service is null || _saving || !_editing) return false;
        if (_review?.Request is null)
        {
            if (ReviewDraft()) SetStatus("Review the draft, then press Save to submit the exact request.");
            return false;
        }
        var frozen = _review!.Request!;
        var priorRevision = _library?.Revision;
        _saving = true;
        SetEditorBusy(true);
        SetStatus("Saving exact reviewed request " + frozen.RequestId + "…");
        try
        {
            var result = await _service.SaveAsync(frozen, _lifetime.Token);
            _saving = false;
            if (!_disposed) SetEditorBusy(false);
            if (_closingAfterSave || _disposed) return false;
            if (!result.Saved)
            {
                EditHint.Text = (result.RequiresRecovery ? "Save outcome unknown. Exact replay is available in Pending saves. " :
                    "Save failed; draft and original basis retained. ") + result.Error;
                SetStatus(EditHint.Text);
                return false;
            }
            _editing = false; _draftDirty = false; _review = null;
            SetDetailActions(true);
            UpdateContinueState();
            SetStatus("Saved " + frozen.RecordId + " · request " + frozen.RequestId);
            var refresh = await RefreshAsync(afterSave: true);
            if (_disposed || _closingAfterSave) return true;
            if (refresh.Complete && refresh.Revision == priorRevision)
                refresh = refresh with { Complete = false,
                    Error = "Library revision did not advance after the confirmed save." };
            SetStatus(SavedRefreshStatus.Describe(frozen, refresh) +
                (result.RequiresRecovery && result.Error is { } warning ? " " + warning : ""));
            return true;
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.Save, error);
            if (_closingAfterSave || _disposed) return false;
            EditHint.Text = "Save did not complete; inspect Pending saves before another attempt. " + error.Message;
            SetStatus(EditHint.Text); return false;
        }
        finally { _saving = false; if (!_disposed) SetEditorBusy(false); }
    }

    private void SetEditorBusy(bool busy)
    {
        foreach (var control in new Control[] { EditName, EditAvailability, EditPriority, EditData,
            ReviewButton, CancelEditButton, SaveButton }) control.IsEnabled = !busy;
        foreach (var control in _scalarEditors.Values) control.IsEnabled = !busy;
        foreach (var control in _operatorFields.Values) control.IsEnabled = !busy;
        CommandFields.IsEnabled = !busy;
        NewActionButton.IsEnabled = !busy && _service?.Capabilities?.Version == 1;
    }

    private void CancelEditClicked(object sender, RoutedEventArgs e) => DiscardDraft();
    private void DiscardDraft()
    {
        var retainedCapture = _captureSavedId;
        if (_saving) { SetStatus("Save is in flight; keep the draft until its outcome is known."); return; }
        if (!_editing) return;
        _operatorReviewGeneration++;
        if (_preparingAction) { _preparingAction = false; SetEditorBusy(false); }
        _editing = false; _draftDirty = false; _review = null;
        _operatorAction = null; _operatorFields.Clear(); _operatorHint = null;
        _operatorRequestPreview = null;
        SetDetailActions(_selectedRecord is not null);
        UpdateContinueState();
        if (_selectedRecord is not null) RenderRecordDetail(); else ClearDetailForNavigation();
        if (retainedCapture is not null) {
            DetailTitle.Text = "Saved record retained";
            DetailMeta.Text = retainedCapture;
            DetailText.Text = "The record was saved. Its association was not saved.\n\nResume with Capture / link → Link existing record and use this exact ID:\n" + retainedCapture +
                "\n\nReview the association against fresh intent and evidence reads before Save.";
            SetDetailActions(false); ShowDetailPane();
        }
        SetStatus(retainedCapture is not null ? "Saved record retained · " + retainedCapture + ". Resume with Capture / link → Link existing record." : "Draft discarded; stored record unchanged.");
    }
    private void DraftChanged(object sender, TextChangedEventArgs e) => MarkDraftChanged();
    private void DraftSelectionChanged(object sender, SelectionChangedEventArgs e) => MarkDraftChanged();
    private void MarkDraftChanged()
    {
        if (_settingDraft || !_editing || _saving) return;
        _draftDirty = true; _review = null;
        SaveButton.Visibility = Visibility.Collapsed;
        EditHint.Text = "Draft changed. Review again before saving.";
        UpdateContinueState();
    }

    private bool CanLeaveDraft()
    {
        if (_loading && !_allowLoadNavigation) { SetStatus("Wait for the current library read to finish."); return false; }
        if (_continuing) { SetStatus("Wait for the current library batch to finish."); return false; }
        if (_saving || _preparingAction) { SetStatus("Wait for the current review or save to finish."); return false; }
        if (!_editing) return true;
        if (!_draftDirty) { DiscardDraft(); return true; }
        var answer = MessageBox.Show(this, "Review this draft before leaving? Yes shows the exact change for a separate Save; No discards it.",
            "Unsaved Lodestar correction", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
        if (answer == MessageBoxResult.No) { DiscardDraft(); return true; }
        if (answer == MessageBoxResult.Yes) ReviewClicked(this, new RoutedEventArgs());
        return false;
    }

    private void BackClicked(object sender, RoutedEventArgs e) => ReturnFromDetail();
    private void OnLoaded(object sender, RoutedEventArgs e) => ApplyResponsiveLayout();
    private void OnSizeChanged(object sender, SizeChangedEventArgs e) => ApplyResponsiveLayout();
    private void ApplyResponsiveLayout()
    {
        if (DetailColumn is null) return;
        var wasCompact = _compact;
        var wasVisible = DetailBorder.Visibility == Visibility.Visible;
        if (!_compact && ActualWidth < 1180) RememberInspectorWidth();
        _compact = ActualWidth < 1180;
        if (_compact)
        {
            var showing = _inspectorActive && _showingCompactDetail;
            MainColumn.Width = showing ? new GridLength(0) : new GridLength(1, GridUnitType.Star);
            DetailColumn.MinWidth = 0;
            DetailColumn.MaxWidth = double.PositiveInfinity;
            DetailColumn.Width = showing ? new GridLength(1, GridUnitType.Star) : new GridLength(0);
            DetailBorder.Visibility = showing ? Visibility.Visible : Visibility.Collapsed;
            MainPane.Visibility = showing ? Visibility.Collapsed : Visibility.Visible;
            DetailSplitter.Visibility = Visibility.Collapsed;
            DetailSplitterColumn.Width = new GridLength(0);
            BackButton.Visibility = showing ? Visibility.Visible : Visibility.Collapsed;
        }
        else
        {
            MainColumn.Width = new GridLength(1, GridUnitType.Star);
            MainPane.Visibility = Visibility.Visible;
            DetailColumn.MinWidth = _inspectorActive ? 300 : 0;
            DetailColumn.MaxWidth = 600;
            if (_inspectorActive && (wasCompact || !wasVisible))
                DetailColumn.Width = new GridLength(_preferredInspectorWidth);
            else if (!_inspectorActive) DetailColumn.Width = new GridLength(0);
            DetailBorder.Visibility = _inspectorActive ? Visibility.Visible : Visibility.Collapsed;
            DetailSplitter.Visibility = _inspectorActive ? Visibility.Visible : Visibility.Collapsed;
            DetailSplitterColumn.Width = _inspectorActive ? new GridLength(5) : new GridLength(0);
            BackButton.Visibility = Visibility.Collapsed;
        }
        OpenInspectorButton.Visibility = !_inspectorActive &&
            (_selectedRecord is not null || _selectedIssue is not null || _operation is not null || _pending is not null)
            ? Visibility.Visible : Visibility.Collapsed;
    }
    private async void OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.F)
        {
            var search = _workspace == "search" ? AllRecordSearch : SearchBox;
            search.Focus(); search.SelectAll(); e.Handled = true;
        }
        else if (e.Key == Key.F5) { e.Handled = true; await RefreshAsync(); }
        else if (Keyboard.Modifiers == ModifierKeys.Control && e.Key == Key.S && _editing)
        { e.Handled = true; if (_review?.Request is null) ReviewClicked(this, new RoutedEventArgs()); else await SaveDraftAsync(); }
        else if (Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Alt) && e.Key == Key.Left)
        { e.Handled = true; ReturnFromDetail(); }
        else if (Keyboard.Modifiers == (ModifierKeys.Control | ModifierKeys.Alt) && e.Key == Key.D0)
        { e.Handled = true; ResetInspectorClicked(this, new RoutedEventArgs()); }
        else if (e.Key == Key.Escape)
        {
            if (_editing) { if (CanLeaveDraft()) e.Handled = true; }
            else if (_showingCompactDetail) { ReturnFromDetail(); e.Handled = true; }
        }
    }
    private void QueueApprovedClose()
    {
        if (_closeQueued || _shutdownStarted || _disposed) return;
        _closeApproved = true;
        _closeQueued = true;
        Dispatcher.BeginInvoke(() =>
        {
            _closeQueued = false;
            if (!_shutdownStarted && !_disposed) Close();
        }, System.Windows.Threading.DispatcherPriority.Background);
    }

    private async void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_disposed) return;
        e.Cancel = true;
        if (_shutdownStarted) return;
        if (_saving && !_closeApproved)
        {
            var leave = MessageBox.Show(this,
                "The save is in flight. Its exact request is retained in Pending saves. Leave now with an uncertain outcome?",
                "Save outcome may be unknown", MessageBoxButton.YesNo, MessageBoxImage.Warning);
            if (leave == MessageBoxResult.Yes) { _closingAfterSave = true; QueueApprovedClose(); }
            return;
        }
        if (!_closeApproved && _editing)
        {
            if (!_draftDirty) { DiscardDraft(); QueueApprovedClose(); return; }
            var answer = MessageBox.Show(this, _review?.Request is null ?
                "Review this draft before closing? Yes shows the change for a separate Save; No discards it." :
                "Save this reviewed draft before closing?",
                "Unsaved Lodestar correction", MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (answer == MessageBoxResult.Cancel) return;
            if (answer == MessageBoxResult.No) { DiscardDraft(); QueueApprovedClose(); return; }
            if (_review?.Request is null) { ReviewClicked(this, new RoutedEventArgs()); return; }
            if (await SaveDraftAsync()) QueueApprovedClose();
            return;
        }
        _shutdownStarted = true;
        SystemParameters.StaticPropertyChanged -= OnSystemParametersChanged;
        _ = Dispatcher.BeginInvoke(async () =>
        {
            try
            {
                _lifetime.Cancel();
                if (_service is not null) await _service.DisposeAsync();
            }
            catch (Exception error) { App.LogFailure(DiagnosticOperation.Shutdown, error); SetStatus("Shutdown cleanup failed · " + error.Message); }
            finally
            {
                _disposed = true;
                Application.Current.Shutdown();
            }
        }, System.Windows.Threading.DispatcherPriority.Background);
    }

    // Test-only connected-client capture. It reads the supplied runtime and never submits a mutation.
    public async Task CaptureSmokeAsync(string captureDirectory)
    {
        if (_library is null || _library.Error is not null || _library.Projects.IsDefaultOrEmpty ||
            _library.Records.IsDefaultOrEmpty)
            throw new InvalidDataException("Smoke fixture did not load a complete project and record view: " +
                (_library?.Error ?? "no fixture records"));
        var loadedSnapshot = _library;
        Directory.CreateDirectory(captureDirectory);
        var evidence = new List<object>();
        async Task Capture(string state, double width, double height)
        {
            Width = width; Height = height;
            await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
            ClientRoot.UpdateLayout();
            var dpi = VisualTreeHelper.GetDpi(ClientRoot);
            var pixelsWide = Math.Max(1, (int)Math.Ceiling(ClientRoot.ActualWidth * dpi.DpiScaleX));
            var pixelsHigh = Math.Max(1, (int)Math.Ceiling(ClientRoot.ActualHeight * dpi.DpiScaleY));
            var bitmap = new RenderTargetBitmap(pixelsWide, pixelsHigh, dpi.PixelsPerInchX,
                dpi.PixelsPerInchY, PixelFormats.Pbgra32);
            bitmap.Render(ClientRoot);
            var filename = state + "-" + (int)width + "x" + (int)height + ".png";
            var path = Path.Combine(captureDirectory, filename);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            await using (var stream = File.Create(path)) encoder.Save(stream);
            evidence.Add(new { state, widthDip = width, heightDip = height,
                clientWidthDip = ClientRoot.ActualWidth, clientHeightDip = ClientRoot.ActualHeight,
                pixelsWide, pixelsHigh, path, status = StatusText.Text,
                project = _project?.Id, record = _selectedRecord?.Id, workspace = _workspace });
        }
        _workspace = "health"; _project = null; ConfigureWorkspace();
        await Capture("health", 1440, 900);
        await Capture("health", 1100, 750);
        await Capture("health", 900, 600);
        _workspace = "projects"; ConfigureWorkspace();
        await Capture("library", 1440, 900);
        await Capture("library", 900, 600);
        SearchBox.Text = "smoke-no-matching-project"; ApplyFilters();
        await Capture("no-match", 1440, 900);
        SearchBox.Clear(); ApplyFilters();
        await LoadHistoricalProjectsAsync();
        HistoryToggle.IsChecked = true;
        await Capture("historical-library", 1440, 900);
        HistoryToggle.IsChecked = false;
        if (_library?.Projects.FirstOrDefault() is { } first)
        {
            await SelectProjectAsync(first);
            await Capture("project", 1440, 900);
            MainTabs.SelectedIndex = 3; await Capture("work", 1440, 900);
            MainTabs.SelectedIndex = 4; await Capture("decisions", 900, 600);
            MainTabs.SelectedIndex = 2; await Capture("activity", 900, 600);
            MainTabs.SelectedIndex = 0;
            if (AssociatedRecords(first).FirstOrDefault() is { } record)
            {
                await SelectRecordAsync(record);
                await Capture("detail", 1440, 900);
                if (_detail is not null && RecordEditor.CanEdit(_detail, out _) && _service?.Capabilities?.Version == 1)
                {
                    EditClicked(this, new RoutedEventArgs());
                    await Capture("editor", 1440, 900);
                    EditName.Text += " · preview";
                    if (ReviewDraft()) await Capture("review", 1440, 900);
                    DiscardDraft();
                }
                await LoadHistoryAsync();
                await Capture("history", 1440, 900);
            }
            await Capture("project", 1000, 700);
            await Capture("project", 900, 600);
            if (AssociatedRecords(first).FirstOrDefault() is { } narrowRecord)
            {
                await SelectRecordAsync(narrowRecord);
                await Capture("detail", 1000, 700);
                await Capture("detail", 900, 600);
                if (_detail is not null && RecordEditor.CanEdit(_detail, out _) && _service?.Capabilities?.Version == 1)
                {
                    EditClicked(this, new RoutedEventArgs());
                    await Capture("editor", 1000, 700);
                    await Capture("editor", 900, 600);
                    EditName.Text += " · preview";
                    if (ReviewDraft()) { await Capture("review", 1000, 700); await Capture("review", 900, 600); }
                    DiscardDraft();
                }
                ReturnFromDetail();
            }
        }
        ClearDetailForNavigation(); _workspace = "global"; ConfigureWorkspace(); await Capture("global", 1440, 900);
        if (loadedSnapshot.GlobalKnowledge.FirstOrDefault() is { } globalRecord)
        {
            await SelectRecordAsync(globalRecord);
            await LoadHistoryAsync();
            await Capture("history-no-versions", 1440, 900);
        }
        ClearDetailForNavigation(); _workspace = "commands"; ConfigureWorkspace();
        if (_service?.Capabilities?.Operations.FirstOrDefault(SafeGeneric) is { } command) ShowCommand(command);
        await Capture("commands", 1440, 900);
        ClearDetailForNavigation(); _workspace = "recovery"; ConfigureWorkspace(); await Capture("recovery", 1440, 900);
        ClearDetailForNavigation(); _workspace = "connection"; ConfigureWorkspace(); await Capture("connection", 1440, 900);
        ShowStartupError(new InvalidDataException("Smoke-only disconnected-state render; selected fixture remains unchanged."));
        await Capture("disconnected", 1000, 700);
        var report = new {
            v = 1, captureTime = DateTimeOffset.UtcNow, config = _service?.Runtime.ConfigPath ?? _configPath,
            database = _service?.Runtime.DatabasePath, fingerprint = _service?.Runtime.Fingerprint,
            projectsLoaded = loadedSnapshot.Projects.Length, recordsLoaded = loadedSnapshot.Records.Length,
            complete = loadedSnapshot.Complete, revision = loadedSnapshot.Revision, issues = loadedSnapshot.Issues.Length,
            captures = evidence, mutationsSubmitted = 0
        };
        await File.WriteAllTextAsync(Path.Combine(captureDirectory, "ui-smoke.json"),
            JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
    }
}
