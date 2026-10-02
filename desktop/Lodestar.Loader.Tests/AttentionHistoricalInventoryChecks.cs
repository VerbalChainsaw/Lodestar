using System.Collections.Immutable;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lodestar.Loader;

public static class AttentionHistoricalInventoryChecks
{
    public const string HistoricalScope = "project:loader-before";
    public static async Task<(string Root, LodestarService Service, ProjectSummary Project)> SetupAsync()
    {
        var (root, service, project) = await OperatorImprovementChecks.FixtureAsync();
        try {
        var historicalRoot = Path.Combine(root,"historical"); Directory.CreateDirectory(historicalRoot);
        await CreateAsync(HistoricalScope,"project","global",new { roots=new[] { historicalRoot } },null,HistoricalScope);
        var intent = (await service.GetRecordAsync("knowledge:operator-intent")).Record!.Json.GetProperty("data").GetProperty("intent");
        for (var index=0; index<24; index++) {
            var scope = index%2==0 ? project.Id : HistoricalScope;
            await CreateAsync("knowledge:inventory-"+index.ToString("00"),"knowledge",scope,new { intent },index%2==0 ? root : historicalRoot,scope);
        }
        var historical = await service.GetRecordAsync(HistoricalScope); var canonical = await service.GetRecordAsync(project.Id);
        var work = await CallAsync(["work","status","--cwd",historicalRoot]);
        var basis = JsonNode.Parse(work.Envelope!.Value.GetProperty("data").GetProperty("write_basis").GetRawText())!;
        AddTargets(basis,historical.WriteBasis!.Value); AddTargets(basis,canonical.WriteBasis!.Value);
        await PutAsync(new { mode="update", id=HistoricalScope,set=new { data=new { canonical_project_id=project.Id },
            links=new[] { new { relationship="canonical-project",to_id=project.Id } } },remove=Array.Empty<string>() },basis,historicalRoot);
        project=(await service.LoadLibraryAsync()).Projects.Single(row=>row.Id==project.Id);
        return (root,service,project);
        } catch { await service.DisposeAsync(); Directory.Delete(root,true); throw; }

        async Task CreateAsync(string id,string kind,string scope,object data,string? cwd,string applicable)
        {
            var missing=await CallAsync(["get","--",id]);
            var absent=missing.Envelope!.Value.GetProperty("error").GetProperty("identifiers").GetProperty("write_basis");
            JsonNode selected;
            if(cwd is null) selected=JsonNode.Parse(absent.GetRawText())!;
            else { var status=await CallAsync(["work","status","--cwd",cwd]);selected=JsonNode.Parse(status.Envelope!.Value.GetProperty("data").GetProperty("write_basis").GetRawText())!;AddTargets(selected,absent); }
            await PutAsync(new { mode="create",record=new { id,kind,name=id,scope,availability="known",priority=1,aliases=Array.Empty<string>(),links=Array.Empty<string>(),sources=Array.Empty<string>(),data,
                semantics=new { lifecycle="current",context_role="on_demand",basis="asserted",applicability=new { project=applicable,checkout=(string?)null } } } },selected,cwd);
        }
        async Task PutAsync(object input,JsonNode basis,string? cwd)
        {
            var file=Path.Combine(root,"inventory-request-"+Guid.NewGuid().ToString("N")+".json");
            await File.WriteAllTextAsync(file,JsonSerializer.Serialize(new { v=5,request_id="fixture-"+Guid.NewGuid(),write_basis=basis,input }));
            var args=new List<string> { "put","--file",file };
            var saved=await service.ExecuteAsync(new("put",args.ToImmutableArray(),service.Runtime,TimeSpan.FromSeconds(30),true,file));
            OperatorImprovementChecks.Require(saved.Success,"Historical inventory setup failed: "+saved.Message);
        }
        Task<CliResult> CallAsync(ImmutableArray<string> args)=>service.ExecuteAsync(new(args[0]=="work" ? "work.status" : args[0],args,service.Runtime,TimeSpan.FromSeconds(30)));
    }

    private static void AddTargets(JsonNode basis,JsonElement addition)
    {
        var targets=basis["targets"]!.AsArray();
        foreach(var target in addition.GetProperty("targets").EnumerateArray())
            if(!targets.Any(row=>row?["kind"]?.GetValue<string>()==target.GetProperty("kind").GetString()&&row?["id"]?.GetValue<string>()==target.GetProperty("id").GetString()))
                targets.Add(JsonNode.Parse(target.GetRawText()));
    }

    public static ImmutableArray<ImmutableArray<string>> Reads(JsonElement arguments)=>arguments[0].ValueKind==JsonValueKind.String
        ? [arguments.EnumerateArray().Select(token=>token.GetString()!).ToImmutableArray()]
        : arguments.EnumerateArray().Select(row=>row.EnumerateArray().Select(token=>token.GetString()!).ToImmutableArray()).ToImmutableArray();

    public static async Task RunAsync()
    {
        var (root,service,project)=await SetupAsync();
        await using(service) try {
            var before=await File.ReadAllBytesAsync(service.Runtime.DatabasePath);
            var attention=await service.ReadAttentionAsync(project);
            OperatorImprovementChecks.Require(attention.Success,"Historical attention read failed: "+attention.Message);
            var data=attention.Envelope!.Value.GetProperty("data");var inventory=data.GetProperty("intent_inventory");
            OperatorImprovementChecks.Require(data.GetProperty("intents").GetArrayLength()==20&&inventory.GetProperty("more").GetBoolean()&&inventory.GetProperty("omitted_count").GetInt32()==5,"Historical overflow coverage is inaccurate.");
            var reads=Reads(inventory.GetProperty("read_args"));
            OperatorImprovementChecks.Require(reads.Length==2&&reads.Any(args=>args[3]==HistoricalScope),"Historical full inventory read is absent.");
            var recovered=new HashSet<string>(StringComparer.Ordinal);
            foreach(var args in reads) {
                var result=await service.ReadAttentionFollowUpAsync(project,args);
                OperatorImprovementChecks.Require(result.Success,"An admitted exact historical inventory read was rejected: "+result.Message);
                foreach(var record in result.Envelope!.Value.GetProperty("data").GetProperty("records").EnumerateArray()) recovered.Add(record.GetProperty("id").GetString()!);
            }
            OperatorImprovementChecks.Require(recovered.Contains("knowledge:inventory-21")&&recovered.Contains("knowledge:inventory-23")&&recovered.Count==25,"Literal full reads did not recover omitted historical intents.");
            var unknown=await service.ReadAttentionFollowUpAsync(project,["find","--all","--scope","project:unrecognized","--kind","knowledge"]);
            OperatorImprovementChecks.Require(!unknown.Success,"An unrecognized scope inventory read was admitted.");
            var after=await File.ReadAllBytesAsync(service.Runtime.DatabasePath);
            OperatorImprovementChecks.Require(before.SequenceEqual(after),"Attention and full inventory follow-ups changed database bytes.");
            Console.WriteLine(JsonSerializer.Serialize(new { displayed=20,omitted=5,literal_reads=reads.Select(args=>args.ToArray()),recovered_historical=new[] { "knowledge:inventory-21","knowledge:inventory-23" },recovered_count=recovered.Count,
                unrecognized_scope_rejected=true,database_bytes_unchanged=true,database_sha256=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(before)).ToLowerInvariant(),core_source_digest=service.Runtime.CoreSourceDigest }));
        } finally { Directory.Delete(root,true); }
    }
}
