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

    /// <summary>
    /// A project read key (<c>lb_read_…</c>, unscoped or scoped), or a viewer token (<c>lbv1.…</c>) from
    /// <see cref="LogbirdReadClient.MintViewerTokenAsync"/>. Keep read keys on servers: never send one to a browser.
    /// </summary>
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
    private readonly string _viewerTokensUrl;
    private readonly string _facetsUrl;
    private readonly string _exportUrl;
    private Lazy<Task<ServerVersion?>>? _serverVersion;
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
        _viewerTokensUrl = Endpoints.Append(endpoint, "/v1/viewer-tokens").AbsoluteUri;
        _facetsUrl = Endpoints.Append(endpoint, "/v1/facets").AbsoluteUri;
        _exportUrl = Endpoints.Append(endpoint, "/v1/export").AbsoluteUri;
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
    /// read from the server's public OpenAPI document (without the read key) and kept once it is 0.2.0 or later; a failed
    /// read, an unreadable version or an older version is not kept, so a server upgraded meanwhile is seen on the next call.
    /// </summary>
    private Task EnsureServerSupportsAsync(EventSearch search, CancellationToken cancellationToken)
        => search.NeedsServer020
            ? RequireServer020Async("This trail (record:, or a literal * or carriage return)", cancellationToken)
            : Task.CompletedTask;

    /// <summary>Fails (without sending anything) unless the server reports Logbird 0.2.0 or later.</summary>
    private async Task RequireServer020Async(string what, CancellationToken cancellationToken)
    {
        // One probe for all callers: created once, started once, and not tied to any caller's token (each caller waits under
        // its own, so cancelling one search never fails another). A probe that fails, finds no readable version, or finds a
        // version older than 0.2.0 forgets itself when it completes, even if no caller is still waiting, so the next call
        // asks again (a long-lived client sees a server upgraded after its first call).
        var probe = Volatile.Read(ref _serverVersion);
        if (probe is null)
        {
            Lazy<Task<ServerVersion?>>? created = null;
            created = new Lazy<Task<ServerVersion?>>(() => ProbeAsync(created!), LazyThreadSafetyMode.ExecutionAndPublication);
            probe = Interlocked.CompareExchange(ref _serverVersion, created, null) ?? created;
        }

        var version = await WaitAsync(probe.Value, cancellationToken).ConfigureAwait(false);
        if (version is null)
        {
            throw new LogbirdApiException(null, "server_version_unknown", what + " needs Logbird 0.2.0 or later, and the server's version could not be read; nothing was sent.");
        }

        if (!version.Value.AtLeast(MinimumServer))
        {
            throw new LogbirdApiException(null, "server_too_old", what + " needs Logbird 0.2.0 or later; the server reports " + version.Value + ", so nothing was sent.");
        }
    }

    /// <summary>The oldest Logbird the version-gated calls are sent to.</summary>
    private static readonly Version MinimumServer = new(0, 2, 0);

    /// <summary>
    /// Runs one version read; a failed or unreadable read, or a version older than <see cref="MinimumServer"/>, removes this
    /// probe (and only this one) from the cache. Only a version that allows the calls is kept.
    /// </summary>
    private async Task<ServerVersion?> ProbeAsync(Lazy<Task<ServerVersion?>> self)
    {
        try
        {
            var version = await ReadServerVersionAsync().ConfigureAwait(false);
            if (version is null || !version.Value.AtLeast(MinimumServer))
            {
                _ = Interlocked.CompareExchange(ref _serverVersion, null, self);
            }

            return version;
        }
        catch
        {
            _ = Interlocked.CompareExchange(ref _serverVersion, null, self);
            throw;
        }
    }

    private static async Task<T> WaitAsync<T>(Task<T> task, CancellationToken cancellationToken)
    {
        if (!cancellationToken.CanBeCanceled || task.IsCompleted)
        {
            return await task.ConfigureAwait(false);
        }

        var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using (cancellationToken.Register(() => cancelled.TrySetResult(true)))
        {
            if (await Task.WhenAny(task, cancelled.Task).ConfigureAwait(false) != task)
            {
                throw new OperationCanceledException(cancellationToken);
            }
        }

        return await task.ConfigureAwait(false);
    }

    private async Task<ServerVersion?> ReadServerVersionAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, _openApiUrl);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        HttpResponseMessage response;
        byte[] body;
        try
        {
            (response, body) = await SendBoundedAsync(request, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException or System.IO.InvalidDataException or TimeoutException or TooLargeResponseException)
        {
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
                    // Build metadata (0.2.0+abc) is ignored; a pre-release (0.2.0-rc.1) comes before its release, as in SemVer.
                    var text = versionElement.GetString()!;
                    var build = text.IndexOf('+');
                    text = build >= 0 ? text.Substring(0, build) : text;
                    var dash = text.IndexOf('-');
                    return Version.TryParse(dash >= 0 ? text.Substring(0, dash) : text, out var parsed) ? new ServerVersion(parsed, dash >= 0) : null;
                }
            }
            catch (Exception e) when (e is JsonException or InvalidOperationException)
            {
                // InvalidOperationException: the version string escapes a lone surrogate, which .NET cannot decode.
            }

            return null;
        }
    }

    /// <summary>
    /// Mints a short-lived viewer token for one scope, for example to give a browser read access to one customer's audit
    /// trail. Call it with an unscoped <c>read</c> key (or a scoped read key whose scope contains <paramref name="scope"/>);
    /// a viewer token cannot mint another. Logbird 0.2.0 and later.
    /// </summary>
    /// <param name="scope">What the token may read. Checked locally before sending (see <see cref="ViewerScope"/>).</param>
    /// <param name="lifetime">How long the token works, 60 seconds to 1 hour; the server default (15 minutes) when null.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <exception cref="ArgumentException">The scope or lifetime is invalid.</exception>
    /// <exception cref="LogbirdApiException">
    /// The server refused (for example <c>scope_exceeded</c> when the scope is wider than the key's), could not be reached,
    /// is older than 0.2.0, or granted a scope different from the one requested (<c>scope_mismatch</c>; the token is not
    /// returned).
    /// </exception>
    public async Task<ViewerToken> MintViewerTokenAsync(ViewerScope scope, TimeSpan? lifetime = null, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(scope, nameof(scope));

        // One snapshot is validated, sent and compared with the grant, so a caller changing its list meanwhile changes nothing.
        var requested = scope.Snapshot();
        requested.Validate();
        int? ttlSeconds = null;
        if (lifetime is { } span)
        {
            if (span < TimeSpan.FromSeconds(60) || span > TimeSpan.FromHours(1))
            {
                throw new ArgumentException("A viewer token lives 60 seconds to 1 hour.", nameof(lifetime));
            }

            ttlSeconds = (int)span.TotalSeconds;
        }

        await RequireServer020Async("Minting a viewer token", cancellationToken).ConfigureAwait(false);
        var request = new System.Text.Json.Nodes.JsonObject { ["scope"] = requested.ToJson() };
        if (ttlSeconds is { } ttl)
        {
            request["ttlSeconds"] = ttl;
        }

        using var content = new ByteArrayContent(JsJson.ToUtf8(request));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        var response = await SendAsync(HttpMethod.Post, _viewerTokensUrl, content, ScopedJsonContext.Default.MintViewerTokenResponse, cancellationToken).ConfigureAwait(false);
        if (response?.Token is not { Length: > 0 } token || response.Scope is null
            || !DateTimeOffset.TryParse(response.ExpiresAt, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var expiresAt))
        {
            throw new LogbirdApiException(null, "invalid_response", "Logbird returned a viewer token response this SDK cannot read.");
        }

        var granted = ViewerScope.FromWire(response.Scope);
        if (!granted.SameAccessAs(requested))
        {
            throw new LogbirdApiException(null, "scope_mismatch", "Logbird granted a different scope than requested; the token was not returned.");
        }

        // The token itself carries its scope and expiry; check them too, so a response that pairs the requested scope with
        // another credential (a read key, or a token for another scope) is never handed out as this grant.
        if (ReadTokenPayload(token) is not { } payload || payload.V != 1 || payload.S is null || payload.Exp is not { } exp)
        {
            throw new LogbirdApiException(null, "invalid_response", "Logbird returned a credential that is not a viewer token; it was not returned.");
        }

        if (!ViewerScope.FromWire(payload.S).SameAccessAs(requested) || exp < -62135596800L || exp > 253402300799L || DateTimeOffset.FromUnixTimeSeconds(exp) != expiresAt)
        {
            throw new LogbirdApiException(null, "scope_mismatch", "The viewer token's own scope or expiry differs from the grant; the token was not returned.");
        }

        return new ViewerToken(token, expiresAt, granted);
    }

    /// <summary>The payload of a <c>lbv1.&lt;base64url payload&gt;.&lt;mac&gt;</c> token, or null when it has another shape.</summary>
    private static ViewerTokenPayloadWire? ReadTokenPayload(string token)
    {
        // Exactly the server's shape: unpadded base64url throughout, and a MAC of 32 bytes (HMAC-SHA256, 43 characters).
        var parts = token.Split('.');
        if (parts.Length != 3 || parts[0] != "lbv1" || !IsBase64Url(parts[1]) || parts[2].Length != 43 || !IsBase64Url(parts[2]))
        {
            return null;
        }

        var base64 = parts[1].Replace('-', '+').Replace('_', '/');
        base64 += new string('=', (4 - (base64.Length % 4)) % 4);
        try
        {
            return JsonSerializer.Deserialize(Convert.FromBase64String(base64), ScopedJsonContext.Default.ViewerTokenPayloadWire);
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Unpadded base64url: only A–Z, a–z, 0–9, '-' and '_', and a length no encoding produces (4n + 1) is refused.</summary>
    private static bool IsBase64Url(string text)
    {
        if (text.Length == 0 || text.Length % 4 == 1)
        {
            return false;
        }

        foreach (var c in text)
        {
            if (c is not ((>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '_'))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Counts in-range events by the values of a field, optionally split by a second field. With a viewer token or scoped
    /// key, only events in its scope are counted. Logbird 0.2.0 and later.
    /// </summary>
    /// <param name="query">The field, optional second field, query and range.</param>
    /// <param name="cancellationToken">Cancels the request.</param>
    /// <exception cref="ArgumentException">The facet request is invalid.</exception>
    /// <exception cref="LogbirdApiException">The server refused, could not be reached, or is older than 0.2.0.</exception>
    public async Task<FacetResult> FacetsAsync(FacetQuery query, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(query, nameof(query));
        var url = _facetsUrl + query.ToQueryString();
        await RequireServer020Async("A facet request", cancellationToken).ConfigureAwait(false);
        return (await GetAsync(url, ScopedJsonContext.Default.FacetResult, cancellationToken).ConfigureAwait(false))!;
    }

    /// <summary>
    /// Streams every matching event in the range into <paramref name="destination"/> in one format, and returns the number
    /// of bytes written. With a viewer token or scoped key, only events in its scope are exported. The client's
    /// <see cref="LogbirdReadOptions.Timeout"/> applies until the server starts answering; the download itself runs until
    /// it ends or <paramref name="cancellationToken"/> is cancelled, so pass a token to bound a large export.
    /// Logbird 0.2.0 and later.
    /// </summary>
    /// <param name="query">The format, query and range.</param>
    /// <param name="destination">Where to write the file. Not disposed.</param>
    /// <param name="cancellationToken">Cancels the export.</param>
    /// <exception cref="LogbirdApiException">
    /// The server refused (for example <c>masked_export</c> for an evidence export of a masked scope), could not be
    /// reached, or is older than 0.2.0. If the download fails part way, <paramref name="destination"/> holds a partial file.
    /// </exception>
    public async Task<long> ExportAsync(ExportQuery query, System.IO.Stream destination, CancellationToken cancellationToken = default)
    {
        Guard.NotNull(query, nameof(query));
        Guard.NotNull(destination, nameof(destination));
        var url = _exportUrl + query.ToQueryString();
        await RequireServer020Async("An export", cancellationToken).ConfigureAwait(false);
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = _authorization;
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        HttpResponseMessage response;
        try
        {
            // The read timeout bounds the wait for the headers, even with a handler that ignores cancellation.
            response = await BoundedAsync(
                async transport =>
                {
                    var answer = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, transport).ConfigureAwait(false);
                    if (transport.IsCancellationRequested)
                    {
                        answer.Dispose();
                        transport.ThrowIfCancellationRequested();
                    }

                    return answer;
                },
                static late => late.Dispose(),
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException or System.IO.InvalidDataException or TimeoutException)
        {
            throw new LogbirdApiException(null, "unreachable", "Logbird could not be reached: " + e.GetType().Name);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                byte[] error;
                try
                {
                    error = await Internal.BatchSender.ReadBodyAsync(response, 64 * 1024, cancellationToken).ConfigureAwait(false);
                }
                catch (Exception e) when (e is System.IO.InvalidDataException or System.IO.IOException or HttpRequestException)
                {
                    error = [];
                }

                throw LogbirdApiException.FromResponse(response.StatusCode, error);
            }

            // Cancelling disposes the response, which ends a body read the stream itself would not cancel (as on
            // .NET Framework), so the caller's token always ends a stalled download.
            using var abort = cancellationToken.Register(static state => ((HttpResponseMessage)state!).Dispose(), response);
            try
            {
                if (response.Content is null)
                {
                    return 0;
                }

#if NET
                var source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
#else
                var source = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
#endif
                using (source)
                {
                    var buffer = new byte[81920];
                    long total = 0;
                    int read;
#if NET
                    while ((read = await source.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false)) > 0)
                    {
                        await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
#else
                    while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellationToken).ConfigureAwait(false)) > 0)
                    {
                        await destination.WriteAsync(buffer, 0, read, cancellationToken).ConfigureAwait(false);
#endif
                        total += read;
                    }

                    // Cancelling disposes the response, and some streams then report a clean end: a download cut short by
                    // cancellation must never be reported as complete.
                    cancellationToken.ThrowIfCancellationRequested();
                    return total;
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception e) when (cancellationToken.IsCancellationRequested && e is HttpRequestException or System.IO.IOException or ObjectDisposedException)
            {
                // The read failed because cancelling disposed the response: report the cancellation, not a network fault.
                throw new OperationCanceledException("The export was cancelled.", e, cancellationToken);
            }
            catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException)
            {
                throw new LogbirdApiException(response.StatusCode, "unreachable", "The export download failed part way: " + e.GetType().Name);
            }
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

    private Task<T?> GetAsync<T>(string url, JsonTypeInfo<T> type, CancellationToken cancellationToken, bool notFoundIsNull = false)
        where T : class
        => SendAsync(HttpMethod.Get, url, null, type, cancellationToken, notFoundIsNull);

    /// <summary>
    /// Sends a request and reads its body within <see cref="LogbirdReadOptions.Timeout"/>, even when a custom handler
    /// ignores cancellation (as the ingest path does). The response is owned from the moment it arrives, so a failed or
    /// abandoned body read still disposes it.
    /// </summary>
    private Task<(HttpResponseMessage Response, byte[] Body)> SendBoundedAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        => BoundedAsync(transport => SendAndReadAsync(request, transport), static late => late.Response.Dispose(), cancellationToken);

    /// <summary>
    /// Runs <paramref name="send"/> until it finishes, the read timeout passes (<see cref="TimeoutException"/>) or
    /// <paramref name="cancellationToken"/> is cancelled (<see cref="OperationCanceledException"/>), whichever comes first.
    /// </summary>
    /// <remarks>
    /// The timeout and the caller's token only complete a signal of this method's own, so no callback another component
    /// registered on the transport token can delay the outcome. The transport gets a token source of its own, cancelled
    /// on the thread pool once the attempt is abandoned and never linked to the caller's token, so nothing stays
    /// registered on a long-lived caller token after this method returns. Once the timeout or the caller wins, that
    /// outcome stands: whatever the abandoned attempt produces later is passed to <paramref name="discard"/> unread.
    /// </remarks>
    private async Task<TResult> BoundedAsync<TResult>(Func<CancellationToken, Task<TResult>> send, Action<TResult> discard, CancellationToken cancellationToken)
    {
        // A caller that already cancelled sends nothing (a viewer token must not be minted for a caller that never gets it).
        cancellationToken.ThrowIfCancellationRequested();
        var transport = new CancellationTokenSource();

        // On the thread pool: a handler that blocks before returning its task cannot hold the limit below.
        var work = Task.Run(() => send(transport.Token), CancellationToken.None);
        var stop = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task winner;
        using (var timer = new CancellationTokenSource(_timeout))
        using (timer.Token.Register(static state => ((TaskCompletionSource<bool>)state!).TrySetResult(true), stop))
        using (cancellationToken.Register(static state => ((TaskCompletionSource<bool>)state!).TrySetResult(false), stop))
        {
            winner = await Task.WhenAny(work, stop.Task).ConfigureAwait(false);
        }

        if (winner == work)
        {
            transport.Dispose();
            return await work.ConfigureAwait(false);
        }

        // Abandoned: cancel the transport apart from this call (a callback registered on it may block or throw), and
        // dispose whatever the attempt still produces.
        var cancelled = Task.Run(
            () =>
            {
                try
                {
                    transport.Cancel();
                }
                catch (Exception e) when (e is AggregateException or ObjectDisposedException)
                {
                    // A callback registered by the handler threw; the attempt is abandoned either way.
                }
            },
            CancellationToken.None);
        // A late result is disposed as soon as it exists, even while a cancellation callback still blocks; the token
        // source is disposed only once both the attempt and its cancellation are done.
        _ = work.ContinueWith(
            late =>
            {
                _ = late.Exception;
                if (late.Status == TaskStatus.RanToCompletion)
                {
                    discard(late.Result);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        _ = Task.WhenAll(cancelled, work).ContinueWith(
            all =>
            {
                _ = all.Exception;
                transport.Dispose();
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);

        cancellationToken.ThrowIfCancellationRequested();
        throw new TimeoutException("Logbird did not answer within the read timeout.");
    }

    private async Task<(HttpResponseMessage Response, byte[] Body)> SendAndReadAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            return (response, await Internal.BatchSender.ReadBodyAsync(response, MaxResponseBytes, cancellationToken).ConfigureAwait(false));
        }
        catch (System.IO.InvalidDataException)
        {
            var status = response.StatusCode;
            response.Dispose();
            throw new TooLargeResponseException(status);
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    private async Task<T?> SendAsync<T>(HttpMethod method, string url, HttpContent? content, JsonTypeInfo<T> type, CancellationToken cancellationToken, bool notFoundIsNull = false)
        where T : class
    {
        using var request = new HttpRequestMessage(method, url) { Content = content };
        request.Headers.Authorization = _authorization;
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.UserAgent.Add(new ProductInfoHeaderValue("Logbird.NET", LogbirdClient.Version));
        HttpResponseMessage response;
        byte[] body;
        try
        {
            (response, body) = await SendBoundedAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (TooLargeResponseException e)
        {
            throw new LogbirdApiException(e.Status, "response_too_large", "The Logbird response was larger than the read client accepts.");
        }
        catch (System.IO.InvalidDataException)
        {
            throw new LogbirdApiException(null, "response_too_large", "The Logbird response was larger than the read client accepts.");
        }
        catch (Exception e) when (e is HttpRequestException or OperationCanceledException or System.IO.IOException or ObjectDisposedException or TimeoutException)
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
                var shape = ResponseShape.For(typeof(T));
                if (shape is not null)
                {
                    using var document = JsonDocument.Parse(body);
                    if (!shape(document.RootElement))
                    {
                        throw new LogbirdApiException(response.StatusCode, "invalid_response", "Logbird returned a response without the members this SDK requires.");
                    }
                }

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

/// <summary>A response body over the read client's limit, with the status the server answered.</summary>
internal sealed class TooLargeResponseException(HttpStatusCode status) : Exception("The Logbird response was larger than the read client accepts.")
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>A server's reported version: its numbers, and whether it is a pre-release of them.</summary>
internal readonly record struct ServerVersion(Version Numbers, bool PreRelease)
{
    /// <summary>Whether this version is <paramref name="minimum"/> or later; 0.2.0-rc.1 is not 0.2.0 or later.</summary>
    public bool AtLeast(Version minimum) => Numbers > minimum || (Numbers == minimum && !PreRelease);

    public override string ToString() => Numbers + (PreRelease ? " (pre-release)" : string.Empty);
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
