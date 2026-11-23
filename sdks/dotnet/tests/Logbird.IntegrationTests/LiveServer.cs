using System;
using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.IntegrationTests;

/// <summary>
/// A real Logbird server, configured through environment variables:
/// <c>LOGBIRD_IT_ENDPOINT</c>, <c>LOGBIRD_IT_INGEST_KEY</c> and <c>LOGBIRD_IT_READ_KEY</c> (an isolated, fictional project).
/// Tests are skipped when they are not set.
/// </summary>
internal static class LiveServer
{
    public static readonly string? Endpoint = Environment.GetEnvironmentVariable("LOGBIRD_IT_ENDPOINT");
    public static readonly string? IngestKey = Environment.GetEnvironmentVariable("LOGBIRD_IT_INGEST_KEY");
    public static readonly string? ReadKey = Environment.GetEnvironmentVariable("LOGBIRD_IT_READ_KEY");

    public static bool Configured => !string.IsNullOrEmpty(Endpoint) && !string.IsNullOrEmpty(IngestKey) && !string.IsNullOrEmpty(ReadKey);

    public static LogbirdOptions Options(Action<LogbirdOptions>? configure = null)
    {
        var options = new LogbirdOptions
        {
            Endpoint = new Uri(Endpoint!),
            IngestKey = IngestKey,
            Environment = "integration",
            Source = "dotnet-sdk-tests",
        };
        configure?.Invoke(options);
        return options;
    }

    public static LogbirdReadClient Reader() => new(new LogbirdReadOptions { Endpoint = new Uri(Endpoint!), ReadKey = ReadKey });

    /// <summary>Reads an event, waiting briefly for storage to make it visible.</summary>
    public static async Task<EventDetail> WaitForEventAsync(LogbirdReadClient reader, string id)
    {
        var watch = Stopwatch.StartNew();
        while (true)
        {
            var detail = await reader.GetEventAsync(id);
            if (detail is not null)
            {
                return detail;
            }

            if (watch.Elapsed > TimeSpan.FromSeconds(30))
            {
                throw new TimeoutException($"Event {id} did not become readable.");
            }

            await Task.Delay(250);
        }
    }

    /// <summary>Counts every stored event matching a query, waiting until the count is stable.</summary>
    public static async Task<int> CountAsync(LogbirdReadClient reader, string query, int expected)
    {
        var watch = Stopwatch.StartNew();
        var count = 0;
        while (watch.Elapsed < TimeSpan.FromSeconds(60))
        {
            count = 0;
            await foreach (var _ in reader.SearchAllAsync(new EventSearch { Query = query, Limit = 200, From = DateTimeOffset.UtcNow.AddHours(-1) }))
            {
                count++;
            }

            if (count >= expected)
            {
                return count;
            }

            await Task.Delay(500);
        }

        return count;
    }

    /// <summary>The server's release version from its OpenAPI document.</summary>
    public static async Task<Version> ServerVersionAsync()
    {
        using var http = new HttpClient();
        using var document = JsonDocument.Parse(await http.GetStringAsync(new Uri(new Uri(Endpoint!), "/openapi.json")));
        // A pre-release or build suffix (0.2.1-rc.1, 0.2.0+abc) is ignored, as the read client's own version check does.
        var text = document.RootElement.GetProperty("info").GetProperty("version").GetString()!;
        var end = text.IndexOfAny(['-', '+']);
        return Version.Parse(end >= 0 ? text.Substring(0, end) : text);
    }
}

/// <summary>A fact that is skipped unless a live server is configured.</summary>
public sealed class LiveFactAttribute : FactAttribute
{
    public LiveFactAttribute(string? requires = null)
    {
        if (!LiveServer.Configured)
        {
            Skip = "Set LOGBIRD_IT_ENDPOINT, LOGBIRD_IT_INGEST_KEY and LOGBIRD_IT_READ_KEY to run against a real Logbird server.";
        }
        else if (requires is not null && Environment.GetEnvironmentVariable(requires) != "1")
        {
            Skip = $"Set {requires}=1 to run this check.";
        }
    }
}

/// <summary>
/// Turns the first successful responses into a 503 after the server has processed them, like a proxy timing out. Other
/// responses (a 429 from a rate limit, a 5xx) pass through unchanged and are counted separately, so a retry the server
/// itself caused is visible without being mistaken for a duplicate.
/// </summary>
internal sealed class FailAfterForwardingHandler(int failures) : DelegatingHandler(new HttpClientHandler())
{
    private int _remaining = failures;
    private int _accepted;
    private int _other;

    /// <summary>Requests the server accepted (2xx), including the ones turned into a 503.</summary>
    public int Forwarded => Volatile.Read(ref _accepted);

    /// <summary>Requests the server answered with anything else (passed through unchanged).</summary>
    public int OtherResponses => Volatile.Read(ref _other);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            Interlocked.Increment(ref _other);
            return response;
        }

        Interlocked.Increment(ref _accepted);
        if (Interlocked.Decrement(ref _remaining) >= 0)
        {
            response.Dispose();
            return new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent("{\"error\":{\"code\":\"proxy_timeout\",\"message\":\"fictional\"}}"),
            };
        }

        return response;
    }
}
