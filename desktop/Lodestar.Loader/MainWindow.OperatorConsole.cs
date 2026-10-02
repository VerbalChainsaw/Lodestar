using System.Collections;
using System.ComponentModel;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Media;

namespace Lodestar.Loader;

public partial class MainWindow
{
    private sealed record HealthIssueUi(string Message, string ActionKey, string ActionLabel, string ActionId);
    private CliResult? _doctorResult;
    private DateTimeOffset? _doctorReadAt;
    private bool _suppressSelection;
    private bool _inspectorActive;
    private bool _continuing;
    private bool _allowLoadNavigation;
    private double _preferredInspectorWidth = 360;
    private string _projectSortPath = "Name";
    private bool _settingProjectSort;
    private ListSortDirection _projectSortDirection = ListSortDirection.Ascending;
    private string _recordSortPath = "UpdatedAt";
    private ListSortDirection _recordSortDirection = ListSortDirection.Descending;
    private readonly Dictionary<string, TextBox> _scalarEditors = new(StringComparer.Ordinal);
    private bool _syncingScalar;

    private void InitializeOperatorConsole()
    {
        ProjectGroup.SelectedIndex = 0;
        RecordSort.SelectedIndex = 0;
        RecordGroup.SelectedIndex = 0;
        ApplyContrastTheme();
        SystemParameters.StaticPropertyChanged += OnSystemParametersChanged;
        RenderHealth();
        UpdateContinueState();
    }

    private void OnSystemParametersChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(SystemParameters.HighContrast)) ApplyContrastTheme();
    }

    private static void PutBrush(string key, Color color) =>
        Application.Current.Resources[key] = new SolidColorBrush(color);

    private void ApplyContrastTheme()
    {
        if (SystemParameters.HighContrast)
        {
            var resources = Application.Current.Resources;
            resources["Ink"] = SystemColors.WindowTextBrush;
            resources["Muted"] = SystemColors.WindowTextBrush;
            resources["Warm"] = SystemColors.WindowBrush;
            resources["Pane"] = SystemColors.WindowBrush;
            resources["InkSoft"] = SystemColors.ControlBrush;
            resources["Input"] = SystemColors.ControlBrush;
            resources["Line"] = SystemColors.ControlDarkBrush;
            resources["Hover"] = SystemColors.ControlBrush;
            resources["Selection"] = SystemColors.ControlBrush;
            resources["Teal"] = SystemColors.HighlightBrush;
            resources["Focus"] = SystemColors.HighlightBrush;
            return;
        }
        PutBrush("Ink", Color.FromRgb(0xE7, 0xED, 0xF4));
        PutBrush("Muted", Color.FromRgb(0xAA, 0xB9, 0xCA));
        PutBrush("Warm", Color.FromRgb(0x11, 0x16, 0x1F));
        PutBrush("Pane", Color.FromRgb(0x14, 0x1B, 0x26));
        PutBrush("InkSoft", Color.FromRgb(0x1B, 0x23, 0x30));
        PutBrush("Input", Color.FromRgb(0x1B, 0x23, 0x30));
        PutBrush("Line", Color.FromRgb(0x2A, 0x35, 0x43));
        PutBrush("Hover", Color.FromRgb(0x26, 0x34, 0x46));
        PutBrush("Selection", Color.FromRgb(0x24, 0x49, 0x40));
        PutBrush("Teal", Color.FromRgb(0x5C, 0xE0, 0xC0));
        PutBrush("Focus", Color.FromRgb(0x8F, 0xE8, 0xD3));
    }

    private void RenderHealth()
    {
        IReadOnlyList<PendingSave>? pending = null;
        try {
            var listing = _service?.ReadPendingSaves();
            if (listing?.Error is { } recoveryError) SetStatus(recoveryError);
            else pending = listing?.Items;
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.Recovery, error); SetStatus("Pending save journal could not be read · " + error.Message); }
        var snapshot = LodestarHealth.Build(_library, _service?.Capabilities, pending, _doctorResult);
        HealthHeadline.Text = snapshot.Headline + (_doctorReadAt is { } at ? $" · doctor read {at.ToLocalTime():g}" : "");
        HealthSourceText.Text = $"Source: selected Lodestar CLI · library read {_library?.ReadAt.ToLocalTime().ToString("g") ?? "not checked"}" +
            $" · capabilities read {_service?.Capabilities?.ReadAt.ToLocalTime().ToString("g") ?? "not checked"}";
        string[] firstChecks = ["Library read", "Store integrity", "Doctor result", "SQLite integrity",
            "Unresolved saves", "Store revision", "Current records", "Projects", "Unassigned records"];
        string[] connectionDetails = ["Store instance", "Store epoch", "Runtime generation", "Selected CLI",
            "Lodestar release version"];
        HealthObservations.ItemsSource = snapshot.Observations
            .Where(item => !connectionDetails.Contains(item.Label))
            .OrderBy(item => Array.IndexOf(firstChecks, item.Label) is var order && order >= 0 ? order : 100)
            .ToArray();
        HealthIssues.ItemsSource = snapshot.Issues.Select((issue, index) => new HealthIssueUi(issue.Message,
            issue.ActionKey, issue.ActionKey switch
            {
                "refresh" => "Refresh", "doctor" => "Run check", "pending-saves" => "Pending saves",
                "connection" => "Connection", "record-errors" => "Record errors", _ => "Inspect"
            }, $"HealthAction_{issue.ActionKey}_{index}")).ToArray();
        HealthIssuesEmpty.Visibility = snapshot.Issues.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        HealthIssuesRow.Height = new GridLength(snapshot.Issues.Length == 0 ? 36 :
            Math.Clamp(snapshot.Issues.Length * 44, 48, 144));
        RenderHealthActivity();
        if (_workspace == "health")
        {
            PageTitle.Text = "Health";
            PageSubtitle.Text = "Lodestar observations from the selected runtime. Checks describe their recorded moment.";
            MetricOne.Text = snapshot.Headline;
            MetricTwo.Text = snapshot.Issues.Length == 0 ? "No issues in observed results" :
                $"{snapshot.Issues.Length} issue actions";
            MetricThree.Text = _doctorReadAt is null ? "Store integrity: Not checked" :
                $"Doctor read {_doctorReadAt.Value.ToLocalTime():g}";
        }
    }

    private void RenderHealthActivity()
    {
        var search = SearchBox.Text.Trim();
        var priorSuppression = _suppressSelection;
        _suppressSelection = true;
        try
        {
            HealthActivity.ItemsSource = _library?.Records.Where(record => search.Length == 0 || Matches(record, search))
                .OrderByDescending(record => record.UpdatedAt).Take(24).Select(record => (object)ToRow(record))
                .ToArray() ?? [];
        }
        finally { _suppressSelection = priorSuppression; }
        HealthActivity.ToolTip = "Recent loaded records" + (search.Length > 0 ? " matching the finder" : "");
    }

    private void HealthClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "health";
        ConfigureWorkspace();
    }

    private void RecordsClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        if (_project is null) { ProjectsClicked(sender, e); SetStatus("Select a project, then open Records."); return; }
        ClearDetailForNavigation();
        _workspace = "projects";
        ConfigureWorkspace();
        MainTabs.SelectedIndex = 1;
    }

    private void UpdateProjectNavigation()
    {
        var selected = _project is not null;
        RecordsButton.IsEnabled = selected;
        RecordsButton.ToolTip = selected ? "Browse and edit records for " + _project!.Name :
            "Select a project from the library first";
        ToolTipService.SetShowOnDisabled(RecordsButton, true);
        AllProjectsButton.Visibility = selected && _workspace == "projects" ? Visibility.Visible : Visibility.Collapsed;
        foreach (var tab in MainTabs.Items.OfType<TabItem>().Skip(1))
        {
            tab.IsEnabled = selected || _workspace == "search" && MainTabs.Items.IndexOf(tab) == 1;
            tab.ToolTip = selected ? null : "Select a project to open this workspace";
            ToolTipService.SetShowOnDisabled(tab, true);
        }
        if (!selected && _workspace != "search" && MainTabs.SelectedIndex > 0) MainTabs.SelectedIndex = 0;
        SearchPlaceholder.Text = _workspace switch
        {
            "commands" => "Find command",
            "global" => "Find global record",
            _ => selected ? "Find project / record" : "Find project"
        };
        SearchBox.IsEnabled = _workspace is not ("connection" or "recovery");
    }

    private void UpdateProjectNavigationTags()
    {
        var projectRecords = _workspace == "projects" && _project is not null && MainTabs.SelectedIndex == 1;
        ProjectsButton.Tag = _workspace == "projects" && !projectRecords ? "active" : null;
        RecordsButton.Tag = projectRecords ? "active" : null;
    }

    private async void HealthIssueClicked(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string key }) return;
        switch (key)
        {
            case "refresh": await RefreshAsync(); break;
            case "doctor": await RunDoctorAsync(); break;
            case "pending-saves": RecoveryClicked(sender, e); break;
            case "connection": ConnectionClicked(sender, e); break;
            case "record-errors":
                if (!CanLeaveDraft()) return;
                ClearDetailForNavigation();
                _workspace = "record-errors";
                ConfigureWorkspace();
                break;
        }
    }

    private async void DoctorClicked(object sender, RoutedEventArgs e) => await RunDoctorAsync();

    private async Task RunDoctorAsync()
    {
        var service = _service;
        if (service is null || _loading || _saving || _switchingRuntime)
        { SetStatus("Select a ready runtime and wait for active operations before running doctor."); return; }
        var operation = service.Capabilities?.Operations.FirstOrDefault(item => item.Id == "doctor");
        if (operation is null || !operation.CanRunGenericRead || operation.Effect != "read")
        { SetStatus("The selected core did not describe a safe public doctor read."); return; }
        if (JsonData.TryArray(operation.Description, "parameters", out var parameters) &&
            parameters.EnumerateArray().Any(item => JsonData.TryBool(item, "required", out var required) && required))
        { SetStatus("Doctor requires described inputs; use Commands to supply them explicitly."); return; }
        DoctorButton.IsEnabled = false;
        SetStatus("Running explicit Lodestar doctor read…");
        try
        {
            var result = await service.RunReadAsync(operation,
                new Dictionary<string, string?>(StringComparer.Ordinal), _lifetime.Token);
            if (_disposed || !ReferenceEquals(service, _service)) return;
            _doctorResult = result;
            _doctorReadAt = DateTimeOffset.Now;
            RenderHealth();
            SetStatus(result.Success ? "Lodestar doctor result read · " + _doctorReadAt.Value.ToString("g") :
                "Lodestar doctor read failed · " + result.Message);
        }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.Doctor, error); if (!_disposed) SetStatus("Lodestar doctor read failed · " + error.Message); }
        finally { if (!_disposed) DoctorButton.IsEnabled = true; }
    }

    private void UpdateContinueState()
    {
        if (ContinueButton is null) return;
        ContinueButton.Visibility = _library?.HasMore == true && _library.CanContinue
            ? Visibility.Visible : Visibility.Collapsed;
        ContinueButton.IsEnabled = _library?.CanContinue == true &&
            !_loading && !_editing && !_saving && !_switchingRuntime;
        ContinueButton.ToolTip = _library?.HasMore == true && !_library.CanContinue
            ? "The source changed or the cursor is unavailable. Refresh to restart the read." :
            "Load the next validated batch from the selected Lodestar runtime.";
    }

    private async void ContinueClicked(object sender, RoutedEventArgs e) => await ContinueLibraryUiAsync();

    private async Task ContinueLibraryUiAsync()
    {
        var service = _service;
        if (service is null || _library?.CanContinue != true || _loading || _editing || _saving ||
            _switchingRuntime || _shutdownStarted) return;
        var priorProject = _project?.Id;
        var priorRecord = _selectedRecord?.Id;
        var priorIssue = _selectedIssue?.Id;
        var generation = ++_generation;
        ++_projectContextGeneration;
        _loading = true;
        _continuing = true;
        ProjectList.IsEnabled = DashboardList.IsEnabled = RecordList.IsEnabled = HealthActivity.IsEnabled = SpecialList.IsEnabled = false;
        UpdateContinueState();
        SetStatus("Continuing the validated Lodestar library read…");
        try
        {
            var loaded = await service.ContinueLibraryAsync(_lifetime.Token);
            if (_disposed || generation != _generation || !ReferenceEquals(service, _service)) return;
            _continuing = false;
            _library = loaded;
            _recordSearchCache.Clear();
            _project = priorProject is null ? null : loaded.Projects.Concat(_historicalProjects)
                .FirstOrDefault(item => item.Id == priorProject);
            ApplyFilters();
            ConfigureWorkspace();
            if (_project is { } project) await ValidateContextAsync(project);
            await RestoreSelectionAfterLibraryReadAsync(loaded, priorRecord, priorIssue);
            SetStatus(loaded.Error is { } error ? "Continuation stopped · " + error :
                $"Read {loaded.LoadedCount:N0} rows · {(loaded.Complete ? "complete" : "partial; continue available")}");
        }
        catch (OperationCanceledException) { if (!_disposed) SetStatus("Continuation cancelled."); }
        catch (Exception error) { App.LogFailure(DiagnosticOperation.LibraryLoad, error); if (!_disposed) SetStatus("Continuation failed · " + error.Message); }
        finally
        {
            _continuing = false;
            _allowLoadNavigation = false;
            _loading = false;
            if (!_disposed && ReferenceEquals(service, _service))
            {
                ProjectList.IsEnabled = DashboardList.IsEnabled = RecordList.IsEnabled = HealthActivity.IsEnabled = SpecialList.IsEnabled = true;
                UpdateContinueState(); RenderHealth();
            }
        }
    }

    private void ApplyProjectView()
    {
        if (DashboardList.ItemsSource is null) return;
        var view = CollectionViewSource.GetDefaultView(DashboardList.ItemsSource);
        if (view is null) return;
        var priorSuppression = _suppressSelection;
        _suppressSelection = true;
        try
        {
            using (view.DeferRefresh())
            {
                view.SortDescriptions.Clear();
                view.SortDescriptions.Add(new SortDescription(_projectSortPath, _projectSortDirection));
                view.GroupDescriptions.Clear();
                var group = (ProjectGroup.SelectedItem as ComboBoxItem)?.Content?.ToString();
                if (group == "Status") view.GroupDescriptions.Add(new PropertyGroupDescription("GroupStatus"));
                if (group == "Lifecycle") view.GroupDescriptions.Add(new PropertyGroupDescription("Lifecycle"));
            }
        }
        finally { _suppressSelection = priorSuppression; }
    }

    private void ApplyRecordView()
    {
        if (RecordList.ItemsSource is null) return;
        var view = CollectionViewSource.GetDefaultView(RecordList.ItemsSource);
        if (view is null) return;
        var selected = _selectedRecord?.Id;
        var priorSuppression = _suppressSelection;
        _suppressSelection = true;
        try
        {
            using (view.DeferRefresh())
            {
                view.SortDescriptions.Clear();
                view.SortDescriptions.Add(new SortDescription(_recordSortPath, _recordSortDirection));
                view.GroupDescriptions.Clear();
                var group = (RecordGroup.SelectedItem as ComboBoxItem)?.Content?.ToString();
                if (group == "State") view.GroupDescriptions.Add(new PropertyGroupDescription("State"));
                if (group == "Kind") view.GroupDescriptions.Add(new PropertyGroupDescription("Kind"));
                if (group == "Lifecycle") view.GroupDescriptions.Add(new PropertyGroupDescription("Lifecycle"));
                if (group == "Availability") view.GroupDescriptions.Add(new PropertyGroupDescription("Availability"));
                if (group == "Scope") view.GroupDescriptions.Add(new PropertyGroupDescription("Scope"));
            }
            if (selected is not null && RecordList.Items.OfType<RecordRow>().FirstOrDefault(
                item => item.Record.Id == selected) is { } row)
                RecordList.SelectedItem = row;
        }
        finally { _suppressSelection = priorSuppression; }
    }

    private void ProjectGroupChanged(object sender, SelectionChangedEventArgs e) => ApplyProjectView();
    private void RecordViewChanged(object sender, SelectionChangedEventArgs e)
    {
        if (sender == RecordSort)
        {
            (_recordSortPath, _recordSortDirection) = RecordSort.SelectedIndex switch
            {
                1 => ("Name", ListSortDirection.Ascending),
                2 => ("Kind", ListSortDirection.Ascending),
                _ => ("UpdatedAt", ListSortDirection.Descending)
            };
        }
        ApplyRecordView();
    }

    private void ProjectGridSorting(object sender, DataGridSortingEventArgs e)
    {
        _projectSortPath = e.Column.SortMemberPath;
        _projectSortDirection = e.Column.SortDirection == ListSortDirection.Ascending
            ? ListSortDirection.Descending : ListSortDirection.Ascending;
        foreach (var column in DashboardList.Columns) column.SortDirection = null;
        e.Column.SortDirection = _projectSortDirection;
        e.Handled = true;
        _settingProjectSort = true;
        ProjectSort.SelectedIndex = _projectSortPath switch
        {
            "UpdatedAt" => 1, "Status" => 2, "CountValue" => 3, _ => 0
        };
        _settingProjectSort = false;
        ApplyFilters();
    }

    private void RecordGridSorting(object sender, DataGridSortingEventArgs e)
    {
        _recordSortPath = e.Column.SortMemberPath;
        _recordSortDirection = e.Column.SortDirection == ListSortDirection.Ascending
            ? ListSortDirection.Descending : ListSortDirection.Ascending;
        foreach (var column in RecordList.Columns) column.SortDirection = null;
        e.Column.SortDirection = _recordSortDirection;
        e.Handled = true;
        ApplyRecordView();
    }

    private void ResetProjectViewClicked(object sender, RoutedEventArgs e)
    {
        _projectSortPath = "Name";
        _projectSortDirection = ListSortDirection.Ascending;
        ProjectSort.SelectedIndex = 0;
        ProjectGroup.SelectedIndex = 0;
        SearchBox.Clear();
        ApplyFilters();
    }

    private void ResetRecordViewClicked(object sender, RoutedEventArgs e)
    {
        KindFilter.SelectedIndex = AvailabilityFilter.SelectedIndex = LifecycleFilter.SelectedIndex = 0;
        RecordSort.SelectedIndex = 0;
        RecordGroup.SelectedIndex = 0;
        SearchBox.Clear();
        _recordSortPath = "UpdatedAt";
        _recordSortDirection = ListSortDirection.Descending;
        AllRecordSearch.Clear();
        if (_workspace == "search") FillAllRecords(); else FillProjectLists();
    }

    private void RenderReadableRecord(LibraryRecord record)
    {
        var readout = ReadableRecord.Project(record);
        DetailTitle.Text = readout.Headline;
        DetailMeta.Text = $"{readout.KindLabel} · {record.Id}\n{record.Scope} · saved {record.UpdatedAt?.ToLocalTime().ToString("g") ?? "date unknown"}";
        ReadoutState.Text = readout.State;
        ReadoutSummary.Text = readout.Summary;
        ReadoutLimit.Text = readout.LimitNotice ?? "";
        // Put the record's useful content before identity already shown in the header.
        ReadoutSections.ItemsSource = readout.Sections.OrderBy(section => section.Heading == "Stored identity" ? 1 : 0).ToArray();
        DetailText.Visibility = Visibility.Collapsed;
        CommandPanel.Visibility = Visibility.Collapsed;
        EditorPanel.Visibility = Visibility.Collapsed;
        ReadablePanel.Visibility = Visibility.Visible;
        ReadablePanel.ScrollToTop();
    }

    private void PrepareScalarEditors()
    {
        ScalarFields.Children.Clear();
        _scalarEditors.Clear();
        AdvancedDataExpander.IsExpanded = true;
        if (JsonNode.Parse(EditData.Text) is not JsonObject data) return;
        foreach (var key in new[] { "status", "summary", "description", "notes" })
        {
            if (!data.TryGetPropertyValue(key, out var node) || node is not JsonValue value ||
                !value.TryGetValue<string>(out var text)) continue;
            var label = new TextBlock { Text = char.ToUpperInvariant(key[0]) + key[1..],
                Margin = new Thickness(0, 5, 0, 2) };
            var box = new TextBox { Text = text, Tag = key,
                TextWrapping = key == "notes" || key == "description" ? TextWrapping.Wrap : TextWrapping.NoWrap };
            if (key is "notes" or "description") { box.AcceptsReturn = true; box.MinHeight = 54; }
            System.Windows.Automation.AutomationProperties.SetName(box, "Record " + key);
            System.Windows.Automation.AutomationProperties.SetAutomationId(box, "EditScalar_" + key);
            box.TextChanged += DirectScalarChanged;
            _scalarEditors[key] = box;
            ScalarFields.Children.Add(label);
            ScalarFields.Children.Add(box);
        }
        AdvancedDataExpander.IsExpanded = _scalarEditors.Count == 0;
    }

    private void DirectScalarChanged(object sender, TextChangedEventArgs e)
    {
        if (_settingDraft || _syncingScalar || sender is not TextBox { Tag: string key } box) return;
        try
        {
            if (JsonNode.Parse(EditData.Text) is not JsonObject data)
                throw new JsonException("Advanced data must be a JSON object.");
            data[key] = box.Text;
            _syncingScalar = true;
            EditData.Text = data.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            _syncingScalar = false;
            MarkDraftChanged();
        }
        catch (JsonException error)
        {
            _syncingScalar = false;
            EditHint.Text = "Repair advanced JSON before using direct fields: " + error.Message;
            foreach (var editor in _scalarEditors.Values) editor.IsEnabled = false;
        }
    }

    private void EditDataChanged(object sender, TextChangedEventArgs e)
    {
        if (_settingDraft || _syncingScalar || !_editing) return;
        string? problem = null;
        try
        {
            if (JsonNode.Parse(EditData.Text) is JsonObject data)
            {
                _syncingScalar = true;
                foreach (var (key, box) in _scalarEditors)
                {
                    box.IsEnabled = !_saving;
                    if (data[key] is JsonValue value && value.TryGetValue<string>(out var text))
                        box.Text = text;
                    else box.IsEnabled = false;
                }
                _syncingScalar = false;
            }
            else
            {
                foreach (var box in _scalarEditors.Values) box.IsEnabled = false;
                problem = "Advanced data must remain a JSON object.";
            }
        }
        catch (JsonException error)
        {
            _syncingScalar = false;
            foreach (var box in _scalarEditors.Values) box.IsEnabled = false;
            problem = "Advanced JSON is incomplete: " + error.Message;
        }
        MarkDraftChanged();
        if (problem is not null) EditHint.Text = problem + " Repair it before Review.";
    }

    private void CollapseInspectorClicked(object sender, RoutedEventArgs e) => ReturnFromDetail();
    private void OpenInspectorClicked(object sender, RoutedEventArgs e) => ShowDetailPane();
    private void ResetInspectorClicked(object sender, RoutedEventArgs e)
    {
        _preferredInspectorWidth = 360;
        if (!_compact && _inspectorActive) DetailColumn.Width = new GridLength(_preferredInspectorWidth);
    }

    private void RememberInspectorWidth()
    {
        if (!_compact && DetailBorder.Visibility == Visibility.Visible && DetailColumn.ActualWidth >= 300)
            _preferredInspectorWidth = Math.Clamp(DetailColumn.ActualWidth, 300, 600);
    }

    private void FillRecordErrors()
    {
        var issues = _library?.Issues.Select(item => (object)new IssueRow(item)) ?? [];
        var errors = _library?.RecordErrors.Select(item => (object)new NoteRow(item)) ?? [];
        var rows = issues.Concat(errors).ToArray();
        SpecialList.ItemsSource = rows.Length > 0 ? rows :
            [new NoteRow("No normalization or correction errors in the loaded library read.")];
    }
}
