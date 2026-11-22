using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Xunit.Abstractions;

namespace Logbird.IntegrationTests;

/// <summary>Viewer tokens, facets and exports against a real Logbird 0.2.0 or later (fictional tenants only).</summary>
public class ScopedReadLiveTests(ITestOutputHelper output)
{
    [LiveFact]
    public async Task A_viewer_token_reads_only_its_scope_with_masks_on_every_route()
    {
        var version = await LiveServer.ServerVersionAsync();
        if (version < new Version(0, 2, 0))
        {
            output.WriteLine($"server {version}: scoped reads need 0.2.0; skipped");
            return;
        }

        var run = Guid.NewGuid().ToString("N").Substring(0, 8);
        var tenant = "biz_a_" + run;
        var other = "biz_b_" + run;
        var site = "site_" + run;
        var inScope = new List<string>();
        await using (var client = new LogbirdClient(LiveServer.Options()))
        {
            for (var i = 0; i < 2; i++)
            {
                var id = LogbirdClient.NewEventId();
                inScope.Add(id);
                client.Track(new AuditEvent("booking.created")
                {
                    Id = id,
                    Actor = AuditActor.User("user_" + run, "Fictional User", "fictional." + run + "@example.invalid"),
                    Tenant = new AuditTenant(tenant),
                    Context = { Ip = "203.0.113.7", UserAgent = "Fictional/1.0" },
                }.Target("website", site));
            }

            // Out of scope: the same tenant on another website, and another tenant on the same website id.
            client.Track(new AuditEvent("booking.created") { Tenant = new AuditTenant(tenant) }.Target("website", "elsewhere_" + run));
            client.Track(new AuditEvent("booking.created") { Tenant = new AuditTenant(other) }.Target("website", site));
            Assert.True(await client.FlushAsync());
            Assert.Equal(4, client.Stats.Delivered);
        }

        using var reader = LiveServer.Reader();
        foreach (var id in inScope)
        {
            await LiveServer.WaitForEventAsync(reader, id);
        }

        var token = await reader.MintViewerTokenAsync(
            new ViewerScope(tenant) { Target = new ViewerScopeTarget("website", site), Mask = ViewerMask.Ip | ViewerMask.ActorEmail },
            TimeSpan.FromMinutes(5));
        Assert.True(token.ExpiresAt > DateTimeOffset.UtcNow);
        using var scoped = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri(LiveServer.Endpoint!), ReadKey = token.Token });
        var from = DateTimeOffset.UtcNow.AddHours(-1);

        // Search: exactly the in-scope events, masked; a query naming the other tenant stays inside the scope.
        var found = new List<StoredEvent>();
        await foreach (var e in scoped.SearchAllAsync(new EventSearch { From = from, Limit = 200 }))
        {
            found.Add(e);
        }

        Assert.Equal(inScope.OrderBy(x => x, StringComparer.Ordinal), found.Select(e => e.Id).OrderBy(x => x, StringComparer.Ordinal));
        Assert.All(found, e => Assert.True(string.IsNullOrEmpty(e.Context.Ip)));
        Assert.All(found, e => Assert.StartsWith("masked:", e.Actor!.Email));
        Assert.Empty((await scoped.SearchAsync(new EventSearch { From = from, Query = "tenant:" + other })).Events);

        // Detail: the payload is hidden by the mask.
        var detail = await scoped.GetAsync(inScope[0]);
        Assert.NotNull(detail);
        Assert.Equal(System.Text.Json.JsonValueKind.Null, detail!.Payload.ValueKind);

        // Facets count in-scope events only.
        var facets = await scoped.FacetsAsync(new FacetQuery("action") { From = from });
        Assert.Equal(2, facets.Values.Sum(v => v.Count) + facets.OtherCount);

        // Exports: in-scope rows only; an evidence export of a masked scope is refused.
        using (var file = new MemoryStream())
        {
            await scoped.ExportAsync(new ExportQuery(ExportFormat.Jsonl) { From = from }, file);
            var lines = Encoding.UTF8.GetString(file.ToArray()).Split(['\n'], StringSplitOptions.RemoveEmptyEntries);
            Assert.Equal(2, lines.Length);
            Assert.All(inScope, id => Assert.Contains(lines, line => line.Contains(id, StringComparison.Ordinal)));
        }

        using (var evidence = new MemoryStream())
        {
            var refused = await Assert.ThrowsAsync<LogbirdApiException>(() => scoped.ExportAsync(new ExportQuery(ExportFormat.JsonlEvidence) { From = from }, evidence));
            Assert.Equal("masked_export", refused.Code);
        }

        output.WriteLine($"server {version}: viewer token read {found.Count} in-scope events (masked), facets and export scoped, evidence export refused");
    }
}
