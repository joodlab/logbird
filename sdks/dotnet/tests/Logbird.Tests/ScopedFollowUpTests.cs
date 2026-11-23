using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Issue #264: scoped read follow-ups from the #262 review.</summary>
public class ScopedFollowUpTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid");

    private const string Version020 = "{\"info\":{\"version\":\"0.2.0\"}}";

    private static FakeServer Server(Func<CapturedRequest, HttpResponseMessage> route)
        => new()
        {
            Fallback = request => Task.FromResult(request.Request.RequestUri!.AbsolutePath == "/openapi.json"
                ? FakeServer.Json(HttpStatusCode.OK, Version020)
                : route(request)),
        };

    private static LogbirdReadClient Reader(FakeServer server)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional" }, new HttpClient(server));

    private static int Calls(FakeServer server, string path) => server.Requests.Count(r => r.Request.RequestUri!.AbsolutePath == path);

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static readonly string Mac = Base64Url(Enumerable.Range(1, 32).Select(i => (byte)(i * 7)).ToArray());

    /// <summary>Grants exactly the requested scope, with a token whose own payload carries it.</summary>
    private static HttpResponseMessage Minted(CapturedRequest request)
    {
        using var body = JsonDocument.Parse(request.Body);
        var scope = body.RootElement.GetProperty("scope").GetRawText();
        var payload = Base64Url(Encoding.UTF8.GetBytes("{\"v\":1,\"s\":" + scope + ",\"exp\":1795428900,\"jti\":\"jti_fictional\"}"));
        return FakeServer.Json((HttpStatusCode)201, "{\"token\":\"lbv1." + payload + "." + Mac + "\",\"expiresAt\":\"2026-11-23T10:15:00.000Z\",\"scope\":" + scope + "}");
    }

    // ---------------------------------------------------------------- (a) the prefix snapshot and the granted prefixes

    /// <summary>Thrown by <see cref="LongPrefixes"/> when asked for a 22nd entry.</summary>
    private sealed class ReadPastTheBoundException : Exception;

    /// <summary>A list that claims one entry, yields more, and fails on a 22nd so a copy without a bound fails at once.</summary>
    private sealed class LongPrefixes : IReadOnlyList<string>
    {
        public int Enumerated;

        public int Count => 1;

        public string this[int index] => "booking.";

        public IEnumerator<string> GetEnumerator()
        {
            while (true)
            {
                if (++Enumerated > 21)
                {
                    throw new ReadPastTheBoundException();
                }

                yield return "booking.";
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    [Fact]
    public async Task A_prefix_list_of_any_length_is_refused_after_at_most_21_entries()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var prefixes = new LongPrefixes();
        await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5") { ActionPrefixes = prefixes }));
        Assert.Equal(21, prefixes.Enumerated);
        Assert.Empty(server.Requests);
    }

    [Theory]
    [InlineData(20, false)]
    [InlineData(21, true)]
    public async Task Twenty_prefixes_are_allowed_and_twenty_one_are_refused(int count, bool refused)
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var scope = new ViewerScope("biz_5") { ActionPrefixes = Enumerable.Range(0, count).Select(i => "p" + i.ToString(System.Globalization.CultureInfo.InvariantCulture) + ".").ToArray() };
        if (refused)
        {
            await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(scope));
            Assert.Empty(server.Requests);
        }
        else
        {
            Assert.Equal(count, (await reader.MintViewerTokenAsync(scope)).Scope.ActionPrefixes!.Count);
        }
    }

    [Fact]
    public async Task The_granted_prefixes_are_read_only()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var token = await reader.MintViewerTokenAsync(new ViewerScope("biz_5") { ActionPrefixes = ["booking.", "auth."] });
        var granted = token.Scope.ActionPrefixes!;
        Assert.Equal(new[] { "booking.", "auth." }, granted);

        // No interface leads to storage a caller could change: not a list or array, not IList or ICollection (whose
        // SyncRoot can be the backing list), only IReadOnlyList.
        Assert.False(granted is List<string>);
        Assert.False(granted is string[]);
        Assert.False(granted is IList<string>);
        Assert.False(granted is ICollection<string>);
        Assert.False(granted is IList);
        Assert.False(granted is ICollection);
    }

    // ---------------------------------------------------------------- (b) fractional lifetime

    [Theory]
    [InlineData(600.5)]
    [InlineData(60.001)]
    public async Task A_lifetime_with_a_fraction_of_a_second_is_refused_not_truncated(double seconds)
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        var error = await Assert.ThrowsAsync<ArgumentException>(() => reader.MintViewerTokenAsync(new ViewerScope("biz_5"), TimeSpan.FromSeconds(seconds)));
        Assert.Equal("lifetime", error.ParamName);
        Assert.Empty(server.Requests);
    }

    [Fact]
    public async Task A_whole_second_lifetime_is_sent_exactly()
    {
        var server = Server(Minted);
        using var reader = Reader(server);
        await reader.MintViewerTokenAsync(new ViewerScope("biz_5"), TimeSpan.FromSeconds(61));
        Assert.Contains("\"ttlSeconds\":61", server.Requests.Single(r => r.Request.RequestUri!.AbsolutePath == "/v1/viewer-tokens").Text);
    }

    // ---------------------------------------------------------------- (c) the export answer and destination failures

    private static HttpResponseMessage Answer(HttpStatusCode status, string body, string? mediaType)
    {
        var content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
        if (mediaType is not null)
        {
            content.Headers.TryAddWithoutValidation("Content-Type", mediaType);
        }

        return new HttpResponseMessage(status) { Content = content };
    }

    [Theory]
    [InlineData(206, "text/csv; charset=utf-8", ExportFormat.Csv)]
    [InlineData(203, "text/csv; charset=utf-8", ExportFormat.Csv)]
    [InlineData(200, "text/html; charset=utf-8", ExportFormat.Csv)]
    [InlineData(200, "text/html", ExportFormat.Jsonl)]
    [InlineData(200, "application/x-ndjson", ExportFormat.Csv)]
    [InlineData(200, "text/csv", ExportFormat.JsonlEvidence)]
    [InlineData(200, null, ExportFormat.Jsonl)]
    public async Task An_answer_that_is_not_the_requested_export_writes_nothing(int status, string? mediaType, ExportFormat format)
    {
        var server = Server(_ => Answer((HttpStatusCode)status, "<html>fictional proxy page</html>", mediaType));
        using var reader = Reader(server);
        using var file = new MemoryStream();
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(format), file));
        Assert.Equal("invalid_response", error.Code);
        Assert.Equal((HttpStatusCode)status, error.StatusCode);
        Assert.Equal(0, file.Length);
    }

    [Theory]
    [InlineData("text/csv; charset=utf-8", ExportFormat.Csv)]
    [InlineData("TEXT/CSV", ExportFormat.Csv)]
    [InlineData("application/x-ndjson", ExportFormat.Jsonl)]
    [InlineData("application/x-ndjson", ExportFormat.JsonlEvidence)]
    public async Task The_requested_export_is_written(string mediaType, ExportFormat format)
    {
        const string body = "id,action\nevt_1,booking.created\n";
        using var reader = Reader(Server(_ => Answer(HttpStatusCode.OK, body, mediaType)));
        using var file = new MemoryStream();
        Assert.Equal(body.Length, await reader.ExportAsync(new ExportQuery(format), file));
        Assert.Equal(body, Encoding.UTF8.GetString(file.ToArray()));
    }

    /// <summary>A destination that accepts a number of bytes, then fails like a full disk.</summary>
    private sealed class FullDisk(int capacity) : MemoryStream
    {
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => Length + count > capacity ? throw new IOException("fictional disk full") : base.WriteAsync(buffer, offset, count, cancellationToken);

#if NET
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => Length + buffer.Length > capacity ? throw new IOException("fictional disk full") : base.WriteAsync(buffer, cancellationToken);
#endif
    }

    [Fact]
    public async Task A_destination_failure_reaches_the_caller_unchanged_not_as_a_network_failure()
    {
        var body = string.Concat(Enumerable.Repeat("evt_1,booking.created\n", 10_000));
        using var reader = Reader(Server(_ => Answer(HttpStatusCode.OK, body, "text/csv; charset=utf-8")));
        using var file = new FullDisk(100_000);
        var error = await Assert.ThrowsAsync<IOException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file));
        Assert.Equal("fictional disk full", error.Message);
        Assert.True(file.Length > 0);
    }

    public static IEnumerable<object[]> DownloadFailures()
    {
        yield return [new IOException("fictional connection reset")];
        yield return [new InvalidDataException("fictional corrupt compressed body")];
        yield return [new TimeoutException("fictional body read timeout")];
    }

    [Theory]
    [MemberData(nameof(DownloadFailures))]
    public async Task A_failure_reading_the_download_is_unreachable(Exception failure)
    {
        var content = new StreamContent(new FailingSource(failure));
        content.Headers.TryAddWithoutValidation("Content-Type", "text/csv; charset=utf-8");
        using var reader = Reader(Server(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = content }));
        using var file = new MemoryStream();
        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file));
        Assert.Equal("unreachable", error.Code);
    }

    /// <summary>A destination that cancels the caller's token and then fails, as a stream that observes cancellation can.</summary>
    private sealed class CancellingDestination(CancellationTokenSource caller) : MemoryStream
    {
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            caller.Cancel();
            throw new IOException("fictional write aborted by cancellation");
        }

#if NET
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            caller.Cancel();
            throw new IOException("fictional write aborted by cancellation");
        }
#endif
    }

    [Fact]
    public async Task A_destination_failure_caused_by_the_callers_cancellation_is_the_cancellation()
    {
        using var reader = Reader(Server(_ => Answer(HttpStatusCode.OK, "evt_1\n", "text/csv")));
        using var caller = new CancellationTokenSource();
        using var file = new CancellingDestination(caller);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file, caller.Token));
    }

    private sealed class SentinelException(string message) : Exception(message);

    /// <summary>A destination that fails with one particular exception instance.</summary>
    private sealed class SentinelDestination(SentinelException failure) : MemoryStream
    {
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => Fail();

#if NET
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => new(Fail());
#endif

        private Task Fail() => throw failure;
    }

    /// <summary>A body that reads normally but throws whenever it is disposed.</summary>
    private sealed class BrokenOnDispose(byte[] bytes) : MemoryStream(bytes)
    {
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            throw new IOException("fictional cleanup failure");
        }
    }

    [Fact]
    public async Task A_destination_failure_survives_a_cleanup_that_also_fails()
    {
        var failure = new SentinelException("fictional disk full");
        var content = new StreamContent(new BrokenOnDispose(Encoding.UTF8.GetBytes("evt_1\n")));
        content.Headers.TryAddWithoutValidation("Content-Type", "text/csv");
        using var reader = Reader(Server(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = content }));
        using var file = new SentinelDestination(failure);
        var error = await Assert.ThrowsAsync<SentinelException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file));
        Assert.Same(failure, error);
        Assert.Contains(nameof(SentinelDestination), error.StackTrace, StringComparison.Ordinal);
    }

    /// <summary>A response that throws every time it is disposed.</summary>
    private sealed class BrokenResponse : HttpResponseMessage
    {
        public BrokenResponse(HttpContent content)
            : base(HttpStatusCode.OK)
        {
            Content = content;
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            throw new IOException("fictional response cleanup failure");
        }
    }

    [Fact]
    public async Task A_destination_failure_survives_a_response_that_throws_whenever_it_is_disposed()
    {
        var failure = new SentinelException("fictional disk full");
        var content = new ByteArrayContent(Encoding.UTF8.GetBytes("evt_1\n"));
        content.Headers.TryAddWithoutValidation("Content-Type", "text/csv");
        using var reader = Reader(Server(_ => new BrokenResponse(content)));
        using var file = new SentinelDestination(failure);
        var error = await Assert.ThrowsAsync<SentinelException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Csv), file));
        Assert.Same(failure, error);
    }

    /// <summary>A response body that fails like a dropped connection on its first read.</summary>
    private sealed class FailingSource(Exception failure) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => throw failure;

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
