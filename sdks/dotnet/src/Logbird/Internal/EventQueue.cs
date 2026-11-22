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

    /// <summary>Completes (with true) every flush whose events are all settled.</summary>
    public void CompleteSatisfiedWaiters() => Complete(all: false, result: true);

    /// <summary>Completes every flush with <paramref name="result"/>.</summary>
    public void CompleteAllWaiters(bool result) => Complete(all: true, result);

    /// <summary>
    /// Shutdown deadline: stops accepting and requeueing, and returns every queued and in-flight event so the caller
    /// can report the ones it manages to abandon (an in-flight event may still be settled by a late response first).
    /// </summary>
    public List<QueuedEvent> Abandon()
    {
        lock (_gate)
        {
            _abandoned = true;
            var all = new List<QueuedEvent>(_count + (_inFlight?.Length ?? 0));
            if (_inFlight is not null)
            {
                all.AddRange(_inFlight);
            }

            while (_count > 0)
            {
                all.Add(RemoveFirst());
            }

            return all;
        }
    }

    private void Complete(bool all, bool result)
    {
        List<TaskCompletionSource<bool>>? done = null;
        lock (_gate)
        {
            var min = MinOutstanding();
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                if (all || _waiters[i].Target < min)
                {
                    (done ??= []).Add(_waiters[i].Completion);
                    _waiters.RemoveAt(i);
                }
            }
        }

        if (done is not null)
        {
            foreach (var completion in done)
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
