using System.Reflection;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Lodestar.Loader;

// Linked production WPF handlers and XAML. Isolated groups use controlled service
// replies; continuity and OI2 groups call the actual core with disposable SQLite.
public static class WindowLifecycleChecks
{
    private static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly string Root = AppContext.BaseDirectory;
    private static readonly RuntimeSelection Runtime = new(Path.Combine(Root, "fixture-config.json"),
        "fixture", "unused", "unused", Path.Combine(Root, "unused.db"), "fixture");
    private static readonly LibraryRecord Record = RecordProjection.ReadRecord(Json(new {
        id = "fact:one", kind = "fact", scope = "scope:one", name = "Old visible record",
        availability = "known", data = new { body = "old content" } }))!;
    private static readonly ProjectSummary Project = MakeProject("project:one", "scope:one");
    private static readonly LibrarySnapshot Library = new([Project], [Record], [], [], "instance", "epoch",
        7, DateTimeOffset.UtcNow, true, 2, [], [], Issues: [], HistoricalProjects: []);
    private static int _failures;
    private static int _executed;

    [STAThread]
    public static void Main()
    {
        var app = new App { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.InitializeComponent();
        typeof(App).GetField("<Diagnostics>k__BackingField", BindingFlags.Static | BindingFlags.NonPublic)!
            .SetValue(null, new DiagnosticLog(Path.Combine(Root, "fixture-diagnostics")));
        SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext());
        Dispatcher.CurrentDispatcher.BeginInvoke(async () => {
            try
            {
                await Run("record and history do not cancel project validation", ProjectValidationSurvivesDetail);
                await Run("OI2 actual capture attention production handlers", OperatorImprovementHandlers);
                await Run("OI2 historical attention inventory production handler", HistoricalInventoryHandler);
                await Run("obsolete project and service validation cannot publish", ObsoleteProjectValidation);
                await Run("capability refresh preserves an existing dirty draft", CapabilitiesPreserveDraft);
                await Run("delayed capability refresh preserves a later draft", DelayedCapabilitiesPreserveDraft);
                await Run("obsolete capability completion cannot repaint a new runtime", ObsoleteCapabilities);
                await Run("complete refresh clears absent selection and detail", CompleteRefreshClearsAbsent);
                await Run("failed and partial refresh preserve selected detail", IncompleteRefreshPreservesDetail);
                await Run("continuation clears absent selection at complete coverage", CompleteContinuationClearsAbsent);
                await Run("surviving selected record receives fresh detail", SurvivingSelectionIsFresh);
                await Run("RL06 four question journeys and pending save route", QuestionJourneys);
                await Run("RL10 selected research source attestation form", ResearchReviewForm);
                await Run("RL10 source attestation production review and save handlers", ResearchReviewHandlers);
                await Run("continuity actual core inspector and literal read handlers", ContinuityHandlers);
                await Run("RL11 support summary whitelist and RL14 storage notice", ConnectionSupport);
                await Run("FQ02 actual failed logger notice preserves primary status", DiagnosticAvailability);
            }
            catch (Exception error) { Console.WriteLine(error); _failures++; }
            finally { if (_executed == 0) { Console.WriteLine("FAIL no checks matched LODESTAR_WINDOW_TEST_FILTER"); _failures++; }
                Environment.ExitCode = _failures == 0 ? 0 : 1; Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        Dispatcher.Run();
    }

    private static async Task Run(string name, Func<Task> test)
    {
        var filter = Environment.GetEnvironmentVariable("LODESTAR_WINDOW_TEST_FILTER");
        if (!string.IsNullOrWhiteSpace(filter) && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) return;
        _executed++;
        try { await test(); Console.WriteLine("PASS " + name); }
        catch (Exception error) { _failures++; Console.WriteLine("FAIL " + name + ": " + error); }
    }

    private static async Task OperatorImprovementHandlers()
    {
        Require(typeof(MainWindow).GetMethod("BeginCapture", Private) is not null, "OI2 RED: production capture handler is absent.");
        Require(typeof(MainWindow).GetMethod("RefreshAttentionUiAsync", Private) is not null, "OI2 RED: production attention handler is absent.");
        var (directory, service, project) = await OperatorImprovementChecks.FixtureAsync();
        await using (service) try {
            var window = Window(service); var library = await service.LoadLibraryAsync();
            Set(window, "_library", library); Set(window, "_project", project); Set(window, "_workspace", "projects");
            Set(window, "_context", await service.ValidateProjectContextAsync(project)); Call(window, "ConfigureWorkspace");
            Call(window, "BeginCapture", "result", false);
            var fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
            fields["author"].Text = "Window fixture"; fields["intent_record_id"].Text = "knowledge:operator-intent";
            fields["requirement_ids"].Text = "R1"; fields["name"].Text = "Window observed result"; fields["body"].Text = "Real handler fixture";
            fields["observed_outcome"].Text = "passed"; fields["evidence_reference"].Text = "Disposable evidence"; fields["limitations"].Text = "Focused check";
            var id = fields["record_id"].Text;
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            Require(((EditReview?)Field(window, "_review"))?.Request is not null, "Capture review failed.");
            var createSaved = await (Task<bool>)Call(window, "SaveOperatorActionAsync")!;
            Require(createSaved, "Confirmed create handler failed: " + Control<TextBlock>(window,"StatusText").Text + " · " + ((TextBlock?)Field(window,"_operatorHint"))?.Text);
            Require((string?)Field(window, "_operatorAction") == "capture-associate" && fields["record_id"].Text == id, "Confirmed creation did not retain original ID for fresh association.");
            Require(Control<TextBlock>(window, "DetailMeta").Text.Contains(id), "Retained saved record is invisible.");
            fields["requirement_ids"].Text = "Unknown requirement";
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            Require(((EditReview?)Field(window, "_review"))?.Request is null && (await service.GetRecordAsync(id)).Record is not null,
                "Rejected association erased the confirmed record or offered Save.");
            fields["requirement_ids"].Text = "R1";
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            Require(((EditReview?)Field(window, "_review"))?.Request is not null, "Fresh attach review failed.");
            var target = await service.GetRecordAsync(id); var change = service.ReviewEdit(target, RecordEditor.Begin(target) with { Name = "Evidence changed after review" });
            Require(change.Request is not null && (await service.SaveAsync(change.Request)).Saved, "Actual concurrent evidence edit failed.");
            Require(!await (Task<bool>)Call(window, "SaveOperatorActionAsync")! && fields["record_id"].Text == id && (bool)Field(window, "_draftDirty")!,
                "Association conflict lost the confirmed record or its draft.");
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            await RenderOperatorState(window, "capture-review");
            var beforeCancel = "saved=" + Field(window,"_captureSavedId") + " editing=" + Field(window,"_editing") + " saving=" + Field(window,"_saving") + " action=" + Field(window,"_operatorAction");
            Call(window, "DiscardDraft");
            var retained = await service.GetRecordAsync(id);
            Require(retained.Record is not null && Control<TextBlock>(window, "DetailTitle").Text == "Saved record retained" && Control<TextBlock>(window,"DetailMeta").Text.Contains(id) &&
                Control<TextBox>(window,"DetailText").Text.Contains("Link existing record"),
                "Cancelling association lost the retained saved ID. Before: " + beforeCancel + "; after: " + Control<TextBlock>(window,"StatusText").Text + "; record=" + retained.Record?.Id + " error=" + retained.Error);
            Call(window, "BeginCapture", "knowledge", true); fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
            fields["author"].Text = "Window fixture"; fields["intent_record_id"].Text = "knowledge:operator-intent"; fields["record_id"].Text = id; fields["requirement_ids"].Text = "R1";
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            var originalAttach = ((EditReview?)Field(window, "_review"))!.Request!;
            await (Task<bool>)Call(window, "SaveOperatorActionAsync")!;
            var intent = (await service.GetRecordAsync("knowledge:operator-intent")).Record!.Json.GetProperty("data");
            Require(intent.GetProperty("acceptance").GetProperty("results")[0].GetProperty("status").GetString() == "unverified", "Capture inferred passed acceptance.");
            var originalRequest = await File.ReadAllBytesAsync(Path.Combine(originalAttach.JournalDirectory,"request.json"));
            File.Delete(Path.Combine(originalAttach.JournalDirectory,"response.json")); // A real request whose response cache is unavailable remains exact-replay eligible.
            var unknownId = "ll-" + Guid.NewGuid().ToString("D"); Directory.CreateDirectory(Path.Combine(directory,"journal",unknownId));
            await (Task)Call(window, "RefreshAttentionUiAsync")!;
            Require(Control<TextBox>(window, "AttentionText").Text.Contains("Project attention") && Control<TextBox>(window, "AttentionRecoveryText").Text.Contains("separate") &&
                Control<TextBox>(window, "AttentionRecoveryText").Text.Contains(originalAttach.RequestId) && Control<TextBox>(window,"AttentionRecoveryText").Text.Contains("scope unknown"), "Attention/recovery readouts missing original/scope-unknown entries.");
            Control<TabControl>(window, "MainTabs").SelectedIndex = 6;
            Call(window,"ReturnFromDetail"); // The production Back action exposes the project tabs at compact width.
            await RenderOperatorState(window, "attention");
            Call(window, "BeginCapture", "knowledge", true); fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
            fields["record_id"].Text = id; fields["acceptance_notes"].Text = "Protected draft";
            await (Task)Call(window, "RefreshAttentionUiAsync")!;
            Require(fields["acceptance_notes"].Text == "Protected draft" && (bool)Field(window, "_draftDirty")!, "Attention refresh replaced dirty draft.");
            Call(window, "DiscardDraft");
            var bRoot = Path.Combine(directory, "project-b"); Directory.CreateDirectory(bRoot);
            var bReview = await service.PrepareOperatorActionAsync("project", new Dictionary<string,string> { ["author"] = "Fixture", ["name"] = "Project B", ["root"] = bRoot }, null);
            Require(bReview.Request is not null && (await service.SaveAsync(bReview.Request)).Saved, "Project B fixture failed.");
            var b = (await service.LoadLibraryAsync()).Projects.Single(item => item.Id == bReview.Request!.RecordId);
            Set(window,"_project",b); Set(window,"_context",await service.ValidateProjectContextAsync(b)); Call(window,"ConfigureWorkspace");
            await (Task)Call(window,"RefreshAttentionUiAsync")!;
            Require(Control<TextBox>(window,"AttentionRecoveryText").Text.Contains("scope unknown") && Control<TextBox>(window,"AttentionRecoveryText").Text.Contains(unknownId),"Scope-unknown journal disappeared in project B.");
            Require(Control<TextBox>(window,"AttentionRecoveryText").Text.Contains(originalAttach.RequestId) &&
                Control<TextBox>(window,"AttentionRecoveryText").Text.Contains(originalAttach.ProjectRoot!),
                "An unresolved original-project A journal disappeared from project B attention.");
            Set(window,"_project",project); Set(window,"_context",await service.ValidateProjectContextAsync(project)); Call(window,"ConfigureWorkspace");
            await (Task)Call(window,"RefreshAttentionUiAsync")!;
            var returnedRequest = await File.ReadAllBytesAsync(Path.Combine(originalAttach.JournalDirectory,"request.json"));
            Require(Control<TextBox>(window,"AttentionRecoveryText").Text.Contains(originalAttach.RequestId) &&
                originalRequest.SequenceEqual(returnedRequest),"Returning to project A lost its exact request.");
            Set(window,"_project",b); Set(window,"_context",await service.ValidateProjectContextAsync(b));
            var replayFromB = await service.RecoverAsync(originalAttach.RequestId);
            var replayedRequest = await File.ReadAllBytesAsync(Path.Combine(originalAttach.JournalDirectory,"request.json"));
            Require(replayFromB.Saved && replayFromB.Cli!.Envelope!.Value.GetProperty("request").GetProperty("replayed").GetBoolean() &&
                originalRequest.SequenceEqual(replayedRequest) && originalAttach.ProjectRoot == project.Roots[0],
                "Recovery after project navigation changed the original request bytes or project binding.");
            var started = new TaskCompletionSource(); var release = new TaskCompletionSource();
            await using var delayed = new LodestarService(service.Runtime, async (invocation, cancellation) => {
                if (invocation.OperationId == "work.attention") { started.SetResult(); await release.Task; }
                return await service.ExecuteAsync(invocation, cancellation);
            }, Path.Combine(directory, "delayed"));
            await delayed.DiscoverAsync(); var obsoleteWindow = Window(delayed);
            Set(obsoleteWindow, "_project", project); Set(obsoleteWindow, "_context", await delayed.ValidateProjectContextAsync(project));
            var attentionTask = (Task)Call(obsoleteWindow, "RefreshAttentionUiAsync")!; await started.Task;
            Set(obsoleteWindow, "_project", b); Set(obsoleteWindow, "_context", await delayed.ValidateProjectContextAsync(b));
            Control<TextBox>(obsoleteWindow, "AttentionText").Text = "Project B selected";
            release.SetResult(); await attentionTask;
            Require(Control<TextBox>(obsoleteWindow, "AttentionText").Text == "Project B selected", "Delayed project A attention repainted project B.");
        } finally { Directory.Delete(directory, true); }
    }

    private static async Task RenderOperatorState(MainWindow window, string state)
    {
        var directory = Environment.GetEnvironmentVariable("LODESTAR_OPERATOR_RENDER_DIR");
        if (string.IsNullOrWhiteSpace(directory)) return;
        Directory.CreateDirectory(directory);
        foreach (var (width, height) in new[] { (1440, 860), (900, 600) }) {
            window.Width = width; window.Height = height; window.Measure(new Size(width,height)); window.Arrange(new Rect(0,0,width,height)); window.UpdateLayout();
            await window.Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
            var root = Control<Grid>(window,"ClientRoot"); root.Measure(new Size(width,height)); root.Arrange(new Rect(0,0,width,height)); root.UpdateLayout();
            var bitmap = new RenderTargetBitmap(width,height,96,96,PixelFormats.Pbgra32); bitmap.Render(root);
            var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var output = File.Create(Path.Combine(directory,$"{state}-{width}x{height}.png")); encoder.Save(output);
        }
        await File.WriteAllTextAsync(Path.Combine(directory,"loader-assembly-sha256.txt"), Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(await File.ReadAllBytesAsync(typeof(MainWindow).Assembly.Location))).ToLowerInvariant());
    }

    private static async Task HistoricalInventoryHandler()
    {
        var (directory,service,project)=await AttentionHistoricalInventoryChecks.SetupAsync();
        await using(service) try {
            var before=await File.ReadAllBytesAsync(service.Runtime.DatabasePath);
            var window=Window(service);Set(window,"_library",await service.LoadLibraryAsync());Set(window,"_project",project);
            Set(window,"_context",await service.ValidateProjectContextAsync(project));Set(window,"_workspace","projects");Call(window,"ConfigureWorkspace");
            await (Task)Call(window,"RefreshAttentionUiAsync")!;
            var reads=Control<ComboBox>(window,"AttentionReadChoices").Items.Cast<ContinuityReadAction>()
                .Where(read=>read.Arguments[0]=="find").ToArray();
            Require(reads.Length==2&&reads.Any(read=>read.Arguments[3]==AttentionHistoricalInventoryChecks.HistoricalScope),
                "The production Attention handler hid an admitted historical full inventory read.");
            var historical=reads.Single(read=>read.Arguments[3]==AttentionHistoricalInventoryChecks.HistoricalScope);
            var result=await service.ReadAttentionFollowUpAsync(project,historical.Arguments);
            Require(result.Success&&result.Envelope!.Value.GetProperty("data").GetProperty("records").EnumerateArray()
                .Any(record=>record.GetProperty("id").GetString()=="knowledge:inventory-23"),"The presented historical read did not retrieve an omitted intent.");

            var unrelatedArgs = new[] { "find", "--all", "--scope", "project:unrecognized", "--kind", "knowledge" };
            var unrelatedDispatches = 0;
            await using (var tampered = new LodestarService(service.Runtime, async (invocation, cancellation) => {
                if (invocation.Arguments.SequenceEqual(unrelatedArgs)) unrelatedDispatches++;
                var actual = await service.ExecuteAsync(invocation, cancellation);
                if (invocation.OperationId == "work.attention" && actual.Success) {
                    var envelope = JsonNode.Parse(actual.Envelope!.Value.GetRawText())!;
                    envelope["data"]!["intent_inventory"]!["read_args"]!.AsArray().Add(JsonSerializer.SerializeToNode(unrelatedArgs));
                    return actual with { Envelope = JsonSerializer.SerializeToElement(envelope) };
                }
                return actual;
            }, Path.Combine(directory, "tampered-attention-journal"))) {
                await tampered.DiscoverAsync();
                var tamperedLibrary = await tampered.LoadLibraryAsync();
                var tamperedWindow = Window(tampered);
                Set(tamperedWindow, "_library", tamperedLibrary); Set(tamperedWindow, "_project", project);
                Set(tamperedWindow, "_context", await tampered.ValidateProjectContextAsync(project));
                Set(tamperedWindow, "_workspace", "projects"); Call(tamperedWindow, "ConfigureWorkspace");
                await (Task)Call(tamperedWindow, "RefreshAttentionUiAsync")!;
                var offered = Control<ComboBox>(tamperedWindow, "AttentionReadChoices").Items.Cast<ContinuityReadAction>().ToArray();
                Require(offered.Count(read => read.Arguments[0] == "find") == 2 &&
                    !offered.Any(read => read.Arguments.SequenceEqual(unrelatedArgs)),
                    "Attention response prose admitted an unrelated scope into the production read chooser.");
                var rejected = await tampered.ReadAttentionFollowUpAsync(project, [.. unrelatedArgs]);
                Require(!rejected.Success && rejected.Code == "unsupported_attention_read" && unrelatedDispatches == 0,
                    "An advertised unrelated scope reached the core follow-up transport.");
            }
            var after=await File.ReadAllBytesAsync(service.Runtime.DatabasePath);Require(before.SequenceEqual(after),"Historical attention handler changed database bytes.");
            Console.WriteLine("Historical inventory handler: both literal scopes offered; omitted historical intent retrieved; advertised unrelated scope hidden and refused before follow-up dispatch; database bytes unchanged.");
        } finally { Directory.Delete(directory,true); }
    }

    private static async Task QuestionJourneys()
    {
        var questions = new[] { "Find previous research.", "What is the supporting evidence?", "What remains unfinished?", "Why was this decision made?" };
        var ids = new[] { "find", "get", "work.check", "decision.show" };
        var descriptors = ids.Select((id, index) => new {
            id, argv = id.Split('.'), summary = "fixture typed operation", effect = "read",
            parameters = index < 2 ? new object[] { new { name = index == 0 ? "query" : "id", binding = "positional", index = 0, required = true, schema = new { type = "string" } } } :
                new object[] { new { name = "cwd", binding = "option", flag = "--cwd", required = true, schema = new { type = "string" } } }
                    .Concat(index == 3 ? Array.Empty<object>() : new object[] { new { name = "intent_record_id", binding = "positional", index = 0, required = true, schema = new { type = "string" } } }).ToArray(), constraints = Array.Empty<object>(),
            context = new { project = index >= 2, actor = false }, questions = new[] { questions[index] },
            guidance = new { purpose = "Purpose from central metadata", use = "Choose context and read", scope = "Recorded scope", limits = "Recorded evidence only", recovery = "Refresh the read" }
        }).ToArray();
        var dispatched = new List<CliInvocation>();
        await using var service = Service(invocation => {
            dispatched.Add(invocation);
            return Task.FromResult(invocation.OperationId switch {
                "help" => Reply("help", new { capability_version = 1, operations = descriptors }),
                "start" => Mapping(Project),
                "get" => Reply("get", new { id = "intent:one", kind = "knowledge", scope = "scope:one", availability = "known", data = new { intent = new { version = 1 } } }),
                _ => Reply(invocation.OperationId, new { records = Array.Empty<object>(), complete = true }) });
        });
        await service.DiscoverAsync();
        var window = Window(service);
        Set(window, "_project", Project); Set(window, "_context", new ProjectContextResult(true, Project.Id, Project.Id, "scope:one", [], Root, null, null));
        Call(window, "CommandsClicked", window, new RoutedEventArgs());
        for (var index = 0; index < questions.Length; index++)
        {
            Control<TextBox>(window, "SearchBox").Text = questions[index]; Call(window, "FillCommands");
            var list = Control<ListBox>(window, "SpecialList");
            Require(list.Items.Count == 1, "Question did not match central metadata: " + questions[index]);
            var operation = service.Capabilities!.Operations.Single(o => o.Id == ids[index]);
            Call(window, "ShowCommand", operation);
            var blocks = Control<StackPanel>(window, "CommandFields").Children.OfType<TextBlock>().Select(block => block.Text);
            Require(blocks.Any(text => text.Contains("Purpose from central metadata") && text.Contains("Recorded evidence only")), "Readable guidance missing.");
            if (index < 3)
            {
                Require(Control<Button>(window, "RunCommandButton").Visibility == Visibility.Visible, "Question read is not reachable: " + ids[index]);
                Control<StackPanel>(window, "CommandFields").Children.OfType<TextBox>().Single().Text = index == 0 ? "source evidence" : "intent:one";
                Call(window, "RunCommandClicked", window, new RoutedEventArgs());
                var expected = index == 0 ? new[] { "find", "--", "source evidence" } : index == 1 ? new[] { "get", "--", "intent:one" } : new[] { "work", "check", "--cwd", Root, "--", "intent:one" };
                Require(dispatched.Last().Arguments.SequenceEqual(expected), "Typed question lost exact read arguments: " + ids[index]);
            }
            else
            {
                Call(window, "OpenProjectCommand", operation); Require(Control<TabControl>(window, "MainTabs").SelectedIndex == 4, "Question opened wrong project read.");
                var button = Control<Button>(window, "DecisionStreamButton");
                Call(window, "DomainReadClicked", button, new RoutedEventArgs());
                Require(dispatched.Last().OperationId == ids[index] && dispatched.Last().Arguments.Contains("--cwd") && dispatched.Last().Arguments.Contains(Root), "Question did not run its project read through verified context.");
            }
            Call(window, "CommandsClicked", window, new RoutedEventArgs());
        }
        Control<TextBox>(window, "SearchBox").Text = "Did my save complete?"; Call(window, "FillCommands");
        Require(Control<ListBox>(window, "SpecialList").Items.Count == 1, "Pending-save question has no route.");
        Control<ListBox>(window, "SpecialList").SelectedIndex = 0;
        Require((string)Field(window, "_workspace")! == "recovery", "Pending-save question did not open Recovery.");
    }

    private static async Task ResearchReviewForm()
    {
        await using var service = Service(_ => Task.FromResult(Help()));
        var window = Window(service); Set(window, "_project", Project);
        Set(window, "_context", new ProjectContextResult(true, Project.Id, Project.Id, "scope:one", [], Root, null, null));
        Set(window, "_workspace", "projects");
        var research = RecordProjection.ReadRecord(Json(new { id = "research:one", kind = "research", scope = "scope:one", availability = "known", data = new { body = "original excerpt", source_reference = "https://example.test/source", body_sha256 = "saved-content-hash" } }))!;
        Set(window, "_selectedRecord", research); Set(window, "_detail", new RecordSnapshot(research, null, null, [], "instance", "epoch", 7, DateTimeOffset.UtcNow, null));
        Call(window, "RenderRecordDetail");
        Require(Control<Button>(window, "ReviewSourceButton").Visibility == Visibility.Visible, "Explicit Review source missing.");
        Call(window, "ReviewSourceClicked", window, new RoutedEventArgs());
        var fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
        Require(fields.ContainsKey("reviewed_at") && fields.ContainsKey("review_qualifiers") && fields.ContainsKey("source_version"), "Attestation fields missing.");
        var source = Control<StackPanel>(window, "CommandFields").Children.OfType<TextBlock>().Select(block => block.Text);
        Require(source.Any(text => text.Contains("https://example.test/source") && text.Contains("saved-content-hash") && text.Contains("operator attestation")), "Saved locator/hash or attestation limit omitted.");
        Require(Control<Button>(window, "SaveButton").Visibility == Visibility.Collapsed, "Opening review enables an unreviewed save.");
    }

    private static async Task ConnectionSupport()
    {
        await using var service = Service(_ => Task.FromResult(new CliResult(false, null, "private-code", "secret path " + Root, 1, "secret arguments", 0)));
        await service.DiscoverAsync();
        var diagnostics = App.Diagnostics;
        typeof(DiagnosticLog).GetField("_latest", Private)!.SetValue(diagnostics, new DiagnosticSummary(DateTimeOffset.UtcNow,
            Guid.NewGuid().ToString("N"), DiagnosticOperation.Save, false, "secret exception message", Path.Combine(Root, "private-exact-journal")));
        var window = Window(service); Call(window, "ConnectionClicked", window, new RoutedEventArgs());
        Require(Control<Button>(window, "CopySupportButton").Visibility == Visibility.Visible, "Support copy action missing.");
        var summary = (string)Call(window, "BuildSupportSummary")!;
        Require(summary.Contains("Lodestar Loader support") && summary.Contains("Library coverage") &&
            !summary.Contains(Root, StringComparison.OrdinalIgnoreCase) && !summary.Contains("old content") &&
            !summary.Contains("request.json") && !summary.Contains("unused.db") && !summary.Contains("secret"), "Support summary omitted useful metadata or leaked private content.");
        Require(Control<TextBox>(window, "DetailText").Text.Contains("Storage location is unverified") &&
            Control<TextBox>(window, "DetailText").Text.Contains("private exact journals"), "Storage assumption or journal privacy omitted.");
        string? copied = null;
        Call(window, "CopySupportSummary", (Action<string>)(text => copied = text));
        Require(copied == summary && Control<TextBlock>(window, "StatusText").Text.Contains("copied"), "Copy handler lost summary or success feedback.");
        Call(window, "CopySupportSummary", (Action<string>)(_ => throw new InvalidOperationException("fixture clipboard unavailable")));
        Require(Control<TextBlock>(window, "StatusText").Text.Contains("clipboard outcome is unconfirmed") &&
            Control<TextBlock>(window, "StatusText").Text.Contains("Retry Copy support summary"), "Copy failure did not show outcome and recovery.");
    }

    private static async Task DiagnosticAvailability()
    {
        var directory = Path.Combine(Path.GetTempPath(), "ll-fq02-window-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var diagnosticsField = typeof(App).GetField("<Diagnostics>k__BackingField", BindingFlags.Static | BindingFlags.NonPublic)!;
        var previous = App.Diagnostics;
        var previousWindow = Application.Current.MainWindow;
        try
        {
            var blocked = Path.Combine(directory, "blocked"); File.WriteAllText(blocked, "sentinel");
            var logger = new DiagnosticLog(blocked); diagnosticsField.SetValue(null, logger);
            await using var service = Service(_ => Task.FromResult(Help()));
            var window = Window(service); Application.Current.MainWindow = window;
            Call(window, "SetStatus", "Primary operation failed; outcome is unknown.");
            App.LogFailure(DiagnosticOperation.Save, new InvalidOperationException("PRIVATE_FAKE_SECRET"));
            var text = Control<TextBlock>(window, "StatusText").Text;
            Require(text.Contains("Primary operation failed; outcome is unknown.") &&
                text.Contains("diagnostic", StringComparison.OrdinalIgnoreCase) && text.Contains("Inspect"),
                "Actual App logging failure was hidden or replaced the primary status: " + text);
            Control<TextBlock>(window, "StatusText").Text = "Background primary remains unresolved.";
            await Task.Run(() => App.LogFailure(DiagnosticOperation.TaskUnhandled, new InvalidOperationException("PRIVATE_FAKE_SECRET")));
            await window.Dispatcher.InvokeAsync(() => { }, DispatcherPriority.ApplicationIdle);
            Require(Control<TextBlock>(window, "StatusText").Text.Contains("Background primary remains unresolved.") &&
                Control<TextBlock>(window, "StatusText").Text.Contains("Inspect"), "Background logging adapter lost its notice or primary status.");
            Call(window, "FillConnection");
            text = Control<TextBox>(window, "DetailText").Text;
            Require(text.Contains("unavailable", StringComparison.OrdinalIgnoreCase) && !text.Contains("No recorded diagnostic event"),
                "Connection falsely reported absence for the actual blocked root.");
            var support = (string)Call(window, "BuildSupportSummary")!;
            Require(support.Contains("unavailable", StringComparison.OrdinalIgnoreCase) &&
                !support.Contains("none recorded") && !support.Contains(directory) && !support.Contains("PRIVATE_FAKE_SECRET"),
                "Support omitted diagnostic unavailability or leaked private evidence.");
            App.LogFailure(DiagnosticOperation.Save, new OperationCanceledException());
            Call(window, "SetStatus", "Read cancelled.");
            Require(Control<TextBlock>(window, "StatusText").Text.Contains("Inspect"), "Cancellation erased failed diagnostic notice.");
            File.Delete(blocked); Directory.CreateDirectory(blocked);
            App.LogFailure(DiagnosticOperation.Save, new InvalidOperationException("PRIVATE_FAKE_SECRET"));
            Call(window, "SetStatus", "Primary operation still unresolved.");
            Require(Control<TextBlock>(window, "StatusText").Text == "Primary operation still unresolved.",
                "Successful logger retry did not clear stale failure notice.");
            var empty = Path.Combine(directory, "empty"); Directory.CreateDirectory(empty);
            diagnosticsField.SetValue(null, new DiagnosticLog(empty)); Call(window, "FillConnection");
            Require(Control<TextBox>(window, "DetailText").Text.Contains("No recorded diagnostic event"),
                "True empty local log lost accurate absence presentation.");
            Require(File.ReadAllText(Directory.GetFiles(blocked, "diag-*.json").Single()).Contains("PRIVATE_FAKE_SECRET") == false,
                "Actual adapter persisted exception text.");
        }
        finally
        {
            diagnosticsField.SetValue(null, previous); Application.Current.MainWindow = previousWindow;
            Directory.Delete(directory, true);
        }
    }

    private static async Task ContinuityHandlers()
    {
        var directory = Path.Combine(Path.GetTempPath(), "ll-window-continuity-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var generator = Path.Combine(Directory.GetCurrentDirectory(), "desktop", "Lodestar.Loader.Tests", "generate-fixture.mjs");
            var node = Environment.GetEnvironmentVariable("LODESTAR_TEST_NODE") ?? throw new Exception("Set LODESTAR_TEST_NODE.");
            var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(generator); start.ArgumentList.Add(directory);
            using (var process = Process.Start(start)!)
            {
                var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync(); await output;
                Require(process.ExitCode == 0, "Fixture generation failed: " + await error);
            }
            var runtime = await RuntimeConfig.LoadAsync(Path.Combine(directory, "interfaces.json"));
            await using var service = new LodestarService(runtime, journalRoot: Path.Combine(directory, "journal"));
            await service.DiscoverAsync(); var library = await service.LoadLibraryAsync(); var project = library.Projects.Single();
            var reportedRelease = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(Directory.GetCurrentDirectory(), "package.json")))!["version"]!.GetValue<string>();
            Require(service.Capabilities?.ReleaseVersion == reportedRelease &&
                LodestarHealth.Build(library, service.Capabilities, []).Observations.Single(item => item.Label == "Lodestar release version").Value == reportedRelease,
                "Actual core help release did not reach native health.");
            async Task Create(string id, string kind, object data, string role)
            {
                var work = await service.ReadProjectDomainAsync(project, "work.status");
                var basis = JsonNode.Parse(work.Envelope!.Value.GetProperty("data").GetProperty("write_basis").GetRawText())!;
                var missing = await service.ExecuteAsync(new("get", ["get", "--", id], runtime, TimeSpan.FromSeconds(30)));
                foreach (var target in missing.Envelope!.Value.GetProperty("error").GetProperty("identifiers").GetProperty("write_basis").GetProperty("targets").EnumerateArray())
                    basis["targets"]!.AsArray().Add(JsonNode.Parse(target.GetRawText()));
                var request = new { v = 5, request_id = "continuity-" + Guid.NewGuid().ToString("N"), write_basis = basis,
                    input = new { mode = "create", record = new { id, kind, name = id, scope = project.Id,
                        availability = "known", priority = 1, aliases = Array.Empty<string>(), links = Array.Empty<string>(), sources = Array.Empty<string>(), data,
                        semantics = new { lifecycle = "current", context_role = role, basis = "asserted", applicability = new { project = project.Id, checkout = (string?)null } } } } };
                var file = Path.Combine(directory, "request-" + Guid.NewGuid().ToString("N") + ".json");
                await File.WriteAllTextAsync(file, JsonSerializer.Serialize(request));
                var put = await service.ExecuteAsync(new("put", ["put", "--file", file], runtime, TimeSpan.FromSeconds(30), true, file));
                Require(put.Success, "Fixture put failed: " + put.Message);
            }
            await Create("rejection:idle", "rejection", new { reason = "Idle service creates unnecessary system impact", reconsider_when = "Director changes one-shot boundary" }, "orientation");
            var decision = await service.PrepareOperatorActionAsync("decision", new Dictionary<string, string> {
                ["author"] = "Alex", ["key"] = "route; Ω", ["value"] = "Existing owner", ["reason"] = "Reuse preserves the one-shot boundary",
                ["reference"] = "Disposable Director fixture", ["instruction"] = "Keep one authority" }, project);
            Require(decision.Request is not null && (await service.SaveAsync(decision.Request!)).Saved, "Decision fixture failed: " + decision.Error);
            var decisionRead = await service.ReadProjectDomainAsync(project, "decision.show", decisionKey: "route; Ω");
            var decisionEvent = decisionRead.Envelope!.Value.GetProperty("data").GetProperty("facts")[0].GetProperty("event_id").GetString()!;
            const string intentId = "knowledge:continuity";
            await Create(intentId, "knowledge", new { intent = new { version = 1, brief = "Resume the operator readout job", user_reference = "Disposable fixture",
                boundaries = new[] { "One database" }, non_goals = new[] { "No daemon" }, requirements = new object[] {
                    new { id = "R-root", text = "Preserve baseline", acceptance = "Read existing evidence" },
                    new { id = "R-last", parent_id = "R-root", text = "Finish continuity readout", acceptance = "Inspect connected view" } } },
                continuation = new { active_requirement_ids = new[] { "R-last" }, next_action = "Inspect the missing source",
                    context = new { version = 1, mission_record_ids = new[] { "--missing; Ω", decisionEvent }, requirements = Array.Empty<object>() } } }, "on_demand");
            library = await service.LoadLibraryAsync(); project = library.Projects.Single(); var detail = await service.GetRecordAsync(intentId);
            var before = await File.ReadAllBytesAsync(runtime.DatabasePath);
            var window = Window(service); Set(window, "_library", library); Set(window, "_project", project);
            Set(window, "_workspace", "projects"); Set(window, "_context", await service.ValidateProjectContextAsync(project));
            Call(window, "ConfigureWorkspace"); Set(window, "_selectedRecord", detail.Record); Set(window, "_detail", detail); Call(window, "RenderRecordDetail");
            await (Task)Call(window, "CheckIntentUiAsync")!;
            var text = Control<TextBox>(window, "DetailText").Text;
            Require(text.Contains("Idle service creates") && text.Contains("R-last") && text.Contains("incomplete") && text.Contains("delivered") && text.Contains("Reuse preserves"), "Actual intent handler dropped recorded continuity or claimed delivery.");
            var choices = Control<ComboBox>(window, "ContinuityReadChoices") ?? throw new Exception("No continuity read selector.");
            Require(choices.Items.Count >= 2 && choices.IsTabStop && Control<Button>(window, "ContinuityReadButton").IsTabStop,
                "Continuity reads have no keyboard-reachable actions.");
            var render = Environment.GetEnvironmentVariable("LODESTAR_CONTINUITY_RENDER");
            if (!string.IsNullOrEmpty(render))
            {
                window.Width = 1440; window.Height = 900; window.Measure(new Size(1440, 900)); window.Arrange(new Rect(0, 0, 1440, 900)); window.UpdateLayout();
                var root = Control<Grid>(window, "ClientRoot"); root.Measure(new Size(1440, 860)); root.Arrange(new Rect(0, 0, 1440, 860)); root.UpdateLayout();
                var bitmap = new RenderTargetBitmap(1440, 860, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap)); using var image = File.Create(render); encoder.Save(image);
            }
            choices.SelectedIndex = Enumerable.Range(0, choices.Items.Count).Single(index => choices.Items[index].ToString()!.Contains("rejection:idle"));
            await (Task)Call(window, "ReadContinuityUiAsync")!;
            Require(Control<TextBox>(window, "DetailText").Text.Contains("Idle service creates"), "Actual selected record read did not show the core response.");
            await (Task)Call(window, "CheckIntentUiAsync")!;
            choices.SelectedIndex = Enumerable.Range(0, choices.Items.Count).Single(index => choices.Items[index].ToString()!.StartsWith("Decision:"));
            await (Task)Call(window, "ReadContinuityUiAsync")!;
            Require(Control<TextBox>(window, "DetailText").Text.Contains("Reuse preserves"), "Actual decision read changed the literal key or lost replay reasons.");
            await (Task)Call(window, "CheckIntentUiAsync")!;
            choices.SelectedIndex = Enumerable.Range(0, choices.Items.Count).Single(index => choices.Items[index].ToString()!.Contains("--missing; Ω"));
            await (Task)Call(window, "ReadContinuityUiAsync")!;
            Require(Control<TextBox>(window, "DetailText").Text.Contains("record_not_found") && choices.Items.Count >= 2, "Failed follow-up erased access to unresolved context.");
            Require((await File.ReadAllBytesAsync(runtime.DatabasePath)).SequenceEqual(before), "Read handlers wrote the actual store.");
            BeginDraft(window); var readsBefore = Control<TextBox>(window, "DetailText").Text;
            await (Task)Call(window, "ReadContinuityUiAsync")!; DraftReachable(window);
            Require(Control<TextBox>(window, "DetailText").Text == readsBefore, "Continuity read replaced a protected draft.");

            foreach (var readFollowUp in new[] { false, true })
            {
                var started = new TaskCompletionSource(); var release = new TaskCompletionSource(); var delay = !readFollowUp;
                await using var delayedService = new LodestarService(runtime, async (invocation, cancellation) => {
                    if (delay && (readFollowUp ? invocation.OperationId == "get" && invocation.Arguments[^1] == "rejection:idle" : invocation.OperationId == "work.check"))
                    { started.SetResult(); await release.Task; }
                    return await service.ExecuteAsync(invocation, cancellation);
                }, Path.Combine(directory, "unused-journal"));
                await delayedService.DiscoverAsync();
                var staleWindow = Window(delayedService); Set(staleWindow, "_library", library); Set(staleWindow, "_project", project);
                Set(staleWindow, "_workspace", "projects"); Set(staleWindow, "_context", await delayedService.ValidateProjectContextAsync(project));
                Call(staleWindow, "ConfigureWorkspace"); Set(staleWindow, "_selectedRecord", detail.Record); Set(staleWindow, "_detail", detail); Call(staleWindow, "RenderRecordDetail");
                Task pending;
                if (readFollowUp)
                {
                    await (Task)Call(staleWindow, "CheckIntentUiAsync")!; delay = true;
                    var pick = Control<ComboBox>(staleWindow, "ContinuityReadChoices");
                    pick.SelectedIndex = Enumerable.Range(0, pick.Items.Count).Single(index => pick.Items[index].ToString()!.Contains("rejection:idle"));
                    pending = (Task)Call(staleWindow, "ReadContinuityUiAsync")!;
                }
                else pending = (Task)Call(staleWindow, "CheckIntentUiAsync")!;
                await started.Task;
                Set(staleWindow, "_generation", (int)Field(staleWindow, "_generation")! + 1);
                Call(staleWindow, "SetDetailActions", false); Control<TextBox>(staleWindow, "DetailText").Text = "New selected view";
                release.SetResult(); await pending;
                Require(Control<TextBox>(staleWindow, "DetailText").Text == "New selected view" &&
                    Control<StackPanel>(staleWindow, "ContinuityReadActions").Visibility == Visibility.Collapsed,
                    "Obsolete continuity completion repainted another view or restored obsolete actions.");
            }

            var format = typeof(MainWindow).GetMethod("FormatIntentCheck", BindingFlags.Static | BindingFlags.NonPublic)!;
            var ordered = Reply("work.check", new { plan = new { requirements = new object[] {
                new { id = "child", parent_id = "root", text = "Child", acceptance = "Check child" }, new { id = "root", text = "Root", acceptance = "Check root" } } } });
            var formatted = (string)format.Invoke(null, new object[] { ordered })!;
            Require(formatted.Contains("  • child") && formatted.Contains("\n• root") && formatted.IndexOf("• child") < formatted.IndexOf("• root"),
                "Production formatter changed requirement order/parent indentation.");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static async Task ResearchReviewHandlers()
    {
        var directory = Path.Combine(Path.GetTempPath(), "ll-window-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var source = Directory.GetCurrentDirectory();
            var generator = Path.Combine(source, "desktop", "Lodestar.Loader.Tests", "generate-fixture.mjs");
            var node = Environment.GetEnvironmentVariable("LODESTAR_TEST_NODE") ?? throw new Exception("Set LODESTAR_TEST_NODE.");
            var start = new ProcessStartInfo(node) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add(generator); start.ArgumentList.Add(directory);
            using (var process = Process.Start(start)!)
            {
                var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync(); await output;
                Require(process.ExitCode == 0, "Fixture generation failed: " + await error);
            }
            var runtime = await RuntimeConfig.LoadAsync(Path.Combine(directory, "interfaces.json"));
            await using var service = new LodestarService(runtime, journalRoot: Path.Combine(directory, "journal"));
            await service.DiscoverAsync(); var library = await service.LoadLibraryAsync(); var project = library.Projects.Single();
            var created = await service.PrepareOperatorActionAsync("research", new Dictionary<string, string> {
                ["author"] = "Alex", ["name"] = "Captured source", ["source"] = "https://example.test/spec", ["body"] = "Saved source excerpt",
                ["claim"] = "Evidence of selected API scope", ["limitations"] = "Recorded source only" }, project);
            Require(created.Request is not null, created.Error ?? "No create request");
            Require((await service.SaveAsync(created.Request!)).Saved, "Research creation failed.");
            library = await service.LoadLibraryAsync(); var baseline = await service.GetRecordAsync(created.Request!.RecordId);
            var window = Window(service); Set(window, "_library", library); Set(window, "_project", project);
            Set(window, "_workspace", "projects"); Set(window, "_context", await service.ValidateProjectContextAsync(project));
            Call(window, "ConfigureWorkspace"); Set(window, "_selectedRecord", baseline.Record); Set(window, "_detail", baseline); Call(window, "RenderRecordDetail");
            Call(window, "ReviewSourceClicked", window, new RoutedEventArgs());
            var fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
            fields["author"].Text = "Alex"; fields["reviewed_at"].Text = "2025-02-30"; fields["review_qualifiers"].Text = "Inspected source for API scope";
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            Require(Field(window, "_review") is EditReview { Request: null, Error: { } refusal } && refusal.Contains("date") && refusal.Contains("No write was dispatched"), "Invalid source date did not show actionable no-write refusal.");
            fields["reviewed_at"].Text = "2025-02-03"; fields["source_version"].Text = "v2";
            await (Task)Call(window, "ReviewOperatorActionAsync")!;
            Require(Field(window, "_review") is EditReview { Request: not null }, "Valid attestation did not produce reviewed frozen request.");
            var render = Environment.GetEnvironmentVariable("LODESTAR_NATIVE_LEAD_RENDER");
            if (!string.IsNullOrEmpty(render))
            {
                window.Width = 1440; window.Height = 900;
                window.Measure(new Size(1440, 900)); window.Arrange(new Rect(0, 0, 1440, 900)); window.UpdateLayout();
                var root = Control<Grid>(window, "ClientRoot"); root.Measure(new Size(1440, 860)); root.Arrange(new Rect(0, 0, 1440, 860)); root.UpdateLayout();
                var bitmap = new RenderTargetBitmap(1440, 860, 96, 96, PixelFormats.Pbgra32); bitmap.Render(root);
                var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                using var image = File.Create(render); encoder.Save(image);
            }
            Require(await (Task<bool>)Call(window, "SaveOperatorActionAsync")!, "Production Save handler failed.");
            var after = await service.GetRecordAsync(created.Request.RecordId);
            Require(after.Record!.Json.GetProperty("data").GetProperty("review_acquisition").GetString() == "operator_attested" &&
                after.Record.Json.GetProperty("data").GetProperty("body_sha256").GetRawText() == baseline.Record!.Json.GetProperty("data").GetProperty("body_sha256").GetRawText() && service.PendingSaves().Count == 0,
                "Handler save lost attestation, original source hash or journal settlement.");
        }
        finally { Directory.Delete(directory, true); }
    }

    private static object? Field(MainWindow window, string name) => typeof(MainWindow).GetField(name, Private)!.GetValue(window);
    private static void Set(MainWindow window, string name, object? value) => typeof(MainWindow).GetField(name, Private)!.SetValue(window, value);
    private static object? Call(MainWindow window, string name, params object?[] args) => typeof(MainWindow).GetMethod(name, Private)!.Invoke(window, args);
    private static T Control<T>(MainWindow window, string name) => (T)window.FindName(name);
    private static void Require(bool condition, string message) { if (!condition) throw new Exception(message); }
    private static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value);
    private static CliResult Reply(string operation, object data, long revision = 8, bool more = false, object[]? next = null) =>
        new(true, Json(new { v = 5, ok = true, operation, database_instance_id = "instance", database_epoch = "epoch",
            revision, data, more, next = next ?? [] }), null, "OK", 0, "", 0);
    private static CliResult Help() => Reply("help", new { capability_version = 1, operations = Array.Empty<object>() });
    private static CliResult Mapping(ProjectSummary project) => Reply("start", new { project = new {
        id = project.Id, scope = project.KnownScopes[0], historical_scopes = Array.Empty<string>() } });
    private static ProjectSummary MakeProject(string id, string scope)
    {
        var catalog = RecordProjection.ReadRecord(Json(new { id, kind = "project", scope = "global",
            data = new { roots = new[] { Root } }, semantics = new { applicability = new { project = scope } } }))!;
        return new(id, id, "active", [Root], [scope], 1, 0, DateTimeOffset.UtcNow, Record.Id, true, catalog, [Record]);
    }
    private static LodestarService Service(Func<CliInvocation, Task<CliResult>> execute) =>
        new(Runtime, (invocation, _) => execute(invocation), Path.Combine(Root, "fixture-journal"));
    private static MainWindow Window(LodestarService service)
    {
        var window = new MainWindow(Runtime.ConfigPath, null, null, Path.Combine(Root, "fixture-journal"));
        Set(window, "_service", service); Set(window, "_library", Library);
        return window;
    }
    private static void SelectOld(MainWindow window)
    {
        Set(window, "_selectedRecord", Record);
        Set(window, "_detail", new RecordSnapshot(Record, null, null, [], "instance", "epoch", 7,
            DateTimeOffset.UtcNow, null, []));
        Call(window, "RenderRecordDetail");
    }
    private static Task Capabilities(MainWindow window)
    {
        // The event wrapper runs synchronously on the old source for completed help fixtures.
        var method = typeof(MainWindow).GetMethod("RefreshCapabilitiesUiAsync", Private);
        if (method is not null) return (Task)method.Invoke(window, [])!;
        Call(window, "RefreshCapabilitiesClicked", window, new RoutedEventArgs());
        return Task.CompletedTask;
    }
    private static void BeginDraft(MainWindow window)
    {
        Call(window, "BeginOperatorAction", "project");
        var fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
        fields["name"].Text = "Unsaved meaningful draft";
    }
    private static void DraftReachable(MainWindow window)
    {
        var fields = (Dictionary<string, TextBox>)Field(window, "_operatorFields")!;
        Require((bool)Field(window, "_editing")! && (bool)Field(window, "_draftDirty")!, "Draft state changed.");
        Require(fields["name"].Text == "Unsaved meaningful draft", "Draft bytes changed.");
        Require(Control<ScrollViewer>(window, "CommandPanel").Visibility == Visibility.Visible &&
            Control<Button>(window, "ReviewButton").Visibility == Visibility.Visible &&
            Control<Button>(window, "CancelEditButton").Visibility == Visibility.Visible,
            "Draft panel or normal Review/Discard controls were hidden.");
    }

    private static EditReview FreezeDraft(MainWindow window)
    {
        var requestId = Guid.NewGuid().ToString("D");
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { v = 5, operation = "put", request_id = requestId,
            input = new { id = "project:fixture", set = new { name = "Unsaved meaningful draft" }, remove = Array.Empty<string>() } });
        var frozen = new FrozenMutation(requestId, "project:fixture", Runtime, "instance", "epoch", bytes,
            Path.Combine(Root, "fixture-journal", requestId));
        var review = new EditReview(frozen, "Fixture reviewed draft", null);
        Set(window, "_review", review); Control<Button>(window, "SaveButton").Visibility = Visibility.Visible;
        return review;
    }

    private static void FrozenDraftPreserved(MainWindow window, EditReview review, byte[] expectedBytes)
    {
        DraftReachable(window);
        Require(ReferenceEquals(Field(window, "_review"), review) &&
            review.Request!.ExactRequestUtf8.SequenceEqual(expectedBytes) &&
            Control<Button>(window, "SaveButton").Visibility == Visibility.Visible,
            "Reviewed request identity, bytes or Save control changed.");
    }

    private static async Task ProjectValidationSurvivesDetail()
    {
        var release = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var service = Service(invocation => invocation.OperationId == "start" ? release.Task :
            Task.FromResult(Reply("get", Record.Json)));
        var window = Window(service);
        var projectRead = (Task)Call(window, "SelectProjectAsync", Project)!;
        await (Task)Call(window, "SelectRecordAsync", Record)!;
        await (Task)Call(window, "LoadHistoryAsync")!;
        release.SetResult(Mapping(Project)); await projectRead;
        Require(Field(window, "_context") is ProjectContextResult { Matched: true }, "Matching root validation was discarded by detail/history navigation.");
        Require(Control<Button>(window, "WorkStatusButton").IsEnabled, "Project actions remained disabled.");
    }

    private static async Task ObsoleteProjectValidation()
    {
        var first = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = MakeProject("project:two", "scope:two"); var calls = 0;
        await using var service = Service(_ => ++calls == 1 ? first.Task : Task.FromResult(Mapping(second)));
        var window = Window(service);
        var old = (Task)Call(window, "SelectProjectAsync", Project)!;
        await (Task)Call(window, "SelectProjectAsync", second)!;
        first.SetResult(Mapping(Project)); await old;
        Require(Field(window, "_context") is ProjectContextResult context && context.SelectedProjectId == second.Id,
            "Old project validation overwrote the new project.");
        var delayed = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var oldService = Service(_ => delayed.Task);
        await using var newService = Service(_ => Task.FromResult(Help()));
        window = Window(oldService); old = (Task)Call(window, "SelectProjectAsync", Project)!;
        Set(window, "_service", newService); delayed.SetResult(Mapping(Project)); await old;
        Require(Field(window, "_context") is null, "Old service validation published after runtime replacement.");
    }

    private static async Task CapabilitiesPreserveDraft()
    {
        await using var service = Service(_ => Task.FromResult(Help())); await service.DiscoverAsync();
        var window = Window(service); Set(window, "_workspace", "connection"); Call(window, "ConfigureWorkspace");
        BeginDraft(window); var review = FreezeDraft(window); var bytes = review.Request!.ExactRequestUtf8.ToArray();
        await Capabilities(window); FrozenDraftPreserved(window, review, bytes);
    }

    private static async Task DelayedCapabilitiesPreserveDraft()
    {
        var delayed = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously); var calls = 0;
        await using var service = Service(_ => ++calls == 1 ? Task.FromResult(Help()) : delayed.Task);
        await service.DiscoverAsync(); var window = Window(service); Set(window, "_workspace", "connection"); Call(window, "ConfigureWorkspace");
        var refreshing = Capabilities(window); BeginDraft(window);
        var review = FreezeDraft(window); var bytes = review.Request!.ExactRequestUtf8.ToArray();
        delayed.SetResult(Help()); await refreshing; await Task.Delay(25);
        FrozenDraftPreserved(window, review, bytes);
    }

    private static async Task ObsoleteCapabilities()
    {
        var delayed = new TaskCompletionSource<CliResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var oldService = Service(_ => delayed.Task);
        await using var current = Service(_ => Task.FromResult(Help()));
        var window = Window(oldService); Set(window, "_workspace", "connection");
        var refreshing = Capabilities(window); Set(window, "_service", current);
        Control<TextBlock>(window, "StatusText").Text = "Current runtime status";
        delayed.SetResult(Help()); await refreshing; await Task.Delay(25);
        Require(Control<TextBlock>(window, "StatusText").Text == "Current runtime status", "Old capability result repainted the new runtime.");
    }

    private static async Task CompleteRefreshClearsAbsent()
    {
        await using var service = Service(invocation => Task.FromResult(invocation.OperationId == "help" ? Help() :
            Reply("find", new { records = Array.Empty<object>(), record_errors = Array.Empty<object>(), complete = true })));
        var window = Window(service); SelectOld(window);
        var result = await (Task<RefreshOutcome>)Call(window, "RefreshAsync", false)!;
        Require(result.Complete && result.Revision == 8, "Fixture did not produce complete fresh coverage.");
        AbsentSelection(window);
    }
    private static void AbsentSelection(MainWindow window)
    {
        Require(Field(window, "_selectedRecord") is null && Field(window, "_detail") is null, "Removed record selection or edit basis remained.");
        Require(!Control<TextBox>(window, "DetailText").Text.Contains("old content"), "Old record content still appears current.");
        Require(Control<Button>(window, "EditButton").Visibility != Visibility.Visible &&
            Control<TextBox>(window, "DetailText").Text.Contains("fact:one"), "Absence lacks an explicit ID or leaves Edit reachable.");
    }

    private static async Task IncompleteRefreshPreservesDetail()
    {
        foreach (var failed in new[] { false, true })
        {
            await using var service = Service(invocation => Task.FromResult(invocation.OperationId == "help" ? Help() : failed ?
                new CliResult(false, null, "fixture_read_failed", "fixture read failed", 1, "", 0) :
                Reply("find", new { records = Array.Empty<object>(), record_errors = Array.Empty<object>(), complete = false })));
            var window = Window(service); SelectOld(window);
            var result = await (Task<RefreshOutcome>)Call(window, "RefreshAsync", false)!;
            Require(!result.Complete, "Fixture unexpectedly supplied complete coverage.");
            Require(Field(window, "_selectedRecord") is not null && Field(window, "_detail") is not null,
                "Incomplete coverage erased a selection without evidence of absence.");
        }
    }

    private static async Task CompleteContinuationClearsAbsent()
    {
        var catalogReads = 0;
        await using var service = Service(invocation => {
            var catalog = invocation.Arguments.Contains("--kind");
            if (!catalog) return Task.FromResult(Reply("find", new { records = Array.Empty<object>(), record_errors = Array.Empty<object>(), complete = true }));
            var first = ++catalogReads == 1;
            return Task.FromResult(Reply("find", new { records = first ? new[] { Project.CatalogRecord.Json } : [], record_errors = Array.Empty<object>(), complete = true },
                more: first, next: first ? [new { command = "find", args = new[] { "--all", "--kind", "project", "--history", "--limit", "1", "--offset", "1", "--at-revision", "8" } }] : []));
        });
        var initial = await service.LoadLibraryAsync(batchRecordBudget: 1);
        Require(initial.CanContinue, "Fixture has no continuation.");
        var window = Window(service); Set(window, "_library", initial); SelectOld(window);
        await (Task)Call(window, "ContinueLibraryUiAsync")!;
        Require(Field(window, "_library") is LibrarySnapshot { Complete: true, Error: null }, "Fixture continuation did not complete.");
        AbsentSelection(window);
    }

    private static async Task SurvivingSelectionIsFresh()
    {
        var fresh = Json(new { id = Record.Id, kind = "fact", scope = "scope:one", name = "Fresh record",
            availability = "known", data = new { body = "fresh content" } });
        await using var service = Service(invocation => Task.FromResult(invocation.OperationId switch {
            "help" => Help(), "get" => Reply("get", fresh),
            _ => Reply("find", new { records = invocation.Arguments.Contains("--kind") ? Array.Empty<JsonElement>() : new[] { fresh }, record_errors = Array.Empty<object>(), complete = true }) }));
        var window = Window(service); SelectOld(window);
        var result = await (Task<RefreshOutcome>)Call(window, "RefreshAsync", false)!;
        Require(result.Complete && Field(window, "_detail") is RecordSnapshot { Revision: 8 }, "Surviving ID was not reread freshly.");
        Require(Control<TextBox>(window, "DetailText").Text.Contains("fresh content"), "Fresh selected content is absent.");
    }
}
