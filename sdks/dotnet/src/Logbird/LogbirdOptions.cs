using System;

namespace Logbird;

/// <summary>Settings for <see cref="LogbirdClient"/>.</summary>
public sealed class LogbirdOptions
{
    /// <summary>
    /// Your Logbird public origin, for example <c>https://audit.example.com</c> (the same value as the server's
    /// <c>APP_URL</c>), without <c>/v1/events</c>. Required when <see cref="Enabled"/> is <see langword="true"/>.
    /// </summary>
    public Uri? Endpoint { get; set; }

    /// <summary>
    /// Allows a plain <c>http</c> endpoint on a non-loopback host. Off by default, because every request carries the
    /// ingest key and the audit data. Use it only on a private network you trust.
    /// </summary>
    public bool AllowInsecureHttp { get; set; }

    /// <summary>
    /// The time limit for one HTTP request, enforced even if a custom handler ignores cancellation. Defaults to 30
    /// seconds, between 1 ms and 5 minutes. A request that runs out is retried like a network error.
    /// </summary>
    public TimeSpan RequestTimeout { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>A project ingest key (<c>lb_ingest_…</c>). Keep it on the server. Required when <see cref="Enabled"/> is <see langword="true"/>.</summary>
    public string? IngestKey { get; set; }

    /// <summary>
    /// When <see langword="false"/>, <c>Track</c> does nothing and no endpoint or key is needed. Use it to switch capture
    /// off deliberately, for example in local development.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>The default <see cref="AuditEvent.Environment"/>, for example <c>production</c>.</summary>
    public string? Environment { get; set; }

    /// <summary>The default <see cref="AuditEvent.Source"/>.</summary>
    public string? Source { get; set; }

    /// <summary>
    /// Runs on a copy of every event after defaults, id and timestamp are applied and before redaction. Return the event
    /// (changed or not) to send it, or <see langword="null"/> to skip it. If it throws, the event is dropped and reported.
    /// It runs synchronously on the thread calling <c>Track</c>, so it must be fast and must not block.
    /// </summary>
    public Func<AuditEvent, AuditEvent?>? BeforeSend { get; set; }

    /// <summary>Secret redaction. On by default; see <see cref="RedactionOptions"/>.</summary>
    public RedactionOptions Redaction { get; set; } = new();

    /// <summary>Events per request, 1 to 1000. Defaults to 100. A batch is sent as soon as it is full.</summary>
    public int BatchSize { get; set; } = 100;

    /// <summary>
    /// The batching interval: how long a batch that is not yet full waits before it is sent. Defaults to one second. It is
    /// not a bound on delivery: while an earlier batch is being sent or retried, later events wait for it.
    /// </summary>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>Retries for one batch after a network error, 429 or 5xx, with exponential backoff. Defaults to 5.</summary>
    public int MaxRetries { get; set; } = 5;

    /// <summary>
    /// The most events held in memory while waiting to be sent. Defaults to 10,000. When it is full,
    /// <see cref="QueueFullBehavior"/> decides which event is dropped; <c>Track</c> never blocks or throws. The batch
    /// being sent comes on top (up to <see cref="BatchSize"/> more events), and <see cref="LogbirdStats.QueueLength"/>
    /// counts both.
    /// </summary>
    public int MaxQueueSize { get; set; } = 10_000;

    /// <summary>
    /// Which event to drop when the queue is full. Defaults to <see cref="Logbird.QueueFullBehavior.DropOldest"/>.
    /// </summary>
    /// <remarks>
    /// When you track an event into a full queue, <see cref="Logbird.QueueFullBehavior.DropOldest"/> evicts the oldest
    /// queued event (keeping the most recent activity) and <see cref="Logbird.QueueFullBehavior.DropNewest"/> drops the new
    /// one (keeping what is already queued). When a failed batch goes back to the front of a queue that filled in the
    /// meantime, the excess is evicted the same way: <c>DropOldest</c> from the front (the returned batch's oldest events
    /// first), <c>DropNewest</c> from the back (the newest queued events). Every dropped event is counted;
    /// <see cref="OnDrop"/> receives it with its JSON on a best-effort basis (skipped when the callbacks fall far behind).
    /// </remarks>
    public QueueFullBehavior QueueFullBehavior { get; set; } = QueueFullBehavior.DropOldest;

    /// <summary>
    /// How long disposing the client may spend sending what is still queued. Defaults to ten seconds; keep it below
    /// your host's shutdown timeout. Events still queued afterwards are dropped and reported through <see cref="OnDrop"/>.
    /// </summary>
    public TimeSpan ShutdownTimeout { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>
    /// Called when delivery fails (after retries), when the server rejects events, or when an event cannot be recorded.
    /// The exception message never contains event data or keys. Exceptions thrown by the callback are ignored.
    /// </summary>
    public Action<Exception>? OnError { get; set; }

    /// <summary>
    /// Called once for every event the SDK stops trying to deliver: queue overflow, a server rejection, a permanent HTTP
    /// error, an oversized or invalid event, an unacknowledged event, or shutdown. Such an event may still have been
    /// stored if a request carrying it lost its answer: see <see cref="DroppedEvent.MayBeStored"/>, and resend it with the
    /// same id when in doubt (the server deduplicates by id while it retains the original). The <see cref="DroppedEvent.Json"/> lets you save it for replay; do not
    /// log it if it may contain personal data. Callbacks run in order on a background thread, never on the thread that
    /// called <c>Track</c>; if they fall more than <see cref="MaxQueueSize"/> (at least 1,000) notifications behind,
    /// further notifications are skipped and counted on the <c>logbird.notifications.lost</c> meter, while
    /// <see cref="LogbirdClient.Stats"/> still counts every event. Exceptions thrown by the callback are ignored.
    /// </summary>
    public Action<DroppedEvent>? OnDrop { get; set; }

    // Messages name the setting and the rule, never the value.
    internal void Validate()
    {
        if (BatchSize is < 1 or > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(BatchSize), "BatchSize must be between 1 and 1000.");
        }

        if (MaxQueueSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxQueueSize), "MaxQueueSize must be at least 1.");
        }

        if (MaxRetries < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxRetries), "MaxRetries must not be negative.");
        }

        if (FlushInterval < TimeSpan.FromMilliseconds(1) || FlushInterval > TimeSpan.FromHours(1))
        {
            throw new ArgumentOutOfRangeException(nameof(FlushInterval), "FlushInterval must be between 1 ms and 1 hour.");
        }

        if (ShutdownTimeout < TimeSpan.Zero || ShutdownTimeout > TimeSpan.FromHours(1))
        {
            throw new ArgumentOutOfRangeException(nameof(ShutdownTimeout), "ShutdownTimeout must be between 0 and 1 hour.");
        }

        if (RequestTimeout < TimeSpan.FromMilliseconds(1) || RequestTimeout > TimeSpan.FromMinutes(5))
        {
            throw new ArgumentOutOfRangeException(nameof(RequestTimeout), "RequestTimeout must be between 1 ms and 5 minutes.");
        }

        if (QueueFullBehavior is not (QueueFullBehavior.DropOldest or QueueFullBehavior.DropNewest))
        {
            throw new ArgumentOutOfRangeException(nameof(QueueFullBehavior), "Unknown QueueFullBehavior.");
        }

        if (Redaction is null)
        {
            throw new ArgumentException("Redaction must not be null; set Redaction.Enabled = false to turn it off.", nameof(Redaction));
        }

        if (!Enabled)
        {
            return;
        }

        Internal.Endpoints.Validate(Endpoint, AllowInsecureHttp, nameof(Endpoint));

        if (string.IsNullOrWhiteSpace(IngestKey))
        {
            throw new ArgumentException("IngestKey is required when Logbird is enabled. Set Enabled = false to turn capture off.", nameof(IngestKey));
        }
    }
}

/// <summary>Which event is dropped when the in-memory queue is full.</summary>
public enum QueueFullBehavior
{
    /// <summary>Evict the oldest queued event to keep the most recent activity (see <see cref="LogbirdOptions.QueueFullBehavior"/>).</summary>
    DropOldest = 0,

    /// <summary>
    /// Drop the incoming event to keep what is already queued; a failed batch returning to a full queue evicts the newest
    /// queued events (see <see cref="LogbirdOptions.QueueFullBehavior"/>).
    /// </summary>
    DropNewest = 1,
}
