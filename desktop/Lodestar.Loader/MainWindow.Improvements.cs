using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace Lodestar.Loader;

public partial class MainWindow
{
    private static string LoaderIdentity()
    {
        var assembly = typeof(MainWindow).Assembly;
        var version = assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion ?? "unavailable";
        try {
            var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(assembly.Location))).ToLowerInvariant();
            return "Observed Loader assembly\n" + assembly.Location + "\nInformational version  " + version + "\nSHA-256  " + digest +
                "\nAssembly bytes observed; manifest-listed Loader entry not checked. Installer, signature and publication provenance unavailable / not checked.";
        } catch (Exception error) { return "Observed Loader assembly\nInformational version  " + version + "\nSHA-256 unavailable: " + error.Message + "\nManifest/installer/signature/provenance not checked."; }
    }
    private string _captureRecordType = "knowledge", _capturePurpose = "requirements", _captureStatus = "unverified";
    private bool _captureAcceptance = true, _captureUnsettled;
    private string? _captureSavedId;
    private int _attentionGeneration;
    private string? _attentionProjectId;
    private sealed record IntentChoice(string? Id, string Label) { public override string ToString() => Label; }

    private IEnumerable<LibraryRecord> ProjectIntents() => _project is null ? [] : AssociatedRecords(_project).Where(record =>
        record.Kind == "knowledge" && record.Lifecycle is not ("historical" or "superseded") &&
        JsonData.Property(record.Json, "data") is { } data && JsonData.TryObject(data, "intent", out _));

    private void CaptureClicked(object sender, RoutedEventArgs e)
    {
        var menu = new ContextMenu();
        foreach (var (kind, label, existing) in new[] { ("knowledge", "Create knowledge", false), ("research", "Create research", false),
            ("result", "Create observed result", false), ("knowledge", "Link existing record", true) }) {
            var item = new MenuItem { Header = label, IsEnabled = _project is not null && _context?.Matched == true && _service?.SupportsOperatorRead("work.prepare-capture") == true,
                ToolTip = "Select a verified project and a core supporting work.prepare-capture." };
            ToolTipService.SetShowOnDisabled(item, true); item.Click += (_, _) => BeginCapture(kind, existing); menu.Items.Add(item);
        }
        menu.IsOpen = true;
    }

    private void BeginCapture(string type, bool existing)
    {
        if (_service?.SupportsOperatorRead("work.prepare-capture") != true || _project is null || _context?.Matched != true)
        { SetStatus("Selected core does not support this action, or the project root needs verification."); return; }
        var selectedId = _selectedRecord?.Id; var selectedIntent = ProjectIntents().FirstOrDefault(record => record.Id == selectedId) ?? ProjectIntents().FirstOrDefault();
        BeginOperatorAction(existing ? "capture-associate" : "capture-create");
        if (_operatorAction != (existing ? "capture-associate" : "capture-create")) return;
        _captureRecordType = type; _capturePurpose = "requirements"; _captureStatus = "unverified"; _captureAcceptance = true;
        _captureUnsettled = false; _captureSavedId = null;
        DetailTitle.Text = existing ? "Link existing record" : "Capture " + type;
        DetailMeta.Text = "Project: " + _project.Name + "\nCreate and association each require their own review and save. Recorded acceptance defaults to unverified.";
        AddOperatorField("intent_record_id", "Intent record", "Exact current intent in this project", false);
        _operatorFields["intent_record_id"].Text = selectedIntent?.Id ?? "";
        if (selectedIntent is not null) ShowCaptureBrief(selectedIntent);
        _operatorFields["intent_record_id"].TextChanged += (_, _) => {
            var selected = ProjectIntents().FirstOrDefault(record => record.Id == _operatorFields.GetValueOrDefault("intent_record_id")?.Text);
            if (selected is not null) ShowCaptureBrief(selected);
            else DetailMeta.Text = "Project: " + _project?.Name + "\nIntent selection needs a fresh review. No loaded brief matches this exact ID.";
        };
        AddChoice("Choose intent", ProjectIntents().Select(record => record.Id), value => _operatorFields["intent_record_id"].Text = value, selectedIntent?.Id);
        AddOperatorField("record_id", existing ? "Existing record ID" : "Allocated record ID", "Retain this exact ID through retries", false);
        _operatorFields["record_id"].Text = existing ? selectedId ?? "" : (type == "research" ? "research:" : "knowledge:") + Guid.NewGuid().ToString("D");
        _operatorFields["record_id"].IsReadOnly = !existing;
        if (existing) AddChoice("Choose existing record", AssociatedRecords(_project).Where(record => record.Kind is "knowledge" or "research" or "rejection" &&
            record.Id != selectedIntent?.Id && record.Lifecycle is not ("historical" or "superseded")).Select(record => record.Id),
            value => _operatorFields["record_id"].Text = value, selectedId);
        AddChoice("Context purpose", ["requirements", "mission", "none"], value => { _capturePurpose = value; InvalidateCaptureReview(); }, "requirements");
        AddOperatorField("requirement_ids", "Requirement IDs", "Comma-separated exact IDs; used for requirement context", false);
        if (selectedIntent is not null && JsonData.Property(selectedIntent.Json, "data") is { } intentData && JsonData.TryObject(intentData, "intent", out var intent) &&
            JsonData.TryArray(intent, "requirements", out var requirements))
            AddChoice("Choose requirement", requirements.EnumerateArray().Select(row => JsonData.String(row, "id") ?? ""), value => _operatorFields["requirement_ids"].Text = value);
        var acceptance = new CheckBox { Content = "Record an acceptance result (evidence still requires inspection)", IsChecked = true, Margin = new Thickness(0, 8, 0, 3) };
        acceptance.Checked += (_, _) => { _captureAcceptance = true; InvalidateCaptureReview(); };
        acceptance.Unchecked += (_, _) => { _captureAcceptance = false; InvalidateCaptureReview(); };
        CommandFields.Children.Add(acceptance);
        AddOperatorField("acceptance_requirement_id", "Acceptance requirement (optional override)", "Uses the first selected requirement when empty; status is your explicit choice", false);
        AddChoice("Recorded result", ["unverified", "passed", "failed"], value => { _captureStatus = value; InvalidateCaptureReview(); }, "unverified");
        AddOperatorField("acceptance_notes", "Acceptance notes", "What the evidence supports and remaining inspection", true);
        _operatorFields["acceptance_notes"].Text = "Evidence captured; acceptance remains unverified pending inspection.";
        if (!existing) {
            AddOperatorField("name", "Title", "", false); AddOperatorField("body", "Recorded content", "", true);
            if (type == "research") { AddOperatorField("source", "Source reference", "Source actually inspected", false); AddOperatorField("claim", "Finding", "", true); AddOperatorField("limitations", "Limitations", "", true); }
            if (type == "result") { AddOperatorField("observed_outcome", "Observed outcome", "Observation does not set acceptance status", false); AddOperatorField("evidence_reference", "Evidence reference", "", false); AddOperatorField("limitations", "Limitations", "", true); }
        }
        AddOperatorField("active_requirement_ids", "First context link: active requirements", "Supply explicit IDs only if the intent has no recorded continuation. Leave empty to preserve its existing branch.", false);
        AddOperatorField("next_action", "First context link: next action", "Supply the intended next action only if the intent has no recorded continuation.", false);
        // Keep review guidance and exact request after all input controls.
        CommandFields.Children.Remove(_operatorHint!); CommandFields.Children.Remove(_operatorRequestPreview!);
        CommandFields.Children.Add(_operatorHint!); CommandFields.Children.Add(_operatorRequestPreview!);
        _operatorHint!.Text = "Choose intent, context and evidence purpose. For context only, clear Record an acceptance result. Review each stage before Save.";
    }

    private void AddChoice(string label, IEnumerable<string> values, Action<string> select, string? initial = null)
    {
        var choice = new ComboBox { ItemsSource = values.ToArray(), Margin = new Thickness(0, 3, 0, 3), MinHeight = 26 };
        AutomationProperties.SetName(choice, label); CommandFields.Children.Add(new TextBlock { Text = label }); CommandFields.Children.Add(choice);
        choice.SelectionChanged += (_, _) => { if (choice.SelectedItem is string value) select(value); };
        if (initial is not null) choice.SelectedItem = initial;
    }

    private void InvalidateCaptureReview()
    {
        if (!_editing || _saving || _preparingAction) return;
        _operatorReviewGeneration++; _draftDirty = true; _review = null; SaveButton.Visibility = Visibility.Collapsed;
        if (_operatorRequestPreview is not null) _operatorRequestPreview.Visibility = Visibility.Collapsed;
    }

    private JsonElement CaptureDraft(Dictionary<string, string> values, string action)
    {
        static JsonArray Ids(string value) => new(value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());
        var selectedIds = Ids(values["requirement_ids"]);
        if (_capturePurpose == "requirements" && selectedIds.Count == 0)
            throw new InvalidDataException("Choose at least one requirement for requirement context before creating or linking a record.");
        if (_capturePurpose == "none" && !_captureAcceptance)
            throw new InvalidDataException("Choose a context purpose or record an explicit acceptance result.");
        if (_captureAcceptance && string.IsNullOrWhiteSpace(values["acceptance_requirement_id"]) && selectedIds.Count == 0)
            throw new InvalidDataException("Choose an acceptance requirement, or clear Record an acceptance result for context only.");
        var draft = new JsonObject { ["version"] = 1, ["stage"] = action == "capture-create" ? "create" : "associate",
            ["intent_record_id"] = values["intent_record_id"], ["author"] = values["author"] };
        if (action == "capture-create") {
            var record = new JsonObject { ["id"] = values["record_id"], ["type"] = _captureRecordType, ["name"] = values["name"], ["body"] = values["body"] };
            foreach (var key in _captureRecordType == "research" ? new[] { "source", "claim", "limitations" } : _captureRecordType == "result" ? ["observed_outcome", "evidence_reference", "limitations"] : Array.Empty<string>()) record[key] = values[key];
            draft["record"] = record;
        } else {
            var ids = selectedIds; draft["record_id"] = values["record_id"];
            draft["context_target"] = _capturePurpose == "none" ? null : _capturePurpose == "mission" ? new JsonObject { ["kind"] = "mission" } : new JsonObject { ["kind"] = "requirements", ["requirement_ids"] = ids };
            if (_captureAcceptance) draft["acceptance_result"] = new JsonObject {
                ["requirement_id"] = string.IsNullOrWhiteSpace(values["acceptance_requirement_id"]) ? ids.FirstOrDefault()?.GetValue<string>() : values["acceptance_requirement_id"],
                ["status"] = _captureStatus, ["notes"] = values["acceptance_notes"] };
            if (!string.IsNullOrWhiteSpace(values["active_requirement_ids"]) || !string.IsNullOrWhiteSpace(values["next_action"]))
                draft["initialize_continuation"] = new JsonObject { ["active_requirement_ids"] = Ids(values["active_requirement_ids"]), ["next_action"] = values["next_action"] };
        }
        return JsonSerializer.SerializeToElement(draft);
    }

    private async void RefreshAttentionClicked(object sender, RoutedEventArgs e) => await RefreshAttentionUiAsync();
    private async Task RefreshAttentionUiAsync()
    {
        if (_service is not { } service || _project is not { } project || _context?.Matched != true || _saving) return;
        var runtime = service.Runtime; var generation = ++_attentionGeneration; var root = _context.Root;
        var intent = (AttentionIntentChoices.SelectedItem as IntentChoice)?.Id;
        RefreshAttentionButton.IsEnabled = false;
        try {
            var result = await service.ReadAttentionAsync(project, intent, _lifetime.Token);
            if (!Current()) return;
            var now = DateTimeOffset.Now; AttentionReadChoices.ItemsSource = null;
            AttentionText.Text = "Project attention · " + project.Name + "\nRead " + now.ToString("g") + "\n";
            if (!result.Success || result.Envelope is not { } envelope || !JsonData.TryObject(envelope, "data", out var data))
                AttentionText.Text += "Refresh failed; attention is stale / unavailable. " + result.Message;
            else {
                AttentionText.Text += "Database instance " + JsonData.String(envelope, "database_instance_id") + "\nEpoch " + JsonData.String(envelope, "database_epoch") +
                    " · revision " + JsonData.Property(envelope, "revision") + "\nSelected intent " + (JsonData.String(data, "selected_intent_id") ?? "not selected") + "\n";
                var choices = new List<IntentChoice> { new(null, "Choose intent / no selection") };
                foreach (var row in data.GetProperty("intents").EnumerateArray()) if (JsonData.String(row, "id") is { } id) choices.Add(new(id, (JsonData.String(row, "name") ?? id) + " · " + id));
                AttentionIntentChoices.ItemsSource = choices; AttentionIntentChoices.SelectedItem = choices.FirstOrDefault(choice => choice.Id == JsonData.String(data, "selected_intent_id")) ?? choices[0];
                var reads = new List<ContinuityReadAction>();
                var admittedScopes = _context!.HistoricalScopes.Prepend(_context.CanonicalScope!).Distinct(StringComparer.Ordinal);
                foreach (var section in data.GetProperty("sections").EnumerateObject()) {
                    var value = section.Value; var state = JsonData.String(value, "state"); JsonData.TryBool(value, "complete", out var complete);
                    AttentionText.Text += "\n" + section.Name.ToUpperInvariant() + " · " + state + " · " + (complete ? "complete returned section" : "coverage incomplete") + "\n";
                    if (JsonData.Property(value, "omitted_count") is { } omitted) AttentionText.Text += "Omitted items: " + omitted + "\n";
                    if (JsonData.TryArray(value, "items", out var items)) AttentionText.Text += items.GetArrayLength() == 0 ? complete ? "No recorded items.\n" : "No loaded items; coverage incomplete.\n" : JsonData.Pretty(items) + "\n";
                    if (JsonData.TryArray(value, "issues", out var issues) && issues.GetArrayLength() > 0) AttentionText.Text += "Issues\n" + JsonData.Pretty(issues) + "\n";
                    CollectReads(value, section.Name, reads, root, admittedScopes);
                }
                if (JsonData.TryObject(data, "intent_inventory", out var inventory)) {
                    AttentionText.Text += "\nINTENT INVENTORY COVERAGE\n" + JsonData.Pretty(inventory) + "\n";
                    CollectReads(inventory, "Intent inventory", reads, root, admittedScopes);
                }
                CollectReads(data, "Required read", reads, root, admittedScopes); AttentionReadChoices.ItemsSource = reads.DistinctBy(read => string.Join('\0', read.Arguments)).ToArray();
                if (AttentionReadChoices.Items.Count > 0) AttentionReadChoices.SelectedIndex = 0;
                _attentionProjectId = project.Id;
            }
            var recovery = service.ReadPendingSaves();
            AttentionRecoveryText.Text = "Recovery · separate journal observation\nRead " + DateTimeOffset.Now.ToString("g") + " · runtime generation " + runtime.Generation +
                "\nDatabase path " + runtime.DatabasePath + "\nCoverage: " + (recovery.Error ?? "returned local/shared journal entries; no database transaction coherence") + "\n" +
                string.Join("\n", recovery.Items.Select(item => (item.ProjectRoot is null ? "scope unknown · " :
                    project.Roots.Contains(item.ProjectRoot, StringComparer.OrdinalIgnoreCase) ? "selected project · " : "other original project · ") + item.RequestId + " · " + item.RecordId + " · " + (item.Issue ?? "unresolved") +
                    "\n  Original database: " + item.DatabasePath + " · root: " + (item.ProjectRoot ?? "unknown"))) +
                "\nUse Recovery to inspect or replay a request at its original saved binding.";
            SetStatus("Project attention refreshed · recovery observed separately");
        } catch (Exception error) { if (Current()) AttentionText.Text = "Project attention refresh failed; prior observation is stale. " + error.Message; }
        finally { if (Current()) RefreshAttentionButton.IsEnabled = true; }
        bool Current() => !_disposed && !_lifetime.IsCancellationRequested && generation == _attentionGeneration && ReferenceEquals(_service, service) &&
            ReferenceEquals(_project, project) && _service.Runtime == runtime && _context?.Root == root;
    }

    private static void CollectReads(JsonElement source, string label, List<ContinuityReadAction> reads, string? root, IEnumerable<string> scopes)
    {
        foreach (var field in new[] { "read_args", "read_required" }) if (JsonData.TryArray(source, field, out var array)) {
            void Add(JsonElement row) {
                var args = row.ValueKind == JsonValueKind.Array ? row : JsonData.Property(row, "read_args");
                if (args is not { ValueKind: JsonValueKind.Array } values || values.EnumerateArray().Any(token => token.ValueKind != JsonValueKind.String)) return;
                var tokens = values.EnumerateArray().Select(token => token.GetString()!).ToImmutableArray();
                if (LodestarService.AttentionReadOperation(tokens, root, scopes) is not null) reads.Add(new(label + ": " + string.Join(' ', tokens), tokens));
            }
            if (array.GetArrayLength() > 0 && array[0].ValueKind == JsonValueKind.String) Add(array); else foreach (var row in array.EnumerateArray()) Add(row);
        }
    }

    private async void AttentionReadClicked(object sender, RoutedEventArgs e)
    {
        if (_service is not { } service || _project is not { } project || _attentionProjectId != project.Id ||
            AttentionReadChoices.SelectedItem is not ContinuityReadAction read || !CanLeaveDraft()) return;
        var generation = ++_generation;
        var result = await service.ReadAttentionFollowUpAsync(project, read.Arguments, _lifetime.Token);
        if (_disposed || generation != _generation || !ReferenceEquals(_service, service) || !ReferenceEquals(_project, project) || _editing) return;
        DetailTitle.Text = "Attention follow-up"; DetailMeta.Text = "Snapshot remains unchanged; select Refresh attention for a new observation.";
        DetailText.Text = result.Envelope is { } envelope ? JsonData.Pretty(envelope) : result.Message; ShowDetailPane();
    }

    private void ShowCaptureBrief(LibraryRecord record)
    {
        if (JsonData.Property(record.Json, "data") is not { } data || !JsonData.TryObject(data, "intent", out var intent)) return;
        DetailMeta.Text = "Project: " + _project?.Name + "\nIntent: " + record.Id + "\nBrief: " + JsonData.String(intent, "brief");
        if (JsonData.TryObject(data, "continuation", out var continuation)) DetailMeta.Text += "\nActive branch: " +
            (JsonData.TryArray(continuation, "active_requirement_ids", out var active) ? string.Join(", ", active.EnumerateArray().Select(item => item.GetString())) : "unknown") +
            "\nNext action: " + JsonData.String(continuation, "next_action");
        if (_captureSavedId is not null) DetailMeta.Text = "Record saved; association not yet saved · " + _captureSavedId + "\n" + DetailMeta.Text;
    }
}
