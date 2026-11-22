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

    /// <summary>
    /// The most pages one <c>SearchAllAsync</c> iteration requests before it stops with <c>page_limit</c> (when more
    /// remain). Unlimited by default; set it to bound an iteration against a server that misbehaves.
    /// </summary>
    public int? MaxPages { get; set; }
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
    private readonly string _openApiUrl;
    private Task<Version?>? _serverVersion;
    private readonly AuthenticationHeaderValue _authorization;
    private readonly TimeSpan _timeout;
    private readonly int? _maxPages;

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

        if (options.MaxPages is < 1)
        {
            throw new ArgumentException("MaxPages must be at least 1.", nameof(options));
        }

        _maxPages = options.MaxPages;
        if (options.Timeout <= TimeSpan.Zero || options.Timeout > TimeSpan.FromMilliseconds(int.MaxValue))
        {
            throw new ArgumentException("Timeout must be positive and at most 24 days.", nameof(options));
        }

        _eventsUrl = Endpoints.Append(endpoint, "/v1/events").AbsoluteUri;
        _openApiUrl = Endpoints.Append(endpoint, "/openapi.json").AbsoluteUri;
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
    /// <exception cref="LogbirdApiException">
    /// Also when the search needs a newer server than the one answering (<c>server_too_old</c>, or
    /// <c>server_version_unknown</c> when its version cannot be read): such a search is never sent.
    /// </exception>
    public async Task<EventPage> SearchAsync(EventSearch? search = null, CancellationToken cancellationToken = default)
    {
        search ??= new EventSearch();
        await EnsureServerSupportsAsync(search, cancellationToken).ConfigureAwait(false);
        return (await GetAsync(_eventsUrl + search.ToQueryString(), ReadJsonContext.Default.EventPage, cancellationToken).ConfigureAwait(false))!;
    }

    /// <summary>
    /// A trail that needs Logbird 0.2.0 (see <see cref="EventSearch.ForTrail(string, string, string, string, DateTimeOffset?, DateTimeOffset?, int?, string, string)"/>)
    /// is only sent to a server that reports 0.2.0 or later; an older server would run a different search. The version is
    /// read once from the server's public OpenAPI document (without the read key) and kept; a failed read is not kept.
    /// </summary>
    private async Task EnsureServerSupportsAsync(EventSearch search, CancellationToken cancellationToken)
    {
        if (!search.NeedsServer020)
        {
            return;
        }

        var pending = Volatile.Read(ref _serverVersion);
        if (pending is null)
        {
            var created = ReadServerVersionAsync(cancellationToken);
            pending = Interlocked.CompareExchange(ref _serverVersion, created, null) ?? created;
        }

        Version? version;
        try
        {
            version = await pending.ConfigureAwait(false);
        }
        catch
        {
            _ = Interlocked.CompareExchange(ref _serverVersion, null, pending);
            throw;
        }

        if (version is null)
        {
            _ = Interlocked.CompareExchange(ref _serverVersion, null, pending);
            throw new LogbirdApiException(null, "server_version_unknown", "This trail needs Logbird 0.2.0 or later, and the server's version could not be read; it was not sent.");
        }

        if (version < new Version(0, 2, 0))
        {
            throw new LogbirdApiException(null, "server_too_old", "This trail needs Logbird 0.2.0 or later (record: and literal * or carriage returns); the server reports " + version + ", so it was not sent.");
        }
    }

    private async Task<Version?> ReadServerVersionAsync(CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_timeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, _openApiUrl);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        HttpResponseMessage? response = null;
        byte[] body;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            body = await Internal.BatchSender.ReadBodyAsync(response, MaxResponseBytes, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            response?.Dispose();
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException or System.IO.InvalidDataException)
        {
            response?.Dispose();
            throw new LogbirdApiException(null, "unreachable", "Logbird could not be reached to read its version: " + e.GetType().Name);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            try
            {
                using var document = JsonDocument.Parse(body);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("info", out var info) && info.ValueKind == JsonValueKind.Object
                    && info.TryGetProperty("version", out var versionElement) && versionElement.ValueKind == JsonValueKind.String)
                {
                    // A pre-release or build suffix (0.2.0-rc.1, 0.2.0+abc) is ignored: only the numbers are compared.
                    var text = versionElement.GetString()!;
                    var end = text.IndexOfAny(['-', '+']);
                    return Version.TryParse(end >= 0 ? text.Substring(0, end) : text, out var parsed) ? parsed : null;
                }
            }
            catch (JsonException)
            {
            }

            return null;
        }
    }

    /// <summary>
    /// Iterates every matching event, requesting further pages as you go. Logbird's cursors are keyset-ordered and do not
    /// repeat; as a guard against a misbehaving server, the iteration stops with <see cref="LogbirdApiException"/>
    /// (<c>pagination_stalled</c>) if a cursor repeats within the last 1,000 pages, and after
    /// <see cref="LogbirdReadOptions.MaxPages"/> pages (<c>page_limit</c>) when that limit is set and more pages remain.
    /// </summary>
    /// <param name="search">The search. Its <see cref="EventSearch.Cursor"/> is the starting point.</param>
    /// <param name="cancellationToken">Cancels the iteration.</param>
    /// <exception cref="LogbirdApiException">The server answered an error, could not be reached, or the page limit was reached.</exception>
    public async IAsyncEnumerable<StoredEvent> SearchAllAsync(EventSearch? search = null, [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await EnsureServerSupportsAsync(search ?? new EventSearch(), cancellationToken).ConfigureAwait(false);
        var maxPages = _maxPages;
        var pages = 0;
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
            pages++;

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

            if (pages >= maxPages)
            {
                throw new LogbirdApiException(null, "page_limit", "The page limit was reached before the last page; the results are incomplete.");
            }

            current = current with { Cursor = next };
        }
    }

    /// <summary>How many recent cursors <c>SearchAllAsync</c> remembers to detect a stalled pagination.</summary>
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
        HttpResponseMessage? response = null;
        byte[] body;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
            body = await Internal.BatchSender.ReadBodyAsync(response, MaxResponseBytes, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            response?.Dispose();
            throw;
        }
        catch (System.IO.InvalidDataException)
        {
            var status = response?.StatusCode;
            response?.Dispose();
            throw new LogbirdApiException(status, "response_too_large", "The Logbird response was larger than the read client accepts.");
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException)
        {
            response?.Dispose();
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

    // The code is kept on its own property (never in the message), and only if it looks like a code.
    private static string CodeShaped(string code)
    {
        if (code.Length is 0 or > 64 || code[0] is < 'a' or > 'z')
        {
            return "other";
        }

        foreach (var c in code)
        {
            if (c is not ((>= 'a' and <= 'z') or (>= '0' and <= '9') or '_'))
            {
                return "other";
            }
        }

        return code;
    }

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
                    code = CodeShaped(codeElement.GetString() ?? string.Empty);
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

        // The message names only the HTTP status; the server's code and text stay on their own properties.
        return new LogbirdApiException(status, code, $"Logbird read failed with HTTP {(int)status}.") { ServerMessage = serverMessage };
    }
}
