using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Internal;

/// <summary>
/// Runs host callbacks (<c>OnDrop</c>, <c>OnError</c>, logging) in order on the thread pool, never on the thread that
/// called <c>Track</c> or on the shutdown path, so a slow or blocking callback cannot hold either. The backlog is
/// bounded: past <see cref="_capacity"/> pending notifications, new ones are skipped and counted (the client's
/// counters still record every drop). No thread is held while idle.
/// </summary>
internal sealed class Notifier(int capacity, Action<int> lost)
{
    private readonly int _capacity = capacity;
    private readonly ConcurrentQueue<Action> _pending = new();
    private readonly object _waitersGate = new();
    private readonly List<(long Target, TaskCompletionSource<bool> Completion)> _waiters = [];
    private int _count;
    private int _running;
    private long _posted;
    private long _completed;

    /// <summary>The number of notifications posted so far (accepted or skipped).</summary>
    public long Posted => Interlocked.Read(ref _posted);

    public void Post(Action notification)
    {
        if (Interlocked.Increment(ref _count) > _capacity)
        {
            Interlocked.Decrement(ref _count);
            Interlocked.Increment(ref _posted);
            Interlocked.Increment(ref _completed);
            lost(1);
            return;
        }

        Interlocked.Increment(ref _posted);
        _pending.Enqueue(notification);
        if (Interlocked.CompareExchange(ref _running, 1, 0) == 0)
        {
            // The caller's ambient state (AsyncLocals, culture) must not leak into host callbacks.
            using (ExecutionContext.SuppressFlow())
            {
                _ = Task.Run(Drain);
            }
        }
    }

    /// <summary>Waits until every notification posted before the call has run, or the token is cancelled.</summary>
    public Task WaitAsync(CancellationToken cancellationToken)
    {
        var target = Interlocked.Read(ref _posted);
        if (Interlocked.Read(ref _completed) >= target)
        {
            return Task.CompletedTask;
        }

        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (_waitersGate)
        {
            _waiters.Add((target, completion));
        }

        // The drain may have finished between the check and the registration.
        Release();
        if (!cancellationToken.CanBeCanceled)
        {
            return completion.Task;
        }

        var registration = cancellationToken.Register(() => completion.TrySetResult(false));
        return completion.Task.ContinueWith(
            _ => registration.Dispose(),
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private void Drain()
    {
        while (true)
        {
            while (_pending.TryDequeue(out var notification))
            {
                try
                {
                    notification();
                }
                catch
                {
                    // A diagnostic hook must never break capture.
                }

                Interlocked.Decrement(ref _count);
                Interlocked.Increment(ref _completed);
                Release();
            }

            Volatile.Write(ref _running, 0);
            if (_pending.IsEmpty || Interlocked.CompareExchange(ref _running, 1, 0) != 0)
            {
                return;
            }
        }
    }

    private void Release()
    {
        var completed = Interlocked.Read(ref _completed);
        List<TaskCompletionSource<bool>>? done = null;
        lock (_waitersGate)
        {
            for (var i = _waiters.Count - 1; i >= 0; i--)
            {
                if (_waiters[i].Target <= completed)
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
