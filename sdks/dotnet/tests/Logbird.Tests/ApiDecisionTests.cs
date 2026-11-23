using System;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>The maintainer's public-API decisions before publication (step 4 of the gate).</summary>
public class ApiDecisionTests
{
    [Fact]
    public void Stats_have_no_public_constructor_and_default_is_every_count_zero()
    {
        // Only the SDK fills a snapshot, so adding a counter later never changes a public constructor or Deconstruct.
        Assert.Empty(typeof(LogbirdStats).GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        Assert.Null(typeof(LogbirdStats).GetMethod("Deconstruct"));
        Assert.All(typeof(LogbirdStats).GetProperties(), p => Assert.Null(p.SetMethod));

        var empty = default(LogbirdStats);
        Assert.Equal(0, empty.Tracked + empty.Delivered + empty.Rejected + empty.Dropped + empty.Filtered + empty.FailedSends + empty.QueueLength + empty.Warnings);
    }

    [Fact]
    public async Task The_documented_test_double_is_indistinguishable_from_a_real_snapshot_with_no_counts()
    {
        // A client that has counted nothing returns a snapshot equal to default(LogbirdStats), with the same text.
        await using var client = new LogbirdClient(
            new LogbirdOptions { Endpoint = new Uri("https://audit.example.invalid/"), IngestKey = "lb_ingest_fictional", FlushInterval = TimeSpan.FromHours(1) },
            new System.Net.Http.HttpClient(new FakeServer()));
        var real = client.Stats;
        Assert.Equal(default(LogbirdStats), real);
        Assert.True(default(LogbirdStats).Equals(real));
        Assert.Equal(default(LogbirdStats).GetHashCode(), real.GetHashCode());
        Assert.Equal(default(LogbirdStats).ToString(), real.ToString());
        Assert.Equal(default(LogbirdStats), new LogbirdStats(0, 0, 0, 0, 0, 0, 0, 0));
    }

    [Fact]
    public void Stats_print_their_counts()
        => Assert.Equal(
            "LogbirdStats { Tracked = 5, Delivered = 3, Rejected = 1, Dropped = 1, Filtered = 0, FailedSends = 2, QueueLength = 4, Warnings = 7 }",
            new LogbirdStats(5, 3, 1, 1, 0, 2, 4, 7).ToString());

    [Fact]
    public void The_read_client_gets_an_event_by_a_name_that_says_so()
    {
        Assert.NotNull(typeof(LogbirdReadClient).GetMethod("GetEventAsync", [typeof(string), typeof(System.Threading.CancellationToken)]));
        Assert.DoesNotContain(typeof(LogbirdReadClient).GetMethods(BindingFlags.Public | BindingFlags.Instance), m => m.Name == "GetAsync");
    }
}
