using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;

namespace Logbird.Internal;

/// <summary>
/// OpenTelemetry-compatible counters on the <c>Logbird</c> meter. Creating or recording an instrument runs listener
/// code synchronously, so every step is guarded: a broken listener disables the instrument, never delivery.
/// </summary>
internal static class LogbirdMetrics
{
    public const string MeterName = "Logbird";

    private static readonly Meter? Meter = Create(() => new Meter(MeterName, LogbirdClient.Version));

    public static readonly Counter<long>? Tracked = Counter("logbird.events.tracked", "{event}", "Events accepted into the in-memory queue.");

    public static readonly Counter<long>? Delivered = Counter("logbird.events.delivered", "{event}", "Events the server stored.");

    public static readonly Counter<long>? Rejected = Counter("logbird.events.rejected", "{event}", "Events the server rejected individually.");

    public static readonly Counter<long>? Dropped = Counter("logbird.events.dropped", "{event}", "Events that will not be stored, by reason.");

    public static readonly Counter<long>? FailedSends = Counter("logbird.batches.failed", "{batch}", "Batches that failed after all retries and were queued again.");

    public static readonly Counter<long>? Filtered = Counter("logbird.events.filtered", "{event}", "Events skipped by BeforeSend.");

    public static readonly Counter<long>? Warned = Counter("logbird.events.warned", "{warning}", "Warnings about stored events (identifier whitespace, server warnings).");

    public static readonly Counter<long>? NotificationsLost = Counter(
        "logbird.notifications.lost", "{notification}", "OnDrop/OnError notifications skipped because the callbacks fell too far behind.");

    public static readonly UpDownCounter<long>? QueueLength = Create(() => Meter?.CreateUpDownCounter<long>("logbird.queue.length", "{event}", "Events waiting to be sent."));

    /// <summary>
    /// True while a measurement is being recorded on this thread. A listener that records an audit event from its
    /// measurement callback re-enters Logbird; nested measurements are skipped so that cannot recurse.
    /// </summary>
    [ThreadStatic]
    private static bool _recording;

    /// <summary>Records a measurement. A throwing <c>MeterListener</c> must never break delivery or reach the host.</summary>
    public static void Record(Counter<long>? counter, long value)
    {
        if (counter is null || _recording)
        {
            return;
        }

        _recording = true;
        try
        {
            counter.Add(value);
        }
        catch
        {
            // Telemetry is best effort.
        }
        finally
        {
            _recording = false;
        }
    }

    /// <summary>Records a dropped event with its reason tag.</summary>
    public static void RecordDropped(DropReason reason)
    {
        if (Dropped is null || _recording)
        {
            return;
        }

        _recording = true;
        try
        {
            Dropped.Add(1, Reason(reason));
        }
        catch
        {
            // Telemetry is best effort.
        }
        finally
        {
            _recording = false;
        }
    }

    /// <summary>Changes the queue length gauge.</summary>
    public static void RecordQueueLength(long delta)
    {
        if (delta == 0 || QueueLength is null || _recording)
        {
            return;
        }

        _recording = true;
        try
        {
            QueueLength.Add(delta);
        }
        catch
        {
            // Telemetry is best effort.
        }
        finally
        {
            _recording = false;
        }
    }

    public static KeyValuePair<string, object?> Reason(DropReason reason) => new("reason", ReasonName(reason));

    private static Counter<long>? Counter(string name, string unit, string description)
        => Create(() => Meter?.CreateCounter<long>(name, unit, description));

    private static T? Create<T>(Func<T?> create)
        where T : class
    {
        try
        {
            return create();
        }
        catch
        {
            // A listener threw while the instrument was published: run without this instrument.
            return null;
        }
    }

    private static string ReasonName(DropReason reason) => reason switch
    {
        DropReason.QueueFull => "queue_full",
        DropReason.Rejected => "rejected",
        DropReason.HttpError => "http_error",
        DropReason.TooLarge => "too_large",
        DropReason.Shutdown => "shutdown",
        DropReason.InvalidEntityId => "invalid_entity_id",
        _ => "invalid",
    };
}
