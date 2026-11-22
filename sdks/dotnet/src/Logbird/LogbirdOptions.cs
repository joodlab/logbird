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
    /// </summary>
    public Func<AuditEvent, AuditEvent?>? BeforeSend { get; set; }

    /// <summary>Secret redaction. On by default; see <see cref="RedactionOptions"/>.</summary>
    public RedactionOptions Redaction { get; set; } = new();

    /// <summary>Events per request, 1 to 1000. Defaults to 100. A batch is sent as soon as it is full.</summary>
    public int BatchSize { get; set; } = 100;

    /// <summary>The longest an event waits before its batch is sent. Defaults to one second.</summary>
    public TimeSpan FlushInterval { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>Retries for one batch after a network error, 429 or 5xx, with exponential backoff. Defaults to 5.</summary>
    public int MaxRetries { get; set; } = 5;

    /// <summary>
    /// The most events held in memory while waiting to be sent. Defaults to 10,000. When it is full,
    /// <see cref="QueueFullBehavior"/> decides which event is dropped; <c>Track</c> never blocks or throws.
    /// </summary>
    public int MaxQueueSize { get; set; } = 10_000;

    /// <summary>Which event to drop when the queue is full. Defaults to <see cref="Logbird.QueueFullBehavior.DropOldest"/>.</summary>
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
    /// Called once for every event that will not be stored: queue overflow, a server rejection, a permanent HTTP error,
    /// an oversized or invalid event, or shutdown. The <see cref="DroppedEvent.Json"/> lets you save it for replay; do not
    /// log it if it may contain personal data. Callbacks run in order on a background thread, never on the thread that
    /// called <c>Track</c>; if they fall more than <see cref="MaxQueueSize"/> (at least 1,000) notifications behind,
    /// further notifications are skipped and counted on the <c>logbird.notifications.lost</c> meter, while
    /// <see cref="LogbirdClient.Stats"/> still counts every event. Exceptions thrown by the callback are ignored.
    /// </summary>
    public Action<DroppedEvent>? OnDrop { get; set; }

    internal void Validate()
    {
        if (BatchSize is < 1 or > 1000)
        {
            throw new ArgumentOutOfRangeException(nameof(BatchSize), BatchSize, "BatchSize must be between 1 and 1000.");
        }

        if (MaxQueueSize < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxQueueSize), MaxQueueSize, "MaxQueueSize must be at least 1.");
        }

        if (MaxRetries < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxRetries), MaxRetries, "MaxRetries must not be negative.");
        }

        if (FlushInterval < TimeSpan.FromMilliseconds(1) || FlushInterval > TimeSpan.FromHours(1))
        {
            throw new ArgumentOutOfRangeException(nameof(FlushInterval), FlushInterval, "FlushInterval must be between 1 ms and 1 hour.");
        }

        if (ShutdownTimeout < TimeSpan.Zero || ShutdownTimeout > TimeSpan.FromHours(1))
        {
            throw new ArgumentOutOfRangeException(nameof(ShutdownTimeout), ShutdownTimeout, "ShutdownTimeout must be between 0 and 1 hour.");
        }

        if (RequestTimeout < TimeSpan.FromMilliseconds(1) || RequestTimeout > TimeSpan.FromMinutes(5))
        {
            throw new ArgumentOutOfRangeException(nameof(RequestTimeout), RequestTimeout, "RequestTimeout must be between 1 ms and 5 minutes.");
        }

        if (QueueFullBehavior is not (QueueFullBehavior.DropOldest or QueueFullBehavior.DropNewest))
        {
            throw new ArgumentOutOfRangeException(nameof(QueueFullBehavior), QueueFullBehavior, "Unknown QueueFullBehavior.");
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
    /// <summary>Drop the oldest queued event to keep the most recent activity.</summary>
    DropOldest = 0,

    /// <summary>Drop the incoming event to keep the history that is already queued.</summary>
    DropNewest = 1,
}
