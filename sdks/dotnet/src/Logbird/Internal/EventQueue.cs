using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Internal;

/// <summary>A serialized event waiting to be sent. The JSON is fixed at Track time so retries are byte-identical.</summary>
internal sealed class QueuedEvent(byte[] json, string id, string action, long sequence)
{
    public const int Pending = 0;
    public const int Settled = 1;
    public const int Abandoned = 2;

    /// <summary>
    /// <see cref="Pending"/> until exactly one party settles the event: the sender (stored, rejected or dropped) or
    /// shutdown (abandoned and reported). Changed only with <see cref="TrySettle"/> or <see cref="TryAbandon"/>.
    /// </summary>
    private int _state;

    public byte[] Json { get; } = json;

    /// <summary>The id exactly as sent, before trimming.</summary>
    public string Id { get; } = id;

    public string Action { get; } = action;

    public long Sequence { get; } = sequence;

    public bool IsPending => Volatile.Read(ref _state) == Pending;

    public bool TrySettle() => Interlocked.CompareExchange(ref _state, Settled, Pending) == Pending;

    public bool TryAbandon() => Interlocked.CompareExchange(ref _state, Abandoned, Pending) == Pending;
}

/// <summary>
/// The client's queue, its in-flight batch and its flush waiters, all guarded by one lock so that "is everything
/// queued before this flush settled?" is always answered from a consistent snapshot. Failed batches go back to the
/// front so order is kept; when the queue is over capacity the configured behaviour picks the victim, exactly like the
/// TypeScript SDK. After <see cref="Abandon"/> (shutdown deadline) nothing is accepted or requeued again.
/// </summary>
internal sealed class EventQueue(int capacity, QueueFullBehavior behavior)
{
    private readonly object _gate = new();
    private readonly List<(long Target, TaskCompletionSource<bool> Completion)> _waiters = [];
    private QueuedEvent?[] _items = new QueuedEvent?[Math.Min(capacity, 256)];
    private QueuedEvent[]? _inFlight;
    private int _head;
    private int _count;
    private long _nextSequence;
    private bool _abandoned;

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _count;
            }
        }
    }

    /// <summary>Queued plus in-flight events.</summary>
    public int Outstanding
    {
        get
        {
            lock (_gate)
            {
                return _count + (_inFlight?.Length ?? 0);
            }
        }
    }

    /// <summary>Adds an event. Returns the dropped event when the queue was full (possibly the new one), else null.</summary>
    /// <param name="create">Creates the event for its sequence number.</param>
    /// <param name="added">The queued event, or null when the new event was not queued.</param>
    /// <param name="countAfter">The queue length afterwards.</param>
    /// <param name="shutDown">True when the queue no longer accepts events; the new event is then returned as dropped.</param>
    public QueuedEvent? Enqueue(Func<long, QueuedEvent> create, out QueuedEvent? added, out int countAfter, out bool shutDown)
    {
        lock (_gate)
        {
            shutDown = _abandoned;
            if (_abandoned || (_count >= capacity && behavior == QueueFullBehavior.DropNewest))
            {
                added = null;
                countAfter = _count;
                return create(0);
            }

            var dropped = _count >= capacity ? RemoveFirst() : null;
            var item = create(++_nextSequence);
            AddLast(item);
            added = item;
            countAfter = _count;
            return dropped;
        }
    }

    /// <summary>
    /// Removes up to <paramref name="maxCount"/> events whose total size stays below <paramref name="maxBytes"/> and
    /// marks them in flight until <see cref="FinishBatch"/>.
    /// </summary>
    public QueuedEvent[] TakeBatch(int maxCount, int maxBytes)
    {
        lock (_gate)
        {
            if (_abandoned)
            {
                return [];
            }

            var batch = new List<QueuedEvent>(Math.Min(maxCount, _count));
            long bytes = 32;
            while (_count > 0 && batch.Count < maxCount)
            {
                var next = _items[_head]!;
                var size = next.Json.Length + 1;
                if (batch.Count > 0 && bytes + size > maxBytes)
                {
                    break;
                }

                batch.Add(RemoveFirst());
                bytes += size;
            }

            _inFlight = batch.Count == 0 ? null : [.. batch];
            return _inFlight ?? [];
        }
    }

    /// <summary>
    /// Ends the in-flight batch, putting <paramref name="unsettled"/> events back at the front and trimming to capacity.
    /// Returns the events that no longer fit, or null when shutdown has taken ownership of the batch (ignore the result).
    /// </summary>
    public List<QueuedEvent>? FinishBatch(IReadOnlyList<QueuedEvent> unsettled)
    {
        lock (_gate)
        {
            _inFlight = null;
            if (_abandoned)
            {
                return null;
            }

            var dropped = new List<QueuedEvent>();
            for (var i = unsettled.Count - 1; i >= 0; i--)
            {
                if (unsettled[i].IsPending)
                {
                    AddFirst(unsettled[i]);
                }
            }

            while (_count > capacity)
            {
                dropped.Add(behavior == QueueFullBehavior.DropNewest ? RemoveLast() : RemoveFirst());
            }

            return dropped;
        }
    }

    /// <summary>
    /// Registers a flush for everything queued so far. Returns null when nothing queued before now is outstanding.
    /// </summary>
    public TaskCompletionSource<bool>? AddWaiter()
    {
        lock (_gate)
        {
            var target = _nextSequence;
            if (MinOutstanding() > target)
            {
                return null;
            }

            var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            if (_abandoned)
            {
                completion.TrySetResult(false);
                return completion;
            }

            _waiters.Add((target, completion));
            return completion;
        }
    }

    /// <summary>Completes (with true) every flush whose events are all settled; the others keep waiting.</summary>
    public void CompleteSatisfiedWaiters() => Complete(failOutstanding: false, outstandingResult: false);

    /// <summary>
    /// After a failed delivery: a flush whose events are all settled still succeeds; a flush with events still
    /// outstanding completes with false (they stay queued for a later attempt).
    /// </summary>
    public void CompleteWaitersAfterFailure() => Complete(failOutstanding: true, outstandingResult: false);

    /// <summary>Completes every flush: true when its events are settled, otherwise <paramref name="outstandingResult"/>.</summary>
    public void CompleteAllWaiters(bool outstandingResult) => Complete(failOutstanding: true, outstandingResult);

    /// <summary>Forgets a flush whose caller stopped waiting, so cancelled flushes do not accumulate.</summary>
    public void RemoveWaiter(TaskCompletionSource<bool> completion)
    {
        lock (_gate)
        {
            _waiters.RemoveAll(waiter => waiter.Completion == completion);
        }
    }

    /// <summary>
    /// Shutdown deadline: stops accepting and requeueing, detaches the in-flight batch, and abandons every event that is
    /// still pending, all under the lock so no flush can observe a half-abandoned state. Returns the abandoned events
    /// (an in-flight event already settled by a response is not included), split into queued and in-flight.
    /// </summary>
    public (List<QueuedEvent> Queued, List<QueuedEvent> InFlight) Abandon()
    {
        lock (_gate)
        {
            _abandoned = true;
            var inFlight = new List<QueuedEvent>();
            if (_inFlight is not null)
            {
                foreach (var item in _inFlight)
                {
                    if (item.TryAbandon())
                    {
                        inFlight.Add(item);
                    }
                }

                _inFlight = null;
            }

            var queued = new List<QueuedEvent>(_count);
            while (_count > 0)
            {
                var item = RemoveFirst();
                if (item.TryAbandon())
                {
                    queued.Add(item);
                }
            }

            return (queued, inFlight);
        }
    }

    private void Complete(bool failOutstanding, bool outstandingResult)
    {
        List<(TaskCompletionSource<bool> Completion, bool Result)>? done = null;
        lock (_gate)
        {
            var min = MinOutstanding();
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                var settled = _waiters[i].Target < min;
                if (settled || failOutstanding)
                {
                    (done ??= []).Add((_waiters[i].Completion, settled || outstandingResult));
                    _waiters.RemoveAt(i);
                }
            }
        }

        if (done is not null)
        {
            foreach (var (completion, result) in done)
            {
                completion.TrySetResult(result);
            }
        }
    }

    /// <summary>The lowest sequence still queued or in flight and pending; <see cref="long.MaxValue"/> when none. Call under the lock.</summary>
    private long MinOutstanding()
    {
        var min = _count == 0 ? long.MaxValue : _items[_head]!.Sequence;
        if (_inFlight is not null)
        {
            foreach (var item in _inFlight)
            {
                if (item.IsPending && item.Sequence < min)
                {
                    min = item.Sequence;
                }
            }
        }

        return min;
    }

    private void EnsureRoom()
    {
        if (_count < _items.Length)
        {
            return;
        }

        var larger = new QueuedEvent?[_items.Length * 2];
        for (var i = 0; i < _count; i++)
        {
            larger[i] = _items[(_head + i) % _items.Length];
        }

        _items = larger;
        _head = 0;
    }

    private void AddLast(QueuedEvent item)
    {
        EnsureRoom();
        _items[(_head + _count) % _items.Length] = item;
        _count++;
    }

    private void AddFirst(QueuedEvent item)
    {
        EnsureRoom();
        _head = (_head - 1 + _items.Length) % _items.Length;
        _items[_head] = item;
        _count++;
    }

    private QueuedEvent RemoveFirst()
    {
        var item = _items[_head]!;
        _items[_head] = null;
        _head = (_head + 1) % _items.Length;
        _count--;
        return item;
    }

    private QueuedEvent RemoveLast()
    {
        var index = (_head + _count - 1) % _items.Length;
        var item = _items[index]!;
        _items[index] = null;
        _count--;
        return item;
    }
}
