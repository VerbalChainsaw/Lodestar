using System.Text.Json;
using Lodestar.Loader;

public static class ContinuationChecks
{
    public static async Task RunAsync()
    {
        await SmallBatchesAndCatalogAsync();
        await ExactBoundaryAsync();
        await MultiplePagesInOneBatchAsync();
        await RevisionDriftAsync();
        await CursorGapAsync();
        await CancellationAsync();
        await CompleteRefreshRetentionAsync();
        await LargerSetAsync();
        await RuntimeSwitchAsync();
    }

    private static async Task SmallBatchesAndCatalogAsync()
    {
        var feed = new Feed(5, 7);
        await using var service = NewService(feed);
        var callbacks = new List<LibrarySnapshot>();
        var snapshot = await service.LoadLibraryAsync(onCatalogReady: callbacks.Add, batchRecordBudget: 2);
        Require(snapshot.CatalogOnly && !snapshot.Complete && snapshot.HasMore && snapshot.CanContinue &&
            snapshot.LoadedCount == 2 && callbacks.Count == 0, "The first catalog batch was not resumable.");
        var batches = 1;
        var budgets = new[] { 3, 1, 2 };
        while (snapshot.CanContinue && batches < 20)
        {
            snapshot = await service.ContinueLibraryAsync(onCatalogReady: callbacks.Add,
                batchRecordBudget: budgets[(batches - 1) % budgets.Length]);
            batches++;
        }
        Require(snapshot.Complete && !snapshot.HasMore && !snapshot.CanContinue &&
            snapshot.LoadedCount == 12 && snapshot.Records.Length == 7 &&
            snapshot.Records.Select(r => r.Id).Distinct(StringComparer.Ordinal).Count() == 7 &&
            callbacks.Count == 1 && callbacks[0].CatalogOnly && callbacks[0].Projects.Length == 5,
            "Small batches lost or duplicated rows, or catalog publication was wrong.");
        Require(snapshot.Records.Select(r => r.Id).Order(StringComparer.Ordinal)
            .SequenceEqual(Enumerable.Range(0, 7).Select(i => $"fact:{i}").Order(StringComparer.Ordinal)),
            "Small batches omitted a current row.");
    }

    private static async Task ExactBoundaryAsync()
    {
        var feed = new Feed(0, 2);
        await using var service = NewService(feed);
        var snapshot = await service.LoadLibraryAsync(batchRecordBudget: 2);
        Require(snapshot.Complete && !snapshot.HasMore && !snapshot.CanContinue &&
            snapshot.LoadedCount == 2 && snapshot.Error is null,
            "A final page exactly at the batch limit was called partial.");
    }

    private static async Task MultiplePagesInOneBatchAsync()
    {
        var feed = new Feed(501, 1003);
        await using var service = NewService(feed);
        var snapshot = await service.LoadLibraryAsync(batchRecordBudget: 2000);
        Require(snapshot.Complete && !snapshot.HasMore && !snapshot.CanContinue &&
            snapshot.LoadedCount == 1504 && snapshot.Records.Length == 1003,
            "A multi-page scan retained an earlier continuation after its final page.");
    }

    private static async Task RevisionDriftAsync()
    {
        var feed = new Feed(1, 4);
        await using var service = NewService(feed);
        var first = await service.LoadLibraryAsync(batchRecordBudget: 1);
        Require(first.CanContinue && !first.Complete, "Drift fixture did not establish a partial scan.");
        feed.Revision++;
        var drifted = await service.ContinueLibraryAsync(batchRecordBudget: 1);
        Require(!drifted.Complete && !drifted.CanContinue && drifted.Error is not null &&
            drifted.Records.IsEmpty && service.LastCompleteLibrary is null,
            "Changed revision was merged into a partial library.");
        var noCursor = await service.ContinueLibraryAsync(batchRecordBudget: 1);
        Require(!noCursor.CanContinue && noCursor.Error?.Contains("no safe library continuation") == true,
            "A drifted cursor remained usable.");
        var restarted = await service.LoadLibraryAsync(batchRecordBudget: 10);
        Require(restarted.Complete && restarted.Revision == feed.Revision && restarted.LoadedCount == 5,
            "Fresh load after revision drift failed.");

        foreach (var change in new[] { "instance", "epoch" })
        {
            var identityFeed = new Feed(3, 1);
            await using var identityService = NewService(identityFeed);
            var pending = await identityService.LoadLibraryAsync(batchRecordBudget: 1);
            Require(pending.CanContinue, "Identity drift fixture did not establish a catalog cursor.");
            if (change == "instance") identityFeed.Instance = "replacement";
            else identityFeed.Epoch = "replacement";
            var rejected = await identityService.ContinueLibraryAsync(batchRecordBudget: 1);
            Require(!rejected.Complete && !rejected.CanContinue && rejected.Error is not null &&
                rejected.Records.IsEmpty, $"Changed {change} was merged into the catalog.");
        }
    }

    private static async Task CancellationAsync()
    {
        var feed = new Feed(0, 5);
        await using var service = NewService(feed);
        var first = await service.LoadLibraryAsync(batchRecordBudget: 1);
        using var cancellation = new CancellationTokenSource();
        feed.OnFind = invocation =>
        {
            if (invocation.Arguments.Contains("--offset")) cancellation.Cancel();
        };
        try
        {
            await service.ContinueLibraryAsync(cancellation.Token, batchRecordBudget: 3);
            throw new Exception("Continuation ignored cancellation.");
        }
        catch (OperationCanceledException) { }
        feed.OnFind = null;
        var resumed = await service.ContinueLibraryAsync(batchRecordBudget: 10);
        Require(first.Records.Length == 1 && resumed.Complete && resumed.Records.Length == 5 &&
            resumed.Records.Select(r => r.Id).Distinct(StringComparer.Ordinal).Count() == 5,
            "Cancellation committed a half batch or lost its cursor.");
    }

    private static async Task CursorGapAsync()
    {
        var feed = new Feed(0, 5) { OffsetDelta = 1 };
        await using var service = NewService(feed);
        var partial = await service.LoadLibraryAsync(batchRecordBudget: 1);
        Require(!partial.Complete && partial.HasMore && !partial.CanContinue &&
            partial.LoadedCount == 1 && partial.Advisories.Any(a => a.Contains("valid continuation")),
            "A skipping cursor was accepted or labeled complete.");
    }

    private static async Task CompleteRefreshRetentionAsync()
    {
        var feed = new Feed(1, 5);
        await using var service = NewService(feed);
        var prior = await service.LoadLibraryAsync(batchRecordBudget: 10);
        Require(prior.Complete, "Retention fixture did not establish a complete library.");
        var partial = await service.LoadLibraryAsync(batchRecordBudget: 2);
        Require(partial.Complete && partial.ReadAt == prior.ReadAt && partial.Error?.Contains("partial") == true &&
            partial.HasMore && partial.CanContinue && ReferenceEquals(service.LastCompleteLibrary, prior),
            "Partial refresh replaced the dated complete snapshot or hid continuation.");
        var current = partial;
        for (var attempts = 0; current.CanContinue && attempts < 10; attempts++)
            current = await service.ContinueLibraryAsync(batchRecordBudget: 2);
        Require(current.Complete && !current.CanContinue && current.Error is null &&
            current.LoadedCount == 6 && ReferenceEquals(service.LastCompleteLibrary, current),
            "Completed refresh did not replace the retained snapshot.");
    }

    private static async Task LargerSetAsync()
    {
        var feed = new Feed(3, 1003);
        await using var service = NewService(feed);
        var snapshot = await service.LoadLibraryAsync(batchRecordBudget: 73);
        var batches = 1;
        while (snapshot.CanContinue && batches++ < 100)
            snapshot = await service.ContinueLibraryAsync(batchRecordBudget: 73);
        Require(snapshot.Complete && snapshot.LoadedCount == 1006 && snapshot.Records.Length == 1003 &&
            snapshot.Records.Select(r => r.Id).Distinct(StringComparer.Ordinal).Count() == 1003 &&
            batches > 10, "The larger synthetic set did not page losslessly.");
    }

    private static async Task RuntimeSwitchAsync()
    {
        var feed = new Feed(0, 5);
        await using var service = NewService(feed);
        var partial = await service.LoadLibraryAsync(batchRecordBudget: 1);
        Require(partial.CanContinue, "Runtime-switch fixture did not establish a cursor.");
        await service.DiscoverAsync(new RuntimeSelection("other", "g", "n", "m", "other-db", "other"));
        var afterSwitch = await service.ContinueLibraryAsync(batchRecordBudget: 1);
        Require(!afterSwitch.CanContinue && afterSwitch.Error?.Contains("no safe library continuation") == true,
            "Runtime switch left an old cursor active.");
    }

    private static LodestarService NewService(Feed feed) => new(
        new RuntimeSelection("config", "g", "node", "cli", "db", "fingerprint"), feed.ExecuteAsync);

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private sealed class Feed(int catalogCount, int currentCount)
    {
        private readonly JsonElement[] _catalog = Enumerable.Range(0, catalogCount)
            .Select(i => Row($"project:{i}", "project", "global")).ToArray();
        private readonly JsonElement[] _current = Enumerable.Range(0, currentCount)
            .Select(i => Row($"fact:{i}", "fact", "global")).ToArray();
        public long Revision { get; set; } = 5;
        public string Instance { get; set; } = "instance";
        public string Epoch { get; set; } = "epoch";
        public int OffsetDelta { get; set; }
        public Action<CliInvocation>? OnFind { get; set; }

        public Task<CliResult> ExecuteAsync(CliInvocation invocation, CancellationToken cancellation)
        {
            if (invocation.OperationId == "help")
                return Task.FromResult(Success("help", new { capability_version = 1,
                    operations = Array.Empty<object>() }, false, []));
            var args = invocation.Arguments.ToList();
            var catalog = args.Contains("--kind");
            var atRevision = Value(args, "--at-revision");
            if (atRevision is not null && atRevision != Revision.ToString())
                return Task.FromResult(new CliResult(false, null, "read_revision_conflict",
                    "Pinned revision changed.", 2, "", 0));
            var rows = catalog ? _catalog : _current;
            var offset = int.TryParse(Value(args, "--offset"), out var parsedOffset) ? parsedOffset : 0;
            var limit = int.Parse(Value(args, "--limit")!);
            var page = rows.Skip(offset).Take(limit).ToArray();
            var more = offset + page.Length < rows.Length;
            var next = more ? new object[] { new { command = "find",
                args = Next(args, offset + page.Length + OffsetDelta, Revision) } } : [];
            OnFind?.Invoke(invocation);
            return Task.FromResult(Success("find", new { records = page, record_errors = Array.Empty<object>(),
                complete = true }, more, next));
        }

        private CliResult Success(string operation, object data, bool more, object[] next)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new {
                v = 5, ok = true, operation, database_instance_id = Instance,
                database_epoch = Epoch, revision = Revision, data, more, next
            }));
            return new(true, document.RootElement.Clone(), null, "OK", 0, "", 0);
        }

        private static string? Value(List<string> args, string flag)
        {
            var index = args.IndexOf(flag);
            return index >= 0 && index + 1 < args.Count ? args[index + 1] : null;
        }

        private static string[] Next(List<string> args, int offset, long revision)
        {
            var stable = args.Skip(1).ToList();
            foreach (var flag in new[] { "--offset", "--at-revision" })
            {
                var index = stable.IndexOf(flag);
                if (index >= 0) stable.RemoveRange(index, 2);
            }
            stable.AddRange(["--offset", offset.ToString(), "--at-revision", revision.ToString()]);
            return stable.ToArray();
        }

        private static JsonElement Row(string id, string kind, string scope)
        {
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(new { id, kind, scope,
                name = id, data = new { status = "active" },
                semantics = new { applicability = new { project = id } } }));
            return document.RootElement.Clone();
        }
    }
}
