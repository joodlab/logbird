using System;
using System.Collections.Generic;
using System.Diagnostics.Metrics;

namespace Logbird.Internal;

/// <summary>
/// OpenTelemetry-compatible instruments on the <c>Logbird</c> meter. They are all observable: a listener reads the
/// clients' counters when it collects, on its own thread. Nothing on the <c>Track</c>, delivery or shutdown paths ever
/// calls into listener code, so a listener that throws, blocks or records audit events cannot affect capture.
/// Creating an instrument does run listener code, so that is guarded too: a failure disables the instrument.
/// </summary>
internal static class LogbirdMetrics
{
    public const string MeterName = "Logbird";

    private static readonly object Gate = new();
    private static readonly List<WeakReference<LogbirdClient>> Clients = [];
    private static readonly Meter? Meter = Create(() => new Meter(MeterName, LogbirdClient.Version));

    // Kept alive by these fields; each callback sums over the live clients.
    private static readonly object?[] Instruments =
    [
        Counter("logbird.events.tracked", "{event}", "Events accepted into the in-memory queue.", s => s.Tracked),
        Counter("logbird.events.delivered", "{event}", "Events the server stored.", s => s.Delivered),
        Counter("logbird.events.rejected", "{event}", "Events the server rejected individually.", s => s.Rejected),
        Counter("logbird.events.filtered", "{event}", "Events skipped by BeforeSend.", s => s.Filtered),
        Counter("logbird.events.warned", "{warning}", "Warnings about events (identifier whitespace found before sending, server warnings about stored events).", s => s.Warnings),
        Counter("logbird.batches.failed", "{batch}", "Batches that failed after all retries and were queued again.", s => s.FailedSends),
        Create(() => Meter?.CreateObservableCounter("logbird.events.dropped", DroppedByReason, "{event}", "Events that will not be stored, by reason.")),
        Create(() => Meter?.CreateObservableCounter(
            "logbird.notifications.lost", () => Sum(client => client.NotificationsLost), "{notification}", "OnDrop/OnError notifications skipped because the callbacks fell too far behind.")),
        Create(() => Meter?.CreateObservableCounter(
            "logbird.callbacks.failed", () => Sum(client => client.CallbackFailures), "{exception}", "Exceptions thrown by OnDrop, OnError or a logger; each was swallowed.")),
        Create(() => Meter?.CreateObservableUpDownCounter("logbird.queue.length", () => Sum(client => client.Stats.QueueLength), "{event}", "Events waiting to be sent.")),
    ];

    public static void Register(LogbirdClient client)
    {
        lock (Gate)
        {
            Clients.Add(new WeakReference<LogbirdClient>(client));
        }
    }

    public static void Unregister(LogbirdClient client)
    {
        lock (Gate)
        {
            Clients.RemoveAll(reference => !reference.TryGetTarget(out var target) || ReferenceEquals(target, client));
        }
    }

    internal static string ReasonName(DropReason reason) => reason switch
    {
        DropReason.QueueFull => "queue_full",
        DropReason.Rejected => "rejected",
        DropReason.HttpError => "http_error",
        DropReason.TooLarge => "too_large",
        DropReason.Shutdown => "shutdown",
        DropReason.InvalidEntityId => "invalid_entity_id",
        DropReason.Unacknowledged => "unacknowledged",
        _ => "invalid",
    };

    private static ObservableCounter<long>? Counter(string name, string unit, string description, Func<LogbirdStats, long> read)
        => Create(() => Meter?.CreateObservableCounter(name, () => Sum(client => read(client.Stats)), unit, description));

    private static long Sum(Func<LogbirdClient, long> read)
    {
        long total = 0;
        foreach (var client in LiveClients())
        {
            total += read(client);
        }

        return total;
    }

    private static IEnumerable<Measurement<long>> DroppedByReason()
    {
        var totals = new long[LogbirdClient.DropReasonCount];
        foreach (var client in LiveClients())
        {
            client.AddDroppedByReason(totals);
        }

        var measurements = new List<Measurement<long>>();
        for (var i = 0; i < totals.Length; i++)
        {
            // Server rejections have their own instrument.
            if (totals[i] != 0 && (DropReason)i != DropReason.Rejected)
            {
                measurements.Add(new Measurement<long>(totals[i], new KeyValuePair<string, object?>("reason", ReasonName((DropReason)i))));
            }
        }

        return measurements;
    }

    private static List<LogbirdClient> LiveClients()
    {
        var live = new List<LogbirdClient>();
        lock (Gate)
        {
            Clients.RemoveAll(reference =>
            {
                if (!reference.TryGetTarget(out var client))
                {
                    return true;
                }

                live.Add(client);
                return false;
            });
        }

        return live;
    }

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
}
