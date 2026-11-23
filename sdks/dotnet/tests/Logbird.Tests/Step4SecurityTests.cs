using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Step-4 review, security and privacy: A06 (owned handlers use no proxy) and A17 (bounded, safe reads).</summary>
public class Step4SecurityTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private const string Version020 = "{\"info\":{\"version\":\"0.2.0\"}}";

    private static LogbirdReadClient Reader(HttpMessageHandler handler, TimeSpan? timeout = null)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional", Timeout = timeout ?? TimeSpan.FromSeconds(30) }, new HttpClient(handler));

    private sealed class Answer(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => answer(request, cancellationToken);
    }

    // ---------------------------------------------------------------- A06: no proxy on the handlers the SDK owns

    [Fact]
    public void The_ingest_clients_own_handler_follows_no_redirect_and_uses_no_proxy()
    {
        using var handler = LogbirdClient.CreateHandler();
#if NET8_0_OR_GREATER
        var sockets = Assert.IsType<SocketsHttpHandler>(handler);
        Assert.False(sockets.UseProxy);
        Assert.False(sockets.AllowAutoRedirect);
#else
        var classic = Assert.IsType<HttpClientHandler>(handler);
        Assert.False(classic.UseProxy);
        Assert.False(classic.AllowAutoRedirect);
#endif
    }

    [Fact]
    public void The_read_clients_own_handler_follows_no_redirect_and_uses_no_proxy()
    {
        using var handler = Assert.IsType<HttpClientHandler>(LogbirdReadClient.CreateHandler());
        Assert.False(handler.UseProxy);
        Assert.False(handler.AllowAutoRedirect);
    }

    // ---------------------------------------------------------------- A17: abandoned reads are bounded

    [Fact]
    public async Task Reads_abandoned_at_their_timeout_are_bounded_and_free_their_slots_when_they_finish()
    {
        var calls = 0;
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new Answer((_, _) =>
        {
            // The first reads hang (ignoring cancellation, as a broken handler might); once they are let go, Logbird answers.
            return Interlocked.Increment(ref calls) <= LogbirdReadClient.MaxAbandonedReads
                ? never.Task
                : Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{}", Encoding.UTF8, "application/json") });
        });
        using var reader = Reader(handler, TimeSpan.FromMilliseconds(100));

        for (var i = 0; i < LogbirdReadClient.MaxAbandonedReads; i++)
        {
            Assert.Equal("unreachable", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"))).Code);
        }

        // Every slot is held: the next read fails at once, without sending anything.
        var refused = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"));
        Assert.Equal("unreachable", refused.Code);
        Assert.Equal(LogbirdReadClient.MaxAbandonedReads, Volatile.Read(ref calls));

        // The hung attempts finish: their slots come back, and reads are sent again.
        never.TrySetException(new HttpRequestException("fictional late failure"));
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (true)
            {
                try
                {
                    Assert.Null(await reader.GetEventAsync("evt_1"));
                    return;
                }
                catch (LogbirdApiException)
                {
                    await Task.Delay(20);
                }
            }
        });
        Assert.True(Volatile.Read(ref calls) > LogbirdReadClient.MaxAbandonedReads);
    }

    // ---------------------------------------------------------------- A17: unexpected transport failures are mapped

    [Fact]
    public async Task An_unexpected_handler_exception_becomes_unreachable_without_its_message()
    {
        using var reader = Reader(new Answer((_, _) => throw new InvalidOperationException("fictional-secret-in-message")));

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"));

        Assert.Equal("unreachable", error.Code);
        Assert.DoesNotContain("fictional-secret", error.Message, StringComparison.Ordinal);
        Assert.Null(error.InnerException);
    }

    [Fact]
    public async Task An_unexpected_body_exception_becomes_unreachable_without_its_message()
    {
        using var reader = Reader(new Answer((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StreamContent(new ThrowingStream()),
        })));

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"));

        Assert.Equal("unreachable", error.Code);
        Assert.DoesNotContain("fictional-secret", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_export_body_that_throws_unexpectedly_is_unreachable_and_a_destination_failure_keeps_its_identity()
    {
        static HttpResponseMessage Export(Stream body)
        {
            var content = new StreamContent(body);
            content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/x-ndjson");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
        }

        var handler = new Answer((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath == "/openapi.json"
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Version020, Encoding.UTF8, "application/json") }
            : Export(new ThrowingStream())));
        using (var reader = Reader(handler))
        {
            using var destination = new MemoryStream();
            var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), destination));
            Assert.Equal("unreachable", error.Code);
            Assert.DoesNotContain("fictional-secret", error.Message, StringComparison.Ordinal);
        }

        var good = new Answer((request, _) => Task.FromResult(request.RequestUri!.AbsolutePath == "/openapi.json"
            ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(Version020, Encoding.UTF8, "application/json") }
            : Export(new MemoryStream(Encoding.UTF8.GetBytes("{\"id\":\"evt_1\"}\n")))));
        using (var reader = Reader(good))
        {
            var own = new InvalidOperationException("the caller's own stream failed");
            var thrown = await Assert.ThrowsAsync<InvalidOperationException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new FailingDestination(own)));
            Assert.Same(own, thrown);
        }
    }

    /// <summary>A body stream that fails with an unexpected exception whose message carries data.</summary>
    private sealed class ThrowingStream : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => throw new InvalidOperationException("fictional-secret-in-body");

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => throw new InvalidOperationException("fictional-secret-in-body");

#if NET
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("fictional-secret-in-body");
#endif

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>The caller's export destination, failing with its own exception.</summary>
    private sealed class FailingDestination(Exception failure) : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count) => throw failure;

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => throw failure;

#if NET
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default) => throw failure;
#endif
    }
}
