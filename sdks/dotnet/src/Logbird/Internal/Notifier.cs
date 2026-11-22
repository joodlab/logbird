using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Internal;

/// <summary>
/// Runs host callbacks (<c>OnDrop</c>, <c>OnError</c>, logging) in order on the thread pool, never on the thread that
/// called <c>Track</c> or on the shutdown path, so a slow or blocking callback cannot hold either. The backlog is
/// bounded: past the capacity, new notifications are skipped and counted (the client's counters still record every
/// drop). No thread is held while idle.
/// </summary>
internal sealed class Notifier(int capacity, Action<int> lost, Action failed)
{
    private readonly object _gate = new();
    private readonly Queue<Action> _pending = new();
    private readonly List<Entry> _waiters = [];
    private bool _running;
    private long _accepted;
    private long _completed;

    public void Post(Action notification)
    {
        bool accepted;
        var start = false;
        lock (_gate)
        {
            accepted = _pending.Count < capacity;
            if (accepted)
            {
                _pending.Enqueue(notification);
                _accepted++;
                start = !_running;
                _running = true;
            }
        }

        if (!accepted)
        {
            lost(1);
        }
        else if (start)
        {
            Start();
        }
    }

    /// <summary>
    /// Waits until every notification accepted before the call has run (skipped ones never count), or the token is
    /// cancelled. Callers waiting for the same point share one entry; a cancelled caller releases only its own share.
    /// </summary>
    public async Task WaitAsync(CancellationToken cancellationToken)
    {
        Entry entry;
        lock (_gate)
        {
            if (_completed >= _accepted)
            {
                return;
            }

            if (_waiters.Count > 0 && _waiters[_waiters.Count - 1].Target == _accepted)
            {
                entry = _waiters[_waiters.Count - 1];
                entry.Callers++;
            }
            else
            {
                entry = new Entry(_accepted);
                _waiters.Add(entry);
            }
        }

        if (!cancellationToken.CanBeCanceled)
        {
            await entry.Completion.Task.ConfigureAwait(false);
            return;
        }

        var cancelled = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using (cancellationToken.Register(() => cancelled.TrySetResult(false)))
        {
            if (await Task.WhenAny(entry.Completion.Task, cancelled.Task).ConfigureAwait(false) == entry.Completion.Task)
            {
                return;
            }
        }

        lock (_gate)
        {
            if (--entry.Callers == 0)
            {
                _waiters.Remove(entry);
            }
        }
    }

    private void Start()
    {
        try
        {
            // Unsafe: the caller's execution context (AsyncLocals, culture, a suppressed flow) never reaches host
            // callbacks, and there is nothing to suppress or restore.
            ThreadPool.UnsafeQueueUserWorkItem(_ => Drain(), null);
        }
        catch
        {
            lock (_gate)
            {
                _running = false;
            }
        }
    }

    private void Drain()
    {
        while (true)
        {
            Action notification;
            lock (_gate)
            {
                if (_pending.Count == 0)
                {
                    _running = false;
                    return;
                }

                notification = _pending.Dequeue();
            }

            try
            {
                notification();
            }
            catch
            {
                // A diagnostic hook must never break capture: swallow and count.
                try
                {
                    failed();
                }
                catch
                {
                    // Counting is best effort.
                }
            }

            List<TaskCompletionSource<bool>>? done = null;
            lock (_gate)
            {
                _completed++;
                for (var i = _waiters.Count - 1; i >= 0; i--)
                {
                    if (_waiters[i].Target <= _completed)
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
                    completion.TrySetResult(true);
                }
            }
        }
    }

    private sealed class Entry(long target)
    {
        public long Target { get; } = target;

        public TaskCompletionSource<bool> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Callers { get; set; } = 1;
    }
}
