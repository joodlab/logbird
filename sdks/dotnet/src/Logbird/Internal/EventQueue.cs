using System;
using System.Collections.Generic;

namespace Logbird.Internal;

/// <summary>A serialized event waiting to be sent. The JSON is fixed at Track time so retries are byte-identical.</summary>
internal sealed class QueuedEvent(byte[] json, string id, string action, long sequence)
{
    public byte[] Json { get; } = json;

    /// <summary>The id exactly as sent, before trimming.</summary>
    public string Id { get; } = id;

    public string Action { get; } = action;

    public long Sequence { get; } = sequence;
}

/// <summary>
/// A bounded double-ended queue guarded by one lock. Failed batches go back to the front so order is kept; when the
/// queue is over capacity the configured behaviour picks the victim, exactly like the TypeScript SDK.
/// </summary>
internal sealed class EventQueue(int capacity, QueueFullBehavior behavior)
{
    private readonly object _gate = new();
    private QueuedEvent?[] _items = new QueuedEvent?[Math.Min(capacity, 256)];
    private int _head;
    private int _count;
    private long _nextSequence;

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

    /// <summary>The highest sequence assigned so far (0 when nothing was ever queued).</summary>
    public long LastSequence
    {
        get
        {
            lock (_gate)
            {
                return _nextSequence;
            }
        }
    }

    /// <summary>The sequence of the oldest queued event, or <see cref="long.MaxValue"/> when empty.</summary>
    public long HeadSequence
    {
        get
        {
            lock (_gate)
            {
                return _count == 0 ? long.MaxValue : _items[_head]!.Sequence;
            }
        }
    }

    /// <summary>Adds an event. Returns the dropped event when the queue was full (possibly the new one), else null.</summary>
    public QueuedEvent? Enqueue(Func<long, QueuedEvent> create, out QueuedEvent? added, out int countAfter)
    {
        lock (_gate)
        {
            QueuedEvent? dropped = null;
            if (_count >= capacity)
            {
                if (behavior == QueueFullBehavior.DropNewest)
                {
                    added = null;
                    countAfter = _count;
                    return create(0);
                }

                dropped = RemoveFirst();
            }

            var item = create(++_nextSequence);
            AddLast(item);
            added = item;
            countAfter = _count;
            return dropped;
        }
    }

    /// <summary>Removes up to <paramref name="maxCount"/> events whose total size stays below <paramref name="maxBytes"/>.</summary>
    public QueuedEvent[] TakeBatch(int maxCount, int maxBytes)
    {
        lock (_gate)
        {
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

            return [.. batch];
        }
    }

    /// <summary>Puts unsent events back at the front, then trims to capacity. Returns the events that no longer fit.</summary>
    public List<QueuedEvent> RequeueFront(IReadOnlyList<QueuedEvent> events)
    {
        var dropped = new List<QueuedEvent>();
        lock (_gate)
        {
            for (var i = events.Count - 1; i >= 0; i--)
            {
                AddFirst(events[i]);
            }

            while (_count > capacity)
            {
                dropped.Add(behavior == QueueFullBehavior.DropNewest ? RemoveLast() : RemoveFirst());
            }
        }

        return dropped;
    }

    /// <summary>Empties the queue, returning what was left.</summary>
    public List<QueuedEvent> Clear()
    {
        lock (_gate)
        {
            var all = new List<QueuedEvent>(_count);
            while (_count > 0)
            {
                all.Add(RemoveFirst());
            }

            return all;
        }
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
