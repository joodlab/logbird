using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Step-4 review, API shape: A12 (results are read-only, nested ones included) and A13 (drop fields).</summary>
public class Step4ApiShapeTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid");

    private const string StoredEventJson = """
        {"id":"evt_1","projectId":"prj_1","timestamp":"2026-11-22T08:00:00.123Z","receivedAt":"2026-11-22T08:00:01.000Z",
         "environment":"staging","action":"invoice.updated","category":"invoice","outcome":"success","severity":"info",
         "description":"","actor":{"type":"user","id":"u1","name":"Fictional","email":""},"impersonator":null,
         "executor":null,"tenant":{"id":"t1","name":""},"source":null,
         "targets":[{"type":"invoice","id":"inv_1","name":"INV-1"}],"changes":[{"field":"limit","before":"24","after":"48"}],
         "context":{"operationId":"op","parentEventId":"","requestId":"req","traceId":"","ip":"","userAgent":""},
         "attributes":{"metadata.plan":"pro"},"conformance":77.8,"schemaVersion":"","sdk":"dotnet/0.1.0"}
        """;

    private static FakeServer Server(Func<CapturedRequest, HttpResponseMessage> route)
        => new()
        {
            Fallback = request => Task.FromResult(request.Request.RequestUri!.AbsolutePath == "/openapi.json"
                ? FakeServer.Json(HttpStatusCode.OK, "{\"info\":{\"version\":\"0.2.0\"}}")
                : route(request)),
        };

    private static LogbirdReadClient Reader(FakeServer server)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));

    /// <summary>No interface leads to storage a caller could change: not a list or array, not IList or ICollection.</summary>
    private static void AssertReadOnly<T>(IReadOnlyList<T> list)
    {
        Assert.False(list is List<T>);
        Assert.False(list is T[]);
        Assert.False(list is IList<T>);
        Assert.False(list is ICollection<T>);
        Assert.False(list is IList);
        Assert.False(list is ICollection);
    }

    private static void AssertReadOnly(IReadOnlyDictionary<string, string> map)
    {
        Assert.False(map is Dictionary<string, string>);
        Assert.False(map is IDictionary<string, string>);
        Assert.False(map is ICollection<KeyValuePair<string, string>>);
        Assert.False(map is IDictionary);
        Assert.False(map is ICollection);
        Assert.False(map.Keys is ICollection<string>);
        Assert.False(map.Values is ICollection<string>);
    }

    // ---------------------------------------------------------------- A12: read-only results

    [Fact]
    public async Task A_search_page_and_every_event_on_it_are_read_only()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"data":[{{StoredEventJson}}],"nextCursor":null,"total":1,"tookMs":3.5}"""));
        using var reader = Reader(server);

        var page = await reader.SearchAsync();

        AssertReadOnly(page.Events);
        var e = Assert.Single(page.Events);
        AssertReadOnly(e.Targets);
        AssertReadOnly(e.Changes);
        AssertReadOnly(e.Attributes);
        Assert.Equal("pro", e.Attributes["metadata.plan"]);
        Assert.True(e.Attributes.TryGetValue("metadata.plan", out var plan) && plan == "pro");
        Assert.False(e.Attributes.ContainsKey("METADATA.PLAN"));
        Assert.Equal(["metadata.plan"], e.Attributes.Keys);
        Assert.Equal("inv_1", e.Targets[0].Id);
    }

    [Fact]
    public async Task An_event_detail_and_its_parents_are_read_only()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, $$"""{"event":{{StoredEventJson}},"payload":{"id":"evt_1"},"parents":[{{StoredEventJson}}],"childCount":0,"operationSize":1}"""));
        using var reader = Reader(server);

        var detail = await reader.GetEventAsync("evt_1");

        AssertReadOnly(detail!.Parents);
        AssertReadOnly(detail.Event.Targets);
        AssertReadOnly(detail.Parents[0].Changes);
        AssertReadOnly(detail.Parents[0].Attributes);
    }

    [Fact]
    public async Task Facet_values_and_their_groups_are_read_only()
    {
        var server = Server(_ => FakeServer.Json(HttpStatusCode.OK, """
            {"field":"action","by":"outcome","values":[{"value":"invoice.updated","label":"invoice.updated","count":3,
             "groups":[{"value":"success","label":"success","count":3}],"groupsOtherCount":0}],"otherCount":0}
            """));
        using var reader = Reader(server);

        var facets = await reader.FacetsAsync(new FacetQuery("action") { By = "outcome" });

        AssertReadOnly(facets.Values);
        AssertReadOnly(facets.Values[0].Groups!);
        Assert.Equal("success", facets.Values[0].Groups![0].Value);
    }

    [Fact]
    public void A_result_keeps_a_copy_of_what_it_was_given()
    {
        // Built in code, as a test double might: the list passed in can change afterwards; the result does not.
        var targets = new List<AuditTarget> { new("invoice", "inv_1") };
        var attributes = new Dictionary<string, string> { ["metadata.plan"] = "pro" };
        var stored = new StoredEvent { Targets = targets, Attributes = attributes };
        targets.Add(new AuditTarget("invoice", "inv_2"));
        attributes["metadata.plan"] = "free";

        Assert.Single(stored.Targets);
        Assert.Equal("pro", stored.Attributes["metadata.plan"]);
        AssertReadOnly(stored.Targets);
        AssertReadOnly(new StoredEvent().Changes);
        AssertReadOnly(new EventPage().Events);
    }

    [Fact]
    public void A_dictionary_built_in_code_keeps_its_comparer_and_any_other_is_ordinal()
    {
        var caseless = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Plan"] = "pro" };
        var stored = new StoredEvent { Attributes = caseless };
        Assert.Equal("pro", stored.Attributes["plan"]);
        AssertReadOnly(stored.Attributes);

        var empty = new StoredEvent { Attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) };
        Assert.Empty(empty.Attributes);
        AssertReadOnly(empty.Attributes);

        var other = new StoredEvent { Attributes = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(caseless) };
        Assert.True(other.Attributes.ContainsKey("Plan"));
        Assert.False(other.Attributes.ContainsKey("plan"));
    }

    [Fact]
    public void Rejection_codes_are_read_only()
    {
        var codes = new List<string> { "invalid_event", "duplicate_id_conflict" };
        var rejected = new LogbirdRejectedException(2, codes);
        codes.Clear();

        Assert.Equal(["invalid_event", "duplicate_id_conflict"], rejected.Codes);
        AssertReadOnly(rejected.Codes);
    }

    // ---------------------------------------------------------------- A13: drop fields

    private static LogbirdClient Client(Action<DroppedEvent> onDrop, FakeServer server)
        => new(
            new LogbirdOptions { Endpoint = Endpoint, IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1), OnDrop = onDrop },
            new HttpClient(server),
            logger: null,
            delay: (_, _) => Task.CompletedTask);

    [Fact]
    public async Task Two_long_ids_that_share_a_prefix_are_reported_apart_by_their_fingerprints()
    {
        // Ids the server refuses (over 256 code units) but must still correlate: before, both were cut to the same 256 with
        // nothing to tell them apart.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var first = new string('a', 300) + "-1";
        var second = new string('a', 300) + "-2";
        var server = new FakeServer().Then(request => FakeServer.Accept(request, (0, "invalid_event"), (1, "invalid_event")));
        await using (var client = Client(drops.Enqueue, server))
        {
            client.Track(new AuditEvent("invoice.updated") { Id = first });
            client.Track(new AuditEvent("invoice.updated") { Id = second });
            await client.FlushAsync();
        }

        Assert.Equal(2, drops.Count);
        Assert.All(drops, d =>
        {
            Assert.True(d.Truncated);
            Assert.Equal(new string('a', DroppedEvent.MaxIdLength), d.Id);
        });
        Assert.Equal(
            new[] { DroppedEvent.Fingerprint(first), DroppedEvent.Fingerprint(second) }.OrderBy(f => f, StringComparer.Ordinal),
            drops.Select(d => d.IdFingerprint!).OrderBy(f => f, StringComparer.Ordinal));
    }

    [Fact]
    public void Ids_the_server_accepts_once_trimmed_are_told_apart_even_with_empty_json()
    {
        // The reviewer's case: two valid ids padded far past the bound, dropped before serialization.
        var padding = new string(' ', 65_536);
        var a = new DroppedEvent(DropReason.TooLarge, padding + "A", "x", null, null);
        var b = new DroppedEvent(DropReason.TooLarge, padding + "B", "x", null, null);
        Assert.Equal(a.Id, b.Id);
        Assert.True(a.Json.IsEmpty && b.Json.IsEmpty);
        Assert.NotEqual(a.IdFingerprint, b.IdFingerprint);
        Assert.Equal(DroppedEvent.Fingerprint(padding + "A"), a.IdFingerprint);

        // An id within the bound is exactly as given, with no fingerprint.
        var whole = new DroppedEvent(DropReason.TooLarge, "evt_1", "x", null, null);
        Assert.Equal("evt_1", whole.Id);
        Assert.Null(whole.IdFingerprint);
        Assert.False(whole.Truncated);
    }

    [Fact]
    public void The_fingerprint_is_the_sha256_of_the_utf16_code_units()
    {
        Assert.Equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", DroppedEvent.Fingerprint(string.Empty));
        Assert.Equal("ffe9aaeaa2a2d5048174df0b80599ef0197ec024c4b051bc9860cff58ef7f9f3", DroppedEvent.Fingerprint("a"));

        // A lone surrogate counts exactly: never confused with U+FFFD.
        Assert.Equal("205022e3428b7c8276cf247b36e4e512db5651e5cb3472c253d9ee893a8ac750", DroppedEvent.Fingerprint(((char)0xD800).ToString()));
        Assert.Equal("15cc44da5e294721a0fc16c8fb952382d4dc51dbaa28950d9903acfbac0ccee5", DroppedEvent.Fingerprint("\uFFFD"));
        Assert.Throws<ArgumentNullException>(() => DroppedEvent.Fingerprint(null!));
    }

    [Fact]
    public async Task An_event_without_an_id_tracked_after_shutdown_is_reported_with_neither_id_nor_json()
    {
        // As DroppedEvent.Json documents: an event refused before Track assigns an id has neither.
        var drops = new ConcurrentQueue<DroppedEvent>();
        var client = Client(drops.Enqueue, new FakeServer());
        await client.DisposeAsync();
        client.Track(new AuditEvent("after.shutdown"));
        client.Track(new AuditEvent("after.shutdown") { Id = "evt_own" });
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (drops.Count < 2)
            {
                await Task.Delay(10);
            }
        });

        var withoutId = Assert.Single(drops, d => d.Id is null);
        Assert.Equal(DropReason.Shutdown, withoutId.Reason);
        Assert.True(withoutId.Json.IsEmpty);
        Assert.Equal("evt_own", Assert.Single(drops, d => d.Id is not null).Id);
    }

    [Fact]
    public void Fields_are_cut_only_past_their_limit_never_inside_a_surrogate_pair_and_the_cut_is_reported()
    {
        var whole = new DroppedEvent(DropReason.Invalid, new string('i', DroppedEvent.MaxIdLength), new string('a', DroppedEvent.MaxIdLength), null, new string('d', DroppedEvent.MaxDetailLength));
        Assert.False(whole.Truncated);
        Assert.Equal(DroppedEvent.MaxIdLength, whole.Id!.Length);
        Assert.Equal(DroppedEvent.MaxDetailLength, whole.Detail!.Length);

        // A pair straddling the limit is left out whole rather than split.
        var pair = "\U0001F600";
        var id = new string('i', DroppedEvent.MaxIdLength - 1) + pair;
        var cut = new DroppedEvent(DropReason.TooLarge, id, "x", null, null);
        Assert.True(cut.Truncated);
        Assert.Equal(DroppedEvent.MaxIdLength - 1, cut.Id!.Length);
        Assert.False(char.IsHighSurrogate(cut.Id[cut.Id.Length - 1]));

        var longAction = new DroppedEvent(DropReason.TooLarge, "evt_1", new string('a', DroppedEvent.MaxIdLength + 5), null, null);
        Assert.True(longAction.Truncated);
        Assert.Equal("evt_1", longAction.Id);
        Assert.Equal(DroppedEvent.MaxIdLength, longAction.Action.Length);

        var longDetail = new DroppedEvent(DropReason.Rejected, "evt_1", "x", null, new string('d', DroppedEvent.MaxDetailLength + 1));
        Assert.True(longDetail.Truncated);
        Assert.Equal(DroppedEvent.MaxDetailLength, longDetail.Detail!.Length);
    }
}
