using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Xunit.Abstractions;

namespace Logbird.IntegrationTests;

/// <summary>Viewer tokens, facets and exports against a real Logbird 0.2.0 or later (fictional tenants only).</summary>
public class ScopedReadLiveTests(ITestOutputHelper output)
{
    private const string Ip = "203.0.113.7";
    private const string UserAgent = "Fictional/1.0";


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
        var elsewhere = "elsewhere_" + run;
        var email = "fictional." + run + "@example.invalid";
        var inScope = new List<string>();

        // Two controls, each with its own action, so a facet or export that counted them would show it: the same tenant
        // on another website, and another tenant on the same website id. Both carry the same IP, agent and email.
        var sameTenantOtherSite = LogbirdClient.NewEventId();
        var otherTenantSameSite = LogbirdClient.NewEventId();
        await using (var client = new LogbirdClient(LiveServer.Options()))
        {
            for (var i = 0; i < 2; i++)
            {
                var id = LogbirdClient.NewEventId();
                inScope.Add(id);
                client.Track(Fixture("booking.created", id, tenant, site));
            }

            client.Track(Fixture("booking.control_site", sameTenantOtherSite, tenant, elsewhere));
            client.Track(Fixture("booking.control_tenant", otherTenantSameSite, other, site));
            Assert.True(await client.FlushAsync());
            Assert.Equal(4, client.Stats.Delivered);
        }

        AuditEvent Fixture(string action, string id, string tenantId, string website)
            => new AuditEvent(action)
            {
                Id = id,
                Actor = AuditActor.User("user_" + run, "Fictional User", email),
                Tenant = new AuditTenant(tenantId),
                Context = { Ip = Ip, UserAgent = UserAgent },
            }.Target("website", website);

        // Unscoped, every fixture is stored as sent: the right tenant and website, and the clear values the masks hide.
        using var reader = LiveServer.Reader();
        var expected = new Dictionary<string, (string Tenant, string Website)>
        {
            [inScope[0]] = (tenant, site),
            [inScope[1]] = (tenant, site),
            [sameTenantOtherSite] = (tenant, elsewhere),
            [otherTenantSameSite] = (other, site),
        };
        foreach (var pair in expected)
        {
            var stored = await LiveServer.WaitForEventAsync(reader, pair.Key);
            Assert.Equal(pair.Value.Tenant, stored.Event.Tenant?.Id);
            var target = Assert.Single(stored.Event.Targets);
            Assert.Equal(("website", pair.Value.Website), (target.Type, target.Id));
            Assert.Equal(Ip, stored.Event.Context.Ip);
            Assert.Equal(UserAgent, stored.Event.Context.UserAgent);
            Assert.Equal(email, stored.Event.Actor?.Email);
            Assert.Equal(JsonValueKind.Object, stored.Payload.ValueKind);
        }

        var token = await reader.MintViewerTokenAsync(
            new ViewerScope(tenant)
            {
                Target = new ViewerScopeTarget("website", site),
                Mask = ViewerMask.Ip | ViewerMask.UserAgent | ViewerMask.ActorEmail,
            },
            TimeSpan.FromMinutes(5));
        Assert.True(token.ExpiresAt > DateTimeOffset.UtcNow);
        using var scoped = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri(LiveServer.Endpoint!), ReadKey = token.Token });
        var from = DateTimeOffset.UtcNow.AddHours(-1);

        // Search: exactly the in-scope events, each masked; a query naming the other tenant stays inside the scope.
        var found = new List<StoredEvent>();
        await foreach (var e in scoped.SearchAllAsync(new EventSearch { From = from, Limit = 200 }))
        {
            found.Add(e);
        }

        Assert.Equal(inScope.OrderBy(x => x, StringComparer.Ordinal), found.Select(e => e.Id).OrderBy(x => x, StringComparer.Ordinal));
        Assert.All(found, AssertMasked);
        Assert.Empty((await scoped.SearchAsync(new EventSearch { From = from, Query = "tenant:" + other })).Events);

        // Detail: masked, with no payload; neither control can be read by id.
        var detail = await scoped.GetAsync(inScope[0]);
        Assert.NotNull(detail);
        AssertMasked(detail!.Event);
        Assert.Equal(JsonValueKind.Null, detail.Payload.ValueKind);
        Assert.Null(await scoped.GetAsync(sameTenantOtherSite));
        Assert.Null(await scoped.GetAsync(otherTenantSameSite));

        // Facets count the in-scope action only: a control's action would appear as its own value.
        var facets = await scoped.FacetsAsync(new FacetQuery("action") { From = from });
        var value = Assert.Single(facets.Values);
        Assert.Equal(("booking.created", 2L), (value.Value, value.Count));
        Assert.Equal(0, facets.OtherCount);

        // Exports: exactly the in-scope rows, each masked; an evidence export of a masked scope is refused.
        using (var file = new MemoryStream())
        {
            await scoped.ExportAsync(new ExportQuery(ExportFormat.Jsonl) { From = from }, file);
            var lines = Encoding.UTF8.GetString(file.ToArray()).Split([(char)10], StringSplitOptions.RemoveEmptyEntries);
            var rows = lines.Select(Parse).ToArray();
            Assert.Equal(inScope.OrderBy(x => x, StringComparer.Ordinal), rows.Select(r => r.GetProperty("id").GetString()).OrderBy(x => x, StringComparer.Ordinal));
            foreach (var row in rows)
            {
                Assert.True(string.IsNullOrEmpty(Text(row, "context", "ip")), "export ip");
                Assert.True(string.IsNullOrEmpty(Text(row, "context", "userAgent")), "export user agent");
                AssertMaskedEmail(Text(row, "actor", "email"));
            }

            Assert.DoesNotContain(Ip, Encoding.UTF8.GetString(file.ToArray()), StringComparison.Ordinal);
            Assert.DoesNotContain(email, Encoding.UTF8.GetString(file.ToArray()), StringComparison.Ordinal);
        }

        using (var evidence = new MemoryStream())
        {
            var refused = await Assert.ThrowsAsync<LogbirdApiException>(() => scoped.ExportAsync(new ExportQuery(ExportFormat.JsonlEvidence) { From = from }, evidence));
            Assert.Equal("masked_export", refused.Code);
        }

        output.WriteLine($"server {version}: viewer token read {found.Count} in-scope events (ip, agent, email masked on search, detail and export), controls hidden, facets scoped, evidence export refused");
    }

    [LiveFact(requires: "LOGBIRD_IT_SCOPED")]
    public async Task A_scoped_read_key_reads_and_mints_only_inside_its_tenant()
    {
        // A scoped-read key whose scope is exactly {"tenantId": LOGBIRD_IT_SCOPED_TENANT}, created in the console.
        var scopedKey = Environment.GetEnvironmentVariable("LOGBIRD_IT_SCOPED_READ_KEY");
        var tenant = Environment.GetEnvironmentVariable("LOGBIRD_IT_SCOPED_TENANT");
        Assert.False(string.IsNullOrEmpty(scopedKey), "set LOGBIRD_IT_SCOPED_READ_KEY");
        Assert.False(string.IsNullOrEmpty(tenant), "set LOGBIRD_IT_SCOPED_TENANT");
        var version = await LiveServer.ServerVersionAsync();
        Assert.True(version >= new Version(0, 2, 0), "scoped read keys need 0.2.0; the server reports " + version);

        var run = Guid.NewGuid().ToString("N").Substring(0, 8);
        var site = "site_" + run;
        var inside = LogbirdClient.NewEventId();
        var outside = LogbirdClient.NewEventId();
        var otherSite = LogbirdClient.NewEventId();
        await using (var client = new LogbirdClient(LiveServer.Options()))
        {
            client.Track(new AuditEvent("booking.created") { Id = inside, Tenant = new AuditTenant(tenant!) }.Target("website", site));
            client.Track(new AuditEvent("booking.created") { Id = outside, Tenant = new AuditTenant("other_" + run) }.Target("website", site));

            // Same tenant, another website: the key reads it, a token narrowed to `site` must not.
            client.Track(new AuditEvent("booking.created") { Id = otherSite, Tenant = new AuditTenant(tenant!) }.Target("website", "elsewhere_" + run));
            Assert.True(await client.FlushAsync());
            Assert.Equal(3, client.Stats.Delivered);
        }

        using var reader = LiveServer.Reader();
        await LiveServer.WaitForEventAsync(reader, inside);
        await LiveServer.WaitForEventAsync(reader, outside);
        await LiveServer.WaitForEventAsync(reader, otherSite);

        using var scoped = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri(LiveServer.Endpoint!), ReadKey = scopedKey });
        var from = DateTimeOffset.UtcNow.AddHours(-1);

        // The key reads its tenant's event and never the other tenant's, by id or by search.
        Assert.NotNull(await scoped.GetAsync(inside));
        Assert.Null(await scoped.GetAsync(outside));
        Assert.NotNull(await scoped.GetAsync(otherSite));
        var bySite = await scoped.SearchAsync(EventSearch.ForTrail(targetId: site, targetType: "website", from: from));
        Assert.Equal([inside], bySite.Events.Select(e => e.Id));

        // Facets by tenant see only the key's tenant.
        var tenants = await scoped.FacetsAsync(new FacetQuery("tenant") { From = from });
        // Facets by tenant: exactly one bucket, the key's tenant, holding at least this run's two events, and nothing else.
        var bucket = Assert.Single(tenants.Values);
        Assert.Equal(tenant, bucket.Value);
        Assert.True(bucket.Count >= 2, "tenant bucket count: " + bucket.Count);
        Assert.Equal(0, tenants.OtherCount);

        // It mints a narrower token (one website of its tenant), and refuses a token for another tenant.
        var token = await scoped.MintViewerTokenAsync(new ViewerScope(tenant!) { Target = new ViewerScopeTarget("website", site) }, TimeSpan.FromMinutes(2));
        using (var viewer = new LogbirdReadClient(new LogbirdReadOptions { Endpoint = new Uri(LiveServer.Endpoint!), ReadKey = token.Token }))
        {
            var seen = new List<string>();
            await foreach (var e in viewer.SearchAllAsync(new EventSearch { From = from }))
            {
                seen.Add(e.Id);
            }

            Assert.Equal([inside], seen);
        }

        var wider = await Assert.ThrowsAsync<LogbirdApiException>(() => scoped.MintViewerTokenAsync(new ViewerScope("other_" + run)));
        Assert.Equal("scope_exceeded", wider.Code);

        output.WriteLine($"server {version}: scoped key read its tenant only (by id, trail and facets), minted a narrower token that saw 1 event, and was refused a token for another tenant");
    }

    private static void AssertMasked(StoredEvent e)
    {
        Assert.True(string.IsNullOrEmpty(e.Context.Ip), "ip");
        Assert.True(string.IsNullOrEmpty(e.Context.UserAgent), "user agent");
        AssertMaskedEmail(e.Actor!.Email);
    }

    /// <summary>The <c>actor_email</c> mask is exactly <c>masked:</c> and 24 lowercase hex digits, never the address.</summary>
    private static void AssertMaskedEmail(string? value)
    {
        Assert.NotNull(value);
        Assert.Equal(31, value!.Length);
        Assert.StartsWith("masked:", value, StringComparison.Ordinal);
        Assert.All(value.Substring(7), c => Assert.True(c is (>= '0' and <= '9') or (>= 'a' and <= 'f'), "masked email digit"));
    }

    private static JsonElement Parse(string line)
    {
        using var document = JsonDocument.Parse(line);
        return document.RootElement.Clone();
    }

    private static string? Text(JsonElement row, string objectName, string property)
        => row.TryGetProperty(objectName, out var inner) && inner.ValueKind == JsonValueKind.Object
            && inner.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
