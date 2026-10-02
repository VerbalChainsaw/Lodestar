using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace Lodestar.Loader;

public partial class MainWindow
{
    private string? _operatorAction;
    private readonly Dictionary<string, TextBox> _operatorFields = new(StringComparer.Ordinal);
    private TextBlock? _operatorHint;
    private bool _preparingAction;
    private int _operatorReviewGeneration;
    private string _lastOperatorAuthor = "";
    private Expander? _operatorRequestPreview;

    private void SearchAllClicked(object sender, RoutedEventArgs e)
    {
        if (!CanLeaveDraft()) return;
        ClearDetailForNavigation();
        _workspace = "search";
        ConfigureWorkspace();
        AllRecordSearch.Focus();
    }

    private void FirstProjectClicked(object sender, RoutedEventArgs e) => BeginOperatorAction("project");
    private void ReviewSourceClicked(object sender, RoutedEventArgs e) => BeginOperatorAction("research-review");

    private void AllRecordSearchChanged(object sender, TextChangedEventArgs e)
    {
        if (_workspace == "search" && _library is not null) FillAllRecords();
    }

    private void FillAllRecords()
    {
        if (_library is null || _workspace != "search") return;
        var search = AllRecordSearch.Text.Trim();
        IEnumerable<LibraryRecord> records = _library.Records;
        if (KindFilter.SelectedItem is string kind && kind != "All kinds")
            records = records.Where(r => r.Kind == kind);
        if (AvailabilityFilter.SelectedItem is string availability && availability != "All availability")
            records = records.Where(r => r.Availability == availability);
        if (LifecycleFilter.SelectedItem is string lifecycle && lifecycle != "All lifecycle")
            records = records.Where(r => (r.Lifecycle ?? "current") == lifecycle);
        if (search.Length > 0) records = records.Where(r => Matches(r, search));
        _suppressSelection = true;
        try { RecordList.ItemsSource = Rows(records); ApplyRecordView(); }
        finally { _suppressSelection = false; }
        RecordResultCount.Text = $"{RecordList.Items.Count:N0} matches";
        PageTitle.Text = "Search all records";
        PageSubtitle.Text = "Search loaded content across projects and global knowledge. Open a row for a fresh read.";
        MetricOne.Text = $"{RecordList.Items.Count:N0} matching records";
        MetricTwo.Text = $"{_library.Records.Length:N0} records loaded";
        MetricThree.Text = _library.Complete ? "Complete loaded view" : "Partial coverage · more records may exist";
    }

    private void ConfigureRecordWorkspace()
    {
        if (AllRecordSearch is null) return;
        var search = _workspace == "search";
        SearchAllButton.Tag = search ? "active" : null;
        AllRecordSearch.Visibility = search ? Visibility.Visible : Visibility.Collapsed;
        foreach (var (tab, index) in MainTabs.Items.OfType<TabItem>().Select((tab, index) => (tab, index)))
        {
            tab.Visibility = search && index != 1 ? Visibility.Collapsed : Visibility.Visible;
            if (search && index == 1) tab.IsEnabled = true;
        }
        if (search)
        {
            var selectedKind = KindFilter.SelectedItem as string ?? "All kinds";
            var kinds = new[] { "All kinds" }.Concat((_library?.Records ?? []).Select(r => r.Kind).Distinct().Order()).ToArray();
            if (KindFilter.ItemsSource is not IEnumerable<string> prior || !prior.SequenceEqual(kinds))
            {
                KindFilter.ItemsSource = kinds;
                KindFilter.SelectedItem = kinds.Contains(selectedKind) ? selectedKind : "All kinds";
            }
            MainTabs.SelectedIndex = 1; FillAllRecords();
        }
        NewActionButton.IsEnabled = _service?.Capabilities?.Version == 1 && !_loading && !_saving && !_preparingAction;
        FirstProjectButton.Visibility = _library is { Complete: true, CatalogOnly: false, Projects.Length: 0 }
            ? Visibility.Visible : Visibility.Collapsed;
        FirstProjectButton.IsEnabled = NewActionButton.IsEnabled;
    }

    private void NewActionClicked(object sender, RoutedEventArgs e)
    {
        if (_service is null || !CanLeaveDraft()) return;
        var menu = new ContextMenu { PlacementTarget = NewActionButton };
        foreach (var (action, label) in new[] {
            ("capture-menu", "Capture / link to requirement"),
            ("project", "New project"), ("note", "Add note"), ("research", "Save research"),
            ("rejection", "Record rejected approach"), ("decision", "Record decision"),
            ("retire-pending", "Retire pending item"), ("retire-record", "Retire ordinary record") })
        {
            var needsProject = action is not "project";
            var enabled = !needsProject || _project is not null && _context?.Matched == true;
            var item = new MenuItem { Header = label, IsEnabled = enabled,
                ToolTip = enabled ? null : "Select a project with a verified root first." };
            ToolTipService.SetShowOnDisabled(item, true);
            item.Click += (_, _) => BeginOperatorAction(action);
            menu.Items.Add(item);
        }
        menu.IsOpen = true;
    }

    private void BeginOperatorAction(string action)
    {
        if (action == "capture-menu") { CaptureClicked(this, new RoutedEventArgs()); return; }
        if (_service is null || !CanLeaveDraft()) return;
        var research = action == "research-review" ? _detail?.Record : null;
        if (action == "research-review" && (research?.Kind != "research" || research.Lifecycle is "historical" or "superseded" || research.Scope != _context?.CanonicalScope))
        { SetStatus("Review source was not started. Select a current research record in its verified project, then retry Review source."); return; }
        if (action != "project" && (_project is null || _context?.Matched != true))
        { SetStatus("Select a project with a verified root before adding its records."); return; }
        ClearDetailForNavigation();
        _operatorReviewGeneration++;
        _operatorAction = action;
        if (!action.StartsWith("capture-", StringComparison.Ordinal)) { _captureSavedId = null; _captureUnsettled = false; }
        _editing = true; _draftDirty = false; _review = null;
        _operatorFields.Clear(); CommandFields.Children.Clear();
        SetDetailActions(false);
        DetailTitle.Text = action switch {
            "project" => "New project", "note" => "Add note", "research" => "Save research",
            "rejection" => "Rejected approach", "decision" => "Record decision", "research-review" => "Review source", "retire-record" => "Retire ordinary record", _ => "Retire pending item" };
        DetailMeta.Text = action == "project" ? "Choose an existing project folder. Review before creating its catalog record." :
            "Project: " + _project!.Name + "\n" + _context!.CanonicalScope;
        CommandPanel.Visibility = Visibility.Visible; DetailText.Visibility = Visibility.Collapsed;
        CancelEditButton.Visibility = ReviewButton.Visibility = Visibility.Visible;
        AddOperatorField("author", "Recorded by", "Your name or operator identity", false);
        _operatorFields["author"].Text = _lastOperatorAuthor;
        if (action is "project" or "note" or "research" or "rejection")
            AddOperatorField("name", action == "project" ? "Project name" : "Title", "", false);
        switch (action)
        {
            case "research-review":
                var source = JsonData.Property(research!.Json, "data");
                var reference = source is { } data ? JsonData.String(data, "source_reference") : null;
                var hash = source is { } body ? JsonData.String(body, "body_sha256") : null;
                CommandFields.Children.Add(new TextBlock { Text = "Saved source reference\n" + (reference ?? "Not recorded") +
                    "\n\nSaved content hash (SHA-256)\n" + (hash ?? "Not recorded") +
                    "\n\nThis is your operator attestation of a source you inspected. No external source is fetched. Saved content and its hash are preserved.", TextWrapping = TextWrapping.Wrap });
                AddOperatorField("id", "Research record", "Exact selected research ID", false);
                _operatorFields["id"].Text = research.Id; _operatorFields["id"].IsReadOnly = true;
                AddOperatorField("source_reference", "Saved source reference", "Refreshed during Review change; a changed source requires a new review", false);
                _operatorFields["source_reference"].Text = reference ?? ""; _operatorFields["source_reference"].IsReadOnly = true;
                AddOperatorField("body_sha256", "Saved content hash", "Empty means no stored hash; this action does not compute a new source hash", false);
                _operatorFields["body_sha256"].Text = hash ?? ""; _operatorFields["body_sha256"].IsReadOnly = true;
                AddOperatorField("reviewed_at", "Source observation date", "Actual calendar date, YYYY-MM-DD", false);
                AddOperatorField("source_version", "Applicable source version (optional)", "Version you inspected; leave empty if unknown", false);
                AddOperatorField("review_qualifiers", "Review qualifiers", "What you inspected, relevant scope, limits and remaining uncertainty", true);
                break;
            case "project":
                AddOperatorField("root", "Project folder", "Absolute path to the existing folder", false);
                var browse = new Button { Content = "Choose folder…", HorizontalAlignment = HorizontalAlignment.Left };
                AutomationProperties.SetAutomationId(browse, "ChooseProjectFolder");
                browse.Click += (_, _) => {
                    var picker = new Microsoft.Win32.OpenFolderDialog { Title = "Choose the Lodestar project folder" };
                    if (picker.ShowDialog(this) == true) _operatorFields["root"].Text = picker.FolderName;
                };
                CommandFields.Children.Add(browse); break;
            case "note": AddOperatorField("body", "Note", "", true); break;
            case "research":
                AddOperatorField("source", "Source reference", "File, URL or citation you actually used", false);
                AddOperatorField("body", "Source content / excerpt", "Content you inspected; this form does not fetch the source", true);
                AddOperatorField("claim", "Finding", "What this source supports", true);
                AddOperatorField("limitations", "Limits or caveats", "State any uncertainty or limits", true); break;
            case "rejection":
                AddOperatorField("subject", "Approach", "The approach being rejected", false);
                AddOperatorField("reason", "Reason", "Why it was rejected and when to reconsider", true); break;
            case "decision":
                AddOperatorField("key", "Decision key", "Stable key, for example build:runtime", false);
                AddOperatorField("value", "Decision", "The chosen outcome", true);
                AddOperatorField("reason", "Reason", "Evidence or tradeoff behind this choice", true);
                AddOperatorField("reference", "Direction reference", "The actual message, meeting or instruction reference", false);
                AddOperatorField("instruction", "Your direction", "The instruction you are explicitly recording", true); break;
            case "retire-pending":
                AddOperatorField("id", "Pending record ID", "Exact pending ID from this project", false);
                AddOperatorField("reason", "Retirement reason", "Why this item no longer needs action; history is retained", true); break;
            case "retire-record":
                AddOperatorField("id", "Record ID", "Exact current ordinary record ID from this project", false);
                AddOperatorField("reason", "Retirement reason", "Why it is no longer current; original content and history remain", true); break;
        }
        _operatorHint = new TextBlock { Text = "Complete the fields, then Review change. No record is written until Save.",
            TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 10, 0, 6) };
        CommandFields.Children.Add(_operatorHint);
        _operatorRequestPreview = new Expander { Header = "Exact reviewed request", Visibility = Visibility.Collapsed };
        CommandFields.Children.Add(_operatorRequestPreview);
        ShowDetailPane();
        _operatorFields["author"].Focus();
        UpdateContinueState();
    }

    private void AddOperatorField(string key, string label, string hint, bool multiline)
    {
        var input = new TextBox { AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
            MinHeight = multiline ? 62 : 26, MaxHeight = multiline ? 150 : 32,
            VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
            Margin = new Thickness(0, 3, 0, 3), ToolTip = hint };
        AutomationProperties.SetName(input, label);
        AutomationProperties.SetAutomationId(input, "Operator_" + key);
        var caption = new Label { Content = label, Target = input, Padding = new Thickness(0), Margin = new Thickness(0, 7, 0, 0) };
        CommandFields.Children.Add(caption); CommandFields.Children.Add(input);
        if (hint.Length > 0) CommandFields.Children.Add(new TextBlock { Text = hint, TextWrapping = TextWrapping.Wrap,
            FontSize = 11, Foreground = (System.Windows.Media.Brush)FindResource("Muted") });
        input.TextChanged += (_, _) => {
            if (!_editing || _saving || _preparingAction) return;
            _operatorReviewGeneration++;
            _draftDirty = true; _review = null; SaveButton.Visibility = Visibility.Collapsed;
            if (_operatorRequestPreview is not null) _operatorRequestPreview.Visibility = Visibility.Collapsed;
            if (_operatorHint is not null) _operatorHint.Text = "Draft changed. Review again before saving.";
        };
        _operatorFields.Add(key, input);
    }

    private async Task ReviewOperatorActionAsync()
    {
        if (_service is null || _operatorAction is null || _saving || _preparingAction) return;
        var service = _service;
        var action = _operatorAction;
        var selectedProject = _project;
        var project = action == "project" ? null : selectedProject;
        var workspace = _workspace;
        var selectedTab = MainTabs.SelectedIndex;
        var generation = ++_operatorReviewGeneration;
        _review = null; SaveButton.Visibility = Visibility.Collapsed;
        if (_operatorRequestPreview is not null) _operatorRequestPreview.Visibility = Visibility.Collapsed;
        if (_operatorHint is not null) _operatorHint.Text = "Preparing the exact request from fresh reads…";
        _preparingAction = true; SetEditorBusy(true);
        try
        {
            var values = _operatorFields.ToDictionary(pair => pair.Key, pair => pair.Value.Text, StringComparer.Ordinal);
            var prepared = action.StartsWith("capture-", StringComparison.Ordinal) && project is not null
                ? _captureUnsettled ? new EditReview(null, "", "The prior capture outcome remains unknown. Inspect Recovery and settle the exact request before preparing an association.")
                    : await service.PrepareCaptureAsync(project, CaptureDraft(values, action), _lifetime.Token)
                : await service.PrepareOperatorActionAsync(action, values, project, _lifetime.Token);
            if (!ReviewContextCurrent()) return;
            _review = prepared;
            if (_operatorHint is not null) _operatorHint.Text = _review.Error ??
                (_review.Summary + (_review.Request is null ? "" : "\n\nSave submits this exact reviewed request. Your attribution is recorded as supplied."));
            SaveButton.Visibility = _review.Request is null ? Visibility.Collapsed : Visibility.Visible;
            if (_operatorRequestPreview is not null)
            {
                _operatorRequestPreview.Visibility = _review.Request is null ? Visibility.Collapsed : Visibility.Visible;
                if (_review.Request is { } request)
                {
                    using var document = JsonDocument.Parse(request.ExactRequestUtf8);
                    _operatorRequestPreview.Content = new TextBox { IsReadOnly = true,
                        Text = JsonSerializer.Serialize(document.RootElement, new JsonSerializerOptions { WriteIndented = true }),
                        TextWrapping = TextWrapping.Wrap, MaxHeight = 200, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
                }
            }
            SetStatus(_review.Request is null ? _review.Error is null ? _review.Summary : "Review needs correction" : "Ready to save · reviewed request frozen");
            CommandPanel.ScrollToBottom();
        }
        catch (Exception error)
        {
            if (!ReviewContextCurrent()) return;
            _review = null; SaveButton.Visibility = Visibility.Collapsed;
            if (_operatorHint is not null) _operatorHint.Text = "Review failed · " + error.Message;
            App.LogFailure(DiagnosticOperation.Save, error);
        }
        finally
        {
            if (_operatorReviewGeneration == generation && _preparingAction)
            { _preparingAction = false; if (!_disposed) SetEditorBusy(false); }
        }

        bool ReviewContextCurrent() => !_disposed && !_lifetime.IsCancellationRequested &&
            _operatorReviewGeneration == generation && _preparingAction && _editing && !_saving &&
            ReferenceEquals(_service, service) && _operatorAction == action &&
            ReferenceEquals(_project, selectedProject) && _workspace == workspace &&
            MainTabs.SelectedIndex == selectedTab;
    }

    private async Task<bool> SaveOperatorActionAsync()
    {
        if (_service is null || _saving || _preparingAction) return false;
        if (_review?.Request is not { } frozen) { await ReviewOperatorActionAsync(); return false; }
        var priorRevision = _library?.Revision;
        _saving = true; SetEditorBusy(true);
        try
        {
            var saved = await _service.SaveAsync(frozen, _lifetime.Token);
            if (_disposed || _closingAfterSave) return false;
            if (!saved.Saved)
            {
                if (_operatorAction?.StartsWith("capture-", StringComparison.Ordinal) == true && (saved.MayHaveCommitted || saved.RequiresRecovery)) _captureUnsettled = true;
                var state = saved.MayHaveCommitted ? "Save outcome unknown. Inspect Pending saves before another action. " :
                    saved.RequiresRecovery ? "Save was not sent. Inspect the incomplete journal in Pending saves. " : "Save failed. ";
                if (_operatorHint is not null) _operatorHint.Text = state + saved.Error;
                SetStatus(state + saved.Error); return false;
            }
            if (_operatorAction == "capture-create")
            {
                _captureSavedId = _operatorFields["record_id"].Text;
                _operatorAction = "capture-associate"; _review = null; _draftDirty = true;
                SaveButton.Visibility = Visibility.Collapsed; _operatorReviewGeneration++;
                if (_operatorRequestPreview is not null) _operatorRequestPreview.Visibility = Visibility.Collapsed;
                DetailTitle.Text = "Link saved record";
                DetailMeta.Text = "Record saved; association not yet saved\n" + _captureSavedId + "\nProject: " + _project?.Name;
                var intent = ProjectIntents().FirstOrDefault(record => record.Id == _operatorFields["intent_record_id"].Text);
                if (intent is not null) ShowCaptureBrief(intent);
                if (_operatorHint is not null) _operatorHint.Text = "Record saved; association not yet saved. Review again to prepare the association from fresh reads. Cancelling retains " + _captureSavedId + "; resume with Link existing record.";
                var confirmed = await _service.GetRecordAsync(_captureSavedId, _lifetime.Token);
                SetStatus(confirmed.Record?.Id == _captureSavedId ? "Record saved; association not yet saved · " + _captureSavedId : "Record saved; current read failed · " + _captureSavedId + ". Use Recovery / Link existing record. " + confirmed.Error);
                return true;
            }
            var projectCreated = _operatorAction == "project";
            _captureSavedId = null; _captureUnsettled = false;
            _lastOperatorAuthor = _operatorFields["author"].Text;
            _operatorAction = null; _editing = false; _draftDirty = false; _review = null;
            _selectedRecord = null; _detail = null; _operatorFields.Clear();
            SetDetailActions(false); _saving = false;
            var refresh = await RefreshAsync(afterSave: true);
            if (_disposed) return true;
            if (refresh.Complete && refresh.Revision == priorRevision)
                refresh = refresh with { Complete = false,
                    Error = "Library revision did not advance after the confirmed save." };
            if (!refresh.Complete)
            {
                ClearDetailForNavigation(); ConfigureWorkspace();
                SetStatus(SavedRefreshStatus.Describe(frozen, refresh) +
                    (saved.RequiresRecovery && saved.Error is { } recoveryWarning ? " " + recoveryWarning : ""));
                return true;
            }
            if (projectCreated && _library?.Projects.FirstOrDefault(p => p.Id == frozen.RecordId) is { } created)
                await SelectProjectAsync(created);
            else if (_library?.Records.FirstOrDefault(r => r.Id == frozen.RecordId) is { } record)
                await SelectRecordAsync(record);
            else { ClearDetailForNavigation(); ConfigureWorkspace(); }
            SetStatus(SavedRefreshStatus.Describe(frozen, refresh) +
                (saved.RequiresRecovery && saved.Error is { } warning ? " " + warning : ""));
            return true;
        }
        catch (Exception error)
        {
            App.LogFailure(DiagnosticOperation.Save, error);
            if (_operatorHint is not null) _operatorHint.Text = "Save did not complete. Inspect Pending saves. " + error.Message;
            return false;
        }
        finally { _saving = false; if (!_disposed) SetEditorBusy(false); }
    }

    // A bounded, read-only render batch for the operator additions. No Save is submitted.
    public async Task CaptureOperatorSmokeAsync(string directory)
    {
        if (_library is not { Complete: true } || _library.Projects.IsDefaultOrEmpty)
            throw new InvalidDataException("Operator render needs a complete disposable project fixture.");
        Directory.CreateDirectory(directory);
        var captures = new List<object>();
        async Task Capture(string name, double width, double height)
        {
            Width = width; Height = height;
            await Dispatcher.InvokeAsync(() => { }, System.Windows.Threading.DispatcherPriority.ApplicationIdle);
            ClientRoot.UpdateLayout();
            var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(ClientRoot);
            var bitmap = new System.Windows.Media.Imaging.RenderTargetBitmap(
                (int)Math.Ceiling(ClientRoot.ActualWidth * dpi.DpiScaleX),
                (int)Math.Ceiling(ClientRoot.ActualHeight * dpi.DpiScaleY),
                dpi.PixelsPerInchX, dpi.PixelsPerInchY, System.Windows.Media.PixelFormats.Pbgra32);
            bitmap.Render(ClientRoot);
            var encoder = new System.Windows.Media.Imaging.PngBitmapEncoder();
            encoder.Frames.Add(System.Windows.Media.Imaging.BitmapFrame.Create(bitmap));
            var path = Path.Combine(directory, name + ".png");
            await using (var stream = File.Create(path)) encoder.Save(stream);
            captures.Add(new { name, width, height, path, workspace = _workspace,
                requestPrepared = _review?.Request is not null, status = StatusText.Text });
        }
        _workspace = "health"; ConfigureWorkspace();
        await Capture("health", 1440, 900);
        SearchAllClicked(this, new RoutedEventArgs());
        AllRecordSearch.Text = "fixture";
        await Capture("all-records", 1440, 900);
        await Capture("all-records-compact", 900, 600);
        await SelectProjectAsync(_library.Projects[0]);
        BeginOperatorAction("project");
        await Capture("new-project-compact", 900, 600);
        DiscardDraft();
        if (_project is { } selectedProject && AssociatedRecords(selectedProject).FirstOrDefault(record =>
            record.Kind == "knowledge" && JsonData.Property(record.Json, "data") is { ValueKind: JsonValueKind.Object } data &&
            JsonData.TryObject(data, "intent", out _)) is { } intentRecord)
        {
            await SelectRecordAsync(intentRecord);
            await CheckIntentUiAsync();
            if (!DetailText.Text.StartsWith("RECORDED PLAN / SUPPLIED EVIDENCE", StringComparison.Ordinal))
                throw new InvalidDataException("Plan readout did not render: " + DetailText.Text);
            await Capture("plan-readout", 1440, 900);
        }
        else
        {
            BeginOperatorAction("note");
            _operatorFields["author"].Text = "Disposable render fixture";
            _operatorFields["name"].Text = "Operator review example";
            _operatorFields["body"].Text = "This draft demonstrates the review controls.\nNo record is submitted by this render batch.";
            await ReviewOperatorActionAsync();
            if (_review?.Request is null) throw new InvalidDataException("Operator review failed: " + _operatorHint?.Text);
            await Capture("note-review", 1440, 900);
            DiscardDraft();
        }
        await File.WriteAllTextAsync(Path.Combine(directory, "operator-render.json"), JsonSerializer.Serialize(new {
            captured_at = DateTimeOffset.UtcNow, mutations_submitted = 0,
            assembly_sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
                await File.ReadAllBytesAsync(typeof(MainWindow).Assembly.Location))).ToLowerInvariant(),
            runtime_fingerprint = _service?.Runtime.Fingerprint, captures
        }, new JsonSerializerOptions { WriteIndented = true }));
    }
}
