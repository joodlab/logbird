using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>
/// Step-4 PR 2 review follow-ups (A17): the read client's boundary with caller-supplied transport code. Nothing a handler,
/// a response, its body or their disposal throws reaches the caller with its message, and an abandoned read holds its slot
/// until its cleanup is done.
/// </summary>
public class Step4SecurityFollowUpTests
{
    private static readonly Uri Endpoint = new("https://audit.example.invalid/");

    private const string Secret = "fictional-secret";

    private static LogbirdReadClient Reader(HttpMessageHandler handler, TimeSpan? timeout = null)
        => new(new LogbirdReadOptions { Endpoint = Endpoint, ReadKey = "lb_read_fictional", Timeout = timeout ?? TimeSpan.FromSeconds(30) }, new HttpClient(handler));

    private sealed class Answer(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => answer(request, cancellationToken);
    }

    private static bool IsProbe(HttpRequestMessage request) => request.RequestUri!.AbsolutePath == "/openapi.json";

    private static HttpResponseMessage Version020(HttpResponseMessage? response = null)
    {
        response ??= new HttpResponseMessage(HttpStatusCode.OK);
        response.StatusCode = HttpStatusCode.OK;
        response.Content = new StringContent("{\"info\":{\"version\":\"0.2.0\"}}", Encoding.UTF8, "application/json");
        return response;
    }

    private static HttpResponseMessage Ndjson(Stream body, HttpResponseMessage? response = null)
    {
        response ??= new HttpResponseMessage(HttpStatusCode.OK);
        var content = new StreamContent(body);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/x-ndjson");
        response.Content = content;
        return response;
    }

    private static void AssertNoSecret(Exception error)
    {
        Assert.DoesNotContain(Secret, error.ToString(), StringComparison.Ordinal);
        Assert.Null(error.InnerException);
    }

    // ---------------------------------------------------------------- A17-1: the bound on abandoned reads

    [Fact]
    public async Task Reads_in_flight_when_the_limit_is_reached_are_abandoned_too_and_then_new_reads_are_refused()
    {
        // As documented: the limit refuses new reads; reads already in flight are not stopped, so one more than the limit
        // can be abandoned here, and no more after that.
        var calls = 0;
        var never = new TaskCompletionSource<HttpResponseMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var reader = Reader(new Answer((_, _) => { Interlocked.Increment(ref calls); return never.Task; }), TimeSpan.FromMilliseconds(200));
        var inFlight = LogbirdReadClient.MaxAbandonedReads + 1;

        var reads = new Task<EventDetail?>[inFlight];
        for (var i = 0; i < inFlight; i++)
        {
            reads[i] = reader.GetEventAsync("evt_1");
        }

        foreach (var read in reads)
        {
            Assert.Equal("unreachable", (await Assert.ThrowsAsync<LogbirdApiException>(() => read)).Code);
        }
        Assert.Equal(inFlight, Volatile.Read(ref calls));

        Assert.Equal("unreachable", (await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"))).Code);
        Assert.Equal(inFlight, Volatile.Read(ref calls));
        never.TrySetCanceled();
    }

    // ---------------------------------------------------------------- A17-2: cleanup of a late response holds its slot

    [Fact]
    public async Task A_late_result_whose_disposal_blocks_keeps_its_slot_until_the_disposal_ends()
    {
        // An attempt that ends successfully after it was abandoned (one that ignores cancellation) hands its result to the
        // discard step, which disposes it apart from the attempt: the slot is held until that disposal ends too.
        var late = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var disposals = new BlockingDisposal();
        using var reader = Reader(new Answer((_, _) => throw new InvalidOperationException("not used")), TimeSpan.FromMilliseconds(100));

        for (var i = 0; i < LogbirdReadClient.MaxAbandonedReads; i++)
        {
            await Assert.ThrowsAsync<TimeoutException>(() => reader.BoundedAsync(
                async _ =>
                {
                    await late.Task.ConfigureAwait(false);
                    return new object();
                },
                _ => disposals.Enter(),
                CancellationToken.None));
        }

        // The attempts finish, and each disposal blocks: every slot is still held, so a new read is refused unsent.
        late.TrySetResult(true);
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (Volatile.Read(ref disposals.Started) < LogbirdReadClient.MaxAbandonedReads)
            {
                await Task.Delay(10);
            }
        });
        await Task.Delay(200);
        var sent = false;
        await Assert.ThrowsAsync<TimeoutException>(() => reader.BoundedAsync(_ => { sent = true; return Task.FromResult(new object()); }, _ => { }, CancellationToken.None));
        Assert.False(sent);

        // The disposals end: the slots come back.
        disposals.Release();
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (true)
            {
                try
                {
                    Assert.Equal(1, await reader.BoundedAsync(_ => Task.FromResult(1), _ => { }, CancellationToken.None));
                    return;
                }
                catch (TimeoutException)
                {
                    await Task.Delay(20);
                }
            }
        });
    }

    [Fact]
    public async Task A_late_result_whose_disposal_throws_still_frees_its_slot()
    {
        var late = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var reader = Reader(new Answer((_, _) => throw new InvalidOperationException("not used")), TimeSpan.FromMilliseconds(100));

        for (var i = 0; i < LogbirdReadClient.MaxAbandonedReads; i++)
        {
            await Assert.ThrowsAsync<TimeoutException>(() => reader.BoundedAsync(
                async _ =>
                {
                    await late.Task.ConfigureAwait(false);
                    return new object();
                },
                _ => throw new InvalidOperationException(Secret),
                CancellationToken.None));
        }

        late.TrySetResult(true);
        await Deadline.Within(TimeSpan.FromSeconds(10), async () =>
        {
            while (true)
            {
                try
                {
                    Assert.Equal(1, await reader.BoundedAsync(_ => Task.FromResult(1), _ => { }, CancellationToken.None));
                    return;
                }
                catch (TimeoutException)
                {
                    await Task.Delay(20);
                }
            }
        });
    }

    // ---------------------------------------------------------------- A17-3: an export's error body

    [Fact]
    public async Task An_export_error_whose_body_throws_reports_the_status_without_the_bodys_message()
    {
        var handler = new Answer((request, _) => Task.FromResult(IsProbe(request)
            ? Version020()
            : new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StreamContent(new ThrowingStream(() => new InvalidOperationException(Secret))) }));
        using var reader = Reader(handler);

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream()));

        Assert.Equal(HttpStatusCode.Forbidden, error.StatusCode);
        AssertNoSecret(error);
    }

    // ---------------------------------------------------------------- A17-4: disposal of the transport's objects

    [Fact]
    public async Task A_response_that_throws_from_dispose_never_replaces_a_reads_outcome()
    {
        using var reader = Reader(new Answer((_, _) => Task.FromResult<HttpResponseMessage>(
            new ThrowingDisposeResponse(HttpStatusCode.NotFound) { Content = new StringContent("{}", Encoding.UTF8, "application/json") })));

        Assert.Null(await reader.GetEventAsync("evt_1"));
    }

    [Fact]
    public async Task Responses_that_throw_from_dispose_never_replace_an_exports_outcome()
    {
        // The version probe's response and the export's both throw from Dispose; the export's own answer (403) is reported.
        var handler = new Answer((request, _) => Task.FromResult<HttpResponseMessage>(IsProbe(request)
            ? Version020(new ThrowingDisposeResponse(HttpStatusCode.OK))
            : new ThrowingDisposeResponse(HttpStatusCode.Forbidden) { Content = new StringContent("{}", Encoding.UTF8, "application/json") }));
        using var reader = Reader(handler);

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream()));

        Assert.Equal(HttpStatusCode.Forbidden, error.StatusCode);
        AssertNoSecret(error);

        // A complete download whose response throws from Dispose is still complete.
        var complete = new Answer((request, _) => Task.FromResult<HttpResponseMessage>(IsProbe(request)
            ? Version020()
            : Ndjson(new MemoryStream(Encoding.UTF8.GetBytes("{\"id\":\"evt_1\"}\n")), new ThrowingDisposeResponse(HttpStatusCode.OK))));
        using var completeReader = Reader(complete);
        Assert.Equal(15, await completeReader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream()));
    }

    [Fact]
    public async Task Cancelling_an_export_never_throws_into_the_canceller_when_the_response_throws_from_dispose()
    {
        var reading = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new Answer((request, _) => Task.FromResult<HttpResponseMessage>(IsProbe(request)
            ? Version020()
            : Ndjson(new StallingStream(reading, () => new IOException("stalled read ended")), new ThrowingDisposeResponse(HttpStatusCode.OK))));
        using var reader = Reader(handler);
        using var cts = new CancellationTokenSource();

        var export = reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream(), cts.Token);
        await reading.Task;
        cts.Cancel();

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => export);
        Assert.Equal(cts.Token, cancelled.CancellationToken);
    }

    [Fact]
    public async Task Cancelling_an_export_while_it_reads_an_error_body_never_throws_into_the_canceller()
    {
        var reading = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new Answer((request, _) => Task.FromResult<HttpResponseMessage>(IsProbe(request)
            ? Version020()
            : new ThrowingDisposeResponse(HttpStatusCode.Forbidden) { Content = new StreamContent(new StallingStream(reading, () => new IOException("stalled read ended"))) }));
        using var reader = Reader(handler);
        using var cts = new CancellationTokenSource();

        var export = reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream(), cts.Token);
        await reading.Task;
        cts.Cancel();

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => export);
        AssertNoSecret(cancelled);
    }

    [Fact]
    public async Task A_body_stream_that_throws_from_dispose_never_replaces_a_body_read_in_full()
    {
        using var reader = Reader(new Answer((_, _) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
        {
            Content = new StreamContent(new ThrowingDisposeStream(Encoding.UTF8.GetBytes("{}"))),
        })));

        Assert.Null(await reader.GetEventAsync("evt_1"));
    }

    // ---------------------------------------------------------------- A17-5: a cancelled export carries no transport data

    [Fact]
    public async Task A_cancelled_export_whose_body_then_throws_carries_nothing_of_that_exception()
    {
        var reading = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new Answer((request, _) => Task.FromResult(IsProbe(request)
            ? Version020()
            : Ndjson(new StallingStream(reading, () => new InvalidOperationException(Secret)))));
        using var reader = Reader(handler);
        using var cts = new CancellationTokenSource();

        var export = reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream(), cts.Token);
        await reading.Task;
        cts.Cancel();

        var cancelled = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => export);
        AssertNoSecret(cancelled);
    }

    // ---------------------------------------------------------------- A17-6: an SDK-typed exception from a handler

    [Fact]
    public async Task A_handler_that_throws_the_sdks_own_exception_type_is_still_unreachable_without_its_message()
    {
        var forged = new LogbirdApiException(HttpStatusCode.OK, "fictional_code", Secret, new InvalidOperationException(Secret));
        using var reader = Reader(new Answer((_, _) => throw forged));

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.GetEventAsync("evt_1"));

        Assert.NotSame(forged, error);
        Assert.Equal("unreachable", error.Code);
        AssertNoSecret(error);
    }

    [Fact]
    public async Task An_export_body_that_throws_the_sdks_own_exception_type_is_unreachable_without_its_message()
    {
        var handler = new Answer((request, _) => Task.FromResult(IsProbe(request)
            ? Version020()
            : Ndjson(new ThrowingStream(() => new LogbirdApiException(HttpStatusCode.OK, "fictional_code", Secret)))));
        using var reader = Reader(handler);

        var error = await Assert.ThrowsAsync<LogbirdApiException>(() => reader.ExportAsync(new ExportQuery(ExportFormat.Jsonl), new MemoryStream()));

        Assert.Equal("unreachable", error.Code);
        AssertNoSecret(error);
    }

    // ---------------------------------------------------------------- the ingest sender's final response disposal

    [Fact]
    public async Task An_accepted_batch_whose_response_throws_from_dispose_is_delivered_once_with_no_error()
    {
        var drops = new System.Collections.Concurrent.ConcurrentQueue<DroppedEvent>();
        var errors = new System.Collections.Concurrent.ConcurrentQueue<Exception>();
        var server = new FakeServer().Then(request =>
        {
            var accepted = FakeServer.Accept(request);
            return new ThrowingDisposeResponse(accepted.StatusCode) { Content = accepted.Content };
        });
        var options = new LogbirdOptions
        {
            Endpoint = Endpoint,
            IngestKey = "lb_ingest_fictional",
            FlushInterval = TimeSpan.FromHours(1),
            OnDrop = drops.Enqueue,
            OnError = errors.Enqueue,
        };
        await using var client = new LogbirdClient(options, new HttpClient(server), logger: null, delay: (_, _) => Task.CompletedTask);

        client.Track(new AuditEvent("x"));
        Assert.True(await client.FlushAsync());

        Assert.Single(server.Requests);
        Assert.Equal(1, client.Stats.Delivered);
        Assert.Empty(drops);
        Assert.Empty(errors);
    }

    // ---------------------------------------------------------------- doubles

    /// <summary>Counts disposals that started, and holds each until released.</summary>
    private sealed class BlockingDisposal : IDisposable
    {
        private readonly ManualResetEventSlim _gate = new(false);

        public int Started;

        public void Enter()
        {
            Interlocked.Increment(ref Started);
            _gate.Wait();
        }

        public void Release() => _gate.Set();

        public void Dispose()
        {
            _gate.Set();
            _gate.Dispose();
        }
    }

    private sealed class ThrowingDisposeResponse(HttpStatusCode status) : HttpResponseMessage(status)
    {
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            throw new InvalidOperationException(Secret);
        }
    }

    /// <summary>A body that reads in full, then throws from Dispose.</summary>
    private sealed class ThrowingDisposeStream(byte[] body) : MemoryStream(body)
    {
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            throw new InvalidOperationException(Secret);
        }
    }

    /// <summary>A body stream whose every read throws the given exception.</summary>
    private sealed class ThrowingStream(Func<Exception> failure) : ReadOnlyStream
    {
        public override int Read(byte[] buffer, int offset, int count) => throw failure();

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => throw failure();

#if NET
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) => throw failure();
#endif
    }

    /// <summary>A body stream whose read signals that it started, waits for cancellation, then throws the given exception.</summary>
    private sealed class StallingStream(TaskCompletionSource<bool> reading, Func<Exception> failure) : ReadOnlyStream
    {
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            reading.TrySetResult(true);
            try
            {
                await Task.Delay(Timeout.Infinite, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }

            throw failure();
        }

#if NET
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => new(ReadAsync(Array.Empty<byte>(), 0, 0, cancellationToken));
#endif
    }

    private abstract class ReadOnlyStream : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
