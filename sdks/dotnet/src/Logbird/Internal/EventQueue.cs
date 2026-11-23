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
    /// <see cref="Pending"/> until exactly one party settles the event: the sender (stored, rejected or dropped), the
    /// queue (evicted) or shutdown (abandoned and reported). Changed only with <see cref="TrySettle"/> or <see cref="TryAbandon"/>.
    /// </summary>
    private int _state;

    public byte[] Json { get; } = json;

    /// <summary>The id exactly as sent, before trimming.</summary>
    public string Id { get; } = id;

    public string Action { get; } = action;

    public long Sequence { get; } = sequence;

    public bool IsPending => Volatile.Read(ref _state) == Pending;

    public bool IsAbandoned => Volatile.Read(ref _state) == Abandoned;

    public bool TrySettle() => Interlocked.CompareExchange(ref _state, Settled, Pending) == Pending;

    /// <summary>
    /// Shutdown takes the event. Decided under the same lock as <see cref="TryStartDispatch"/>, so either the event is
    /// dispatched and then abandoned (it may be stored) or abandoned and never dispatched; <see cref="MayBeStoredWhenAbandoned"/>
    /// keeps the value at that moment, whatever a later answer says.
    /// </summary>
    public bool TryAbandon()
    {
        lock (_wire)
        {
            if (Interlocked.CompareExchange(ref _state, Abandoned, Pending) != Pending)
            {
                return false;
            }

            _mayBeStoredWhenAbandoned = _mayBeStored;
            return true;
        }
    }

    // Whether the server may already hold this event: set when a request carrying it is dispatched, cleared by an answer
    // that says it was not stored, unless an earlier request carrying it ended without an answer (then it stays set).
    private readonly object _wire = new();
    private bool _mayBeStored;
    private bool _answerLost;
    private bool _mayBeStoredWhenAbandoned;
    private int _dispatches;

    /// <summary>True when the event was put on the wire at least once and no answer settled it, so the server may have stored it.</summary>
    public bool MayBeStored
    {
        get
        {
            lock (_wire)
            {
                return _mayBeStored;
            }
        }
    }

    /// <summary>True when an earlier request carrying this event ended without an answer.</summary>
    public bool AnswerLost
    {
        get
        {
            lock (_wire)
            {
                return _answerLost;
            }
        }
    }

    /// <summary>The value of <see cref="MayBeStored"/> when shutdown took the event.</summary>
    public bool MayBeStoredWhenAbandoned
    {
        get
        {
            lock (_wire)
            {
                return _mayBeStoredWhenAbandoned;
            }
        }
    }

    /// <summary>
    /// A request carrying this event is about to be dispatched. Returns false, and changes nothing, when shutdown took the
    /// event: it must then be left out of the request. Otherwise returns the dispatch number, which the answer to this
    /// request must quote. An event already settled may stay in a resent body unchanged.
    /// </summary>
    public bool TryStartDispatch(out int dispatch)
    {
        lock (_wire)
        {
            dispatch = 0;
            if (Volatile.Read(ref _state) == Abandoned)
            {
                return false;
            }

            _mayBeStored = true;
            dispatch = ++_dispatches;
            return true;
        }
    }

    /// <summary>
    /// The server answered request number <paramref name="dispatch"/> without storing this event (a 4xx such as 429 or
    /// 401). An answer to an older request (one that arrives after a retry was dispatched) changes nothing: the newer
    /// request may still store the event.
    /// </summary>
    public void OnNotStored(int dispatch)
    {
        lock (_wire)
        {
            if (!_answerLost && dispatch == _dispatches)
            {
                _mayBeStored = false;
            }
        }
    }

    /// <summary>That request ended without an answer that settles this event (a network error, a 5xx, a redirect, an unacknowledged 2xx).</summary>
    public void OnAnswerLost()
    {
        lock (_wire)
        {
            _answerLost = true;
        }
    }
}

/// <summary>One flush target, shared by every caller waiting for the same events.</summary>
internal sealed class FlushWaiter(long target)
{
    /// <summary>The highest sequence this waiter covers; only raised, under the queue lock.</summary>
    public long Target { get; set; } = target;

    public TaskCompletionSource<bool> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Callers still waiting; guarded by the queue lock.</summary>
    public int Callers { get; set; } = 1;
}

/// <summary>
/// The client's queue, its in-flight batch and its flush waiters, all guarded by one lock so that "is everything
/// queued before this flush settled and accounted for?" is always answered from a consistent snapshot. Evictions are
/// accounted (counted and their notification posted) inside the lock, so no flush can complete before that. Failed
/// batches go back to the front so order is kept; when the queue is over capacity the configured behaviour picks the
/// victim, exactly like the TypeScript SDK. After <see cref="Abandon"/> (shutdown deadline) nothing is accepted or requeued.
/// </summary>
internal sealed class EventQueue(int capacity, QueueFullBehavior behavior, Action<QueuedEvent> evicted)
{
    private readonly object _gate = new();
    internal const int MaxWaiters = 1_024;

    private readonly List<FlushWaiter> _waiters = [];
    private QueuedEvent?[] _items = new QueuedEvent?[Math.Min(capacity, 256)];
    private QueuedEvent[]? _inFlight;
    private int _head;
    private int _count;
    private long _nextSequence;
    private bool _abandoned;
    private bool _abandonReported;

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

    /// <summary>
    /// Adds an event. With <see cref="QueueFullBehavior.DropOldest"/> a full queue evicts its oldest event, accounted
    /// inside the lock. Returns the new event when it was not queued (queue full with DropNewest, or shut down).
    /// </summary>
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

            if (_count >= capacity)
            {
                Evict(RemoveFirst());
            }

            var item = create(++_nextSequence);
            AddLast(item);
            added = item;
            countAfter = _count;
            return null;
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
    /// Ends the in-flight batch, putting <paramref name="unsettled"/> events back at the front and evicting what no longer
    /// fits (accounted inside the lock). Returns false when shutdown has taken ownership of the batch (ignore the result).
    /// </summary>
    public bool FinishBatch(IReadOnlyList<QueuedEvent> unsettled, out int evictedCount)
    {
        evictedCount = 0;
        lock (_gate)
        {
            _inFlight = null;
            if (_abandoned)
            {
                return false;
            }

            for (var i = unsettled.Count - 1; i >= 0; i--)
            {
                if (unsettled[i].IsPending)
                {
                    AddFirst(unsettled[i]);
                }
            }

            while (_count > capacity)
            {
                Evict(behavior == QueueFullBehavior.DropNewest ? RemoveLast() : RemoveFirst());
                evictedCount++;
            }

            return true;
        }
    }

    /// <summary>
    /// Settles an event and counts it in one step under the queue lock, the lock flush waiters are added and completed
    /// under, so no flush can see the event settled before it is counted. <paramref name="count"/> runs under that lock: it
    /// may update counters and post a prepared notification to the notifier (which only takes the notifier's own lock and
    /// never runs host code inline), and must do nothing else. Returns false when the event was already settled or
    /// abandoned.
    /// </summary>
    public bool Settle(QueuedEvent item, Action count)
    {
        lock (_gate)
        {
            if (!item.TrySettle())
            {
                return false;
            }

            count();
            return true;
        }
    }

    /// <summary>
    /// Registers a flush for everything queued so far, sharing the waiter of a caller with the same target. Returns null
    /// when nothing queued before now is outstanding.
    /// </summary>
    public FlushWaiter? AddWaiter()
    {
        lock (_gate)
        {
            var target = _nextSequence;

            // While shutdown is reporting abandoned events, every flush waits for that report.
            if (!(_abandoned && !_abandonReported) && MinOutstanding() > target)
            {
                return null;
            }

            // Callers waiting for the same events share a waiter. Past MaxWaiters, a new caller joins the newest waiter and
            // raises its target: its callers may wait a little longer, which is still correct, and the list stays bounded.
            if (_waiters.Count > 0 && (_waiters[_waiters.Count - 1].Target == target || _waiters.Count >= MaxWaiters))
            {
                var shared = _waiters[_waiters.Count - 1];
                shared.Target = Math.Max(shared.Target, target);
                shared.Callers++;
                return shared;
            }

            var waiter = new FlushWaiter(target);
            _waiters.Add(waiter);
            return waiter;
        }
    }

    /// <summary>One caller stopped waiting; the waiter is forgotten (completed with false) when no caller is left.</summary>
    public void ReleaseWaiter(FlushWaiter waiter)
    {
        lock (_gate)
        {
            if (--waiter.Callers > 0 || !_waiters.Remove(waiter))
            {
                return;
            }
        }

        waiter.Completion.TrySetResult(false);
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

    /// <summary>
    /// Shutdown deadline: stops accepting and requeueing, detaches the in-flight batch, and abandons every event that is
    /// still pending, all under the lock. Each existing flush is decided before anything is abandoned. Flushes that arrive
    /// until <see cref="FinishAbandon"/> wait for the abandoned events to be reported.
    /// </summary>
    public (List<QueuedEvent> Queued, List<QueuedEvent> InFlight, List<(FlushWaiter Waiter, bool Result)> Waiters) Abandon()
    {
        lock (_gate)
        {
            var min = MinOutstanding();
            var waiters = new List<(FlushWaiter Waiter, bool Result)>(_waiters.Count);
            foreach (var waiter in _waiters)
            {
                waiters.Add((waiter, waiter.Target < min));
            }

            _waiters.Clear();
            if (!_abandoned)
            {
                _abandoned = true;
                _abandonReported = false;
            }

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

            return (queued, inFlight, waiters);
        }
    }

    /// <summary>The abandoned events have been reported: complete the flushes that arrived meanwhile.</summary>
    public void FinishAbandon(bool anyAbandoned)
    {
        List<FlushWaiter> done;
        lock (_gate)
        {
            _abandonReported = true;
            done = [.. _waiters];
            _waiters.Clear();
        }

        // These flushes arrived while events were being abandoned: they succeed only if nothing was abandoned.
        foreach (var waiter in done)
        {
            waiter.Completion.TrySetResult(!anyAbandoned);
        }
    }

    private void Evict(QueuedEvent item)
    {
        if (item.TrySettle())
        {
            // Counting and posting the notification never run host code, so this is safe under the lock.
            evicted(item);
        }
    }

    private void Complete(bool failOutstanding, bool outstandingResult)
    {
        // Decided and published under the lock (continuations run asynchronously, so no caller code runs here): no
        // completion can land after Abandon has started reporting.
        lock (_gate)
        {
            // While shutdown is reporting abandoned events, nothing completes: those flushes wait for the report.
            if (_abandoned && !_abandonReported)
            {
                return;
            }

            var min = MinOutstanding();
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                var settled = _waiters[i].Target < min;
                if (settled || failOutstanding)
                {
                    _waiters[i].Completion.TrySetResult(settled || outstandingResult);
                    _waiters.RemoveAt(i);
                }
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
