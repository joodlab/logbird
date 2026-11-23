using System;
using System.Threading.Tasks;

namespace Logbird.Tests;

/// <summary>Runs an operation that must not block on its own task, so a hang fails the test instead of stalling it.</summary>
internal static class Deadline
{
    public static async Task Within(TimeSpan limit, Func<Task> operation)
    {
        var task = Task.Run(operation);
        if (await Task.WhenAny(task, Task.Delay(limit)).ConfigureAwait(false) != task)
        {
            throw new TimeoutException("The operation did not finish within " + limit + ".");
        }

        await task.ConfigureAwait(false);
    }

    public static Task Within(TimeSpan limit, Action operation) => Within(limit, () =>
    {
        operation();
        return Task.CompletedTask;
    });
}
