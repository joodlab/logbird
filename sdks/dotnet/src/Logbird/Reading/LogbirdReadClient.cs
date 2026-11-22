using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using System.Threading;
using System.Threading.Tasks;
using Logbird.Internal;

namespace Logbird;

/// <summary>Settings for <see cref="LogbirdReadClient"/>.</summary>
public sealed class LogbirdReadOptions
{
    /// <summary>Your Logbird public origin, for example <c>https://audit.example.com</c>.</summary>
    public Uri? Endpoint { get; set; }

    /// <summary>
    /// Allows a plain <c>http</c> endpoint on a non-loopback host. Off by default, because every request carries the
    /// read key, which can read the whole project.
    /// </summary>
    public bool AllowInsecureHttp { get; set; }

    /// <summary>A project read key (<c>lb_read_…</c>). Server-side only: never send it to a browser.</summary>
    public string? ReadKey { get; set; }

    /// <summary>The time limit for one request. Defaults to 30 seconds.</summary>
    public TimeSpan Timeout { get; set; } = TimeSpan.FromSeconds(30);
}

/// <summary>
/// Reads stored events through the public API (<c>GET /v1/events</c> and <c>GET /v1/events/{id}</c>). Unlike
/// recording, reading reports failures by throwing <see cref="LogbirdApiException"/>, because the caller needs the data.
/// </summary>
/// <remarks>
/// A read key can read the whole project. When you show history to your own customers, check that the signed-in user
/// may see the tenant or record before you search, on every request including next-page requests.
/// </remarks>
public sealed class LogbirdReadClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _eventsUrl;
    private readonly AuthenticationHeaderValue _authorization;
    private readonly TimeSpan _timeout;

    /// <summary>The largest response read (200 events with their attributes fit easily); a larger one fails the read.</summary>
    internal const int MaxResponseBytes = 64 * 1024 * 1024;

    /// <summary>Creates a read client.</summary>
    /// <param name="options">The endpoint and read key.</param>
    /// <param name="httpClient">An <see cref="HttpClient"/> to use, for example from <c>IHttpClientFactory</c>. Not disposed by this client.</param>
    /// <exception cref="ArgumentException">The endpoint or key is missing, or the endpoint is not https (see <see cref="LogbirdReadOptions.AllowInsecureHttp"/>).</exception>
    public LogbirdReadClient(LogbirdReadOptions options, HttpClient? httpClient = null)
    {
        Guard.NotNull(options, nameof(options));
        Endpoints.Validate(options.Endpoint, options.AllowInsecureHttp, nameof(options));
        var endpoint = options.Endpoint!;

        if (string.IsNullOrWhiteSpace(options.ReadKey))
        {
            throw new ArgumentException("ReadKey is required.", nameof(options));
        }

        if (options.Timeout <= TimeSpan.Zero || options.Timeout > TimeSpan.FromMilliseconds(int.MaxValue))
        {
            throw new ArgumentException("Timeout must be positive and at most 24 days.", nameof(options));
        }

        _eventsUrl = Endpoints.Append(endpoint, "/v1/events").AbsoluteUri;
        _authorization = new AuthenticationHeaderValue("Bearer", options.ReadKey);
        _timeout = options.Timeout;
        _ownsHttp = httpClient is null;
        // An owned client never follows redirects: a redirect could carry the read key's results to another origin.
        _http = httpClient ?? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = System.Threading.Timeout.InfiniteTimeSpan };
    }

    /// <summary>Searches stored events and returns one page.</summary>
    /// <param name="search">The search; <see langword="null"/> returns the newest events in the default range.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <exception cref="LogbirdApiException">The server answered an error, or could not be reached.</exception>
    public Task<EventPage> SearchAsync(EventSearch? search = null, CancellationToken cancellationToken = default)
        => GetAsync(_eventsUrl + (search ?? new EventSearch()).ToQueryString(), ReadJsonContext.Default.EventPage, cancellationToken)!;

    /// <summary>Iterates every matching event, requesting further pages as you go.</summary>
    /// <param name="search">The search. Its <see cref="EventSearch.Cursor"/> is the starting point.</param>
    /// <param name="cancellationToken">Cancels the iteration.</param>
    /// <exception cref="LogbirdApiException">The server answered an error, or could not be reached.</exception>
    public async IAsyncEnumerable<StoredEvent> SearchAllAsync(EventSearch? search = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var current = search ?? new EventSearch();
        // A bounded window of recent cursors catches repeats and short cycles without growing with the result set.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var order = new Queue<string>();
        if (!string.IsNullOrEmpty(current.Cursor))
        {
            seen.Add(current.Cursor!);
            order.Enqueue(current.Cursor!);
        }

        while (true)
        {
            var page = await SearchAsync(current, cancellationToken).ConfigureAwait(false);

            // Check the next cursor before yielding, so a cursor cycle never yields the same page twice.
            var next = page.NextCursor;
            if (!string.IsNullOrEmpty(next))
            {
                if (!seen.Add(next!))
                {
                    throw new LogbirdApiException(null, "pagination_stalled", "Logbird returned a cursor it had already returned; the results are incomplete.");
                }

                order.Enqueue(next!);
                if (order.Count > CursorHistory)
                {
                    seen.Remove(order.Dequeue());
                }
            }

            foreach (var item in page.Events)
            {
                yield return item;
            }

            if (string.IsNullOrEmpty(next))
            {
                yield break;
            }

            current = current with { Cursor = next };
        }
    }

    /// <summary>How many recent cursors <see cref="SearchAllAsync"/> remembers to detect a stalled pagination.</summary>
    internal const int CursorHistory = 1_000;

    /// <summary>Gets one event with its raw payload and causation chain, or <see langword="null"/> when it does not exist.</summary>
    /// <param name="eventId">The event id.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <exception cref="LogbirdApiException">The server answered an error other than 404, or could not be reached.</exception>
    public Task<EventDetail?> GetAsync(string eventId, CancellationToken cancellationToken = default)
    {
        Guard.NotBlank(eventId, nameof(eventId));
        if (eventId is "." or "..")
        {
            // URL normalization would turn these into a different route.
            throw new ArgumentException("Event ids \".\" and \"..\" cannot be addressed by URL; search with id:\".\" instead.", nameof(eventId));
        }
        return GetAsync(_eventsUrl + "/" + Uri.EscapeDataString(eventId), ReadJsonContext.Default.EventDetail, cancellationToken, notFoundIsNull: true);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (_ownsHttp)
        {
            _http.Dispose();
        }
    }

    private async Task<T?> GetAsync<T>(string url, JsonTypeInfo<T> type, CancellationToken cancellationToken, bool notFoundIsNull = false)
        where T : class
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_timeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = _authorization;
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        HttpResponseMessage response;
        byte[] body;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            body = response.Content is null ? [] : await Internal.BatchSender.ReadCappedAsync(response.Content, MaxResponseBytes, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException)
        {
            throw new LogbirdApiException(null, "unreachable", "Logbird could not be reached: " + e.GetType().Name);
        }

        using (response)
        {
            if (notFoundIsNull && response.StatusCode == HttpStatusCode.NotFound)
            {
                return null;
            }

            if (!response.IsSuccessStatusCode)
            {
                throw LogbirdApiException.FromResponse(response.StatusCode, body);
            }

            try
            {
                return JsonSerializer.Deserialize(body, type)
                    ?? throw new LogbirdApiException(response.StatusCode, "invalid_response", "Logbird returned an empty response.");
            }
            catch (JsonException e)
            {
                throw new LogbirdApiException(response.StatusCode, "invalid_response", "Logbird returned a response this SDK cannot read: " + e.GetType().Name);
            }
        }
    }
}

/// <summary>A read request failed.</summary>
public sealed class LogbirdApiException : Exception
{
    /// <summary>Creates the exception.</summary>
    /// <param name="statusCode">The HTTP status, when the server answered.</param>
    /// <param name="code">The Logbird error code, for example <c>unauthorized</c> or <c>rate_limited</c>.</param>
    /// <param name="message">The error message.</param>
    /// <param name="innerException">The underlying error.</param>
    public LogbirdApiException(HttpStatusCode? statusCode, string code, string message, Exception? innerException = null)
        : base(message, innerException)
    {
        StatusCode = statusCode;
        Code = code;
    }

    /// <summary>
    /// The server's own error message, if it sent one. Kept out of <see cref="Exception.Message"/> because it is response
    /// text; log it only if your policy allows.
    /// </summary>
    public string? ServerMessage { get; private init; }

    /// <summary>The HTTP status, or <see langword="null"/> when the server could not be reached.</summary>
    public HttpStatusCode? StatusCode { get; }

    /// <summary>The Logbird error code.</summary>
    public string Code { get; }

    internal static LogbirdApiException FromResponse(HttpStatusCode status, byte[] body)
    {
        var code = "http_" + ((int)status).ToString(System.Globalization.CultureInfo.InvariantCulture);
        string? serverMessage = null;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("error", out var error)
                && error.ValueKind == JsonValueKind.Object)
            {
                if (error.TryGetProperty("code", out var codeElement) && codeElement.ValueKind == JsonValueKind.String)
                {
                    code = Internal.BatchSender.SafeCode(codeElement.GetString() ?? string.Empty);
                }

                if (error.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String)
                {
                    serverMessage = messageElement.GetString();
                }
            }
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            // Not a Logbird error body (for example a proxy page): keep the generic message.
        }

        return new LogbirdApiException(status, code, $"Logbird read failed with HTTP {(int)status} ({code}).") { ServerMessage = serverMessage };
    }
}
