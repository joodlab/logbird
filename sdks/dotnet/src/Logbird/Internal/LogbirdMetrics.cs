using System.Collections.Generic;
using System.Diagnostics.Metrics;

namespace Logbird.Internal;

/// <summary>OpenTelemetry-compatible counters on the <c>Logbird</c> meter.</summary>
internal static class LogbirdMetrics
{
    public const string MeterName = "Logbird";

    private static readonly Meter Meter = new(MeterName, LogbirdClient.Version);

    public static readonly Counter<long> Tracked = Meter.CreateCounter<long>(
        "logbird.events.tracked", "{event}", "Events accepted into the in-memory queue.");

    public static readonly Counter<long> Delivered = Meter.CreateCounter<long>(
        "logbird.events.delivered", "{event}", "Events the server stored.");

    public static readonly Counter<long> Rejected = Meter.CreateCounter<long>(
        "logbird.events.rejected", "{event}", "Events the server rejected individually.");

    public static readonly Counter<long> Dropped = Meter.CreateCounter<long>(
        "logbird.events.dropped", "{event}", "Events that will not be stored, by reason.");

    public static readonly Counter<long> FailedSends = Meter.CreateCounter<long>(
        "logbird.batches.failed", "{batch}", "Batches that failed after all retries and were queued again.");

    public static readonly UpDownCounter<long> QueueLength = Meter.CreateUpDownCounter<long>(
        "logbird.queue.length", "{event}", "Events waiting to be sent.");

    public static KeyValuePair<string, object?> Reason(DropReason reason) => new("reason", ReasonName(reason));

    private static string ReasonName(DropReason reason) => reason switch
    {
        DropReason.QueueFull => "queue_full",
        DropReason.Rejected => "rejected",
        DropReason.HttpError => "http_error",
        DropReason.TooLarge => "too_large",
        DropReason.Shutdown => "shutdown",
        _ => "invalid",
    };
}
