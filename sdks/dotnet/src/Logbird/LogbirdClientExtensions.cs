using System;
using System.Threading;
using System.Threading.Tasks;
using Logbird.Internal;

namespace Logbird;

/// <summary>Flush helpers for hosts without a generic host, such as console apps and .NET Framework services.</summary>
public static class LogbirdClientExtensions
{
    /// <summary>
    /// Sends everything queued so far, waiting at most <paramref name="timeout"/>. Returns <see langword="true"/> when
    /// everything queued before the call was stored or permanently settled. Never throws.
    /// </summary>
    /// <param name="client">The client.</param>
    /// <param name="timeout">The longest to wait.</param>
    public static async Task<bool> FlushAsync(this ILogbirdClient client, TimeSpan timeout)
    {
        Guard.NotNull(client, nameof(client));
        if (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan)
        {
            return false;
        }

        using var cancellation = new CancellationTokenSource(timeout);
        return await client.FlushAsync(cancellation.Token).ConfigureAwait(false);
    }

    /// <summary>
    /// Blocking version of <see cref="FlushAsync(ILogbirdClient, TimeSpan)"/>. The deadline starts on the calling
    /// thread and the wait never exceeds it, even when the thread pool is busy. Safe on threads with a synchronization
    /// context (WinForms, WPF, classic ASP.NET). Returns <see langword="false"/> when called from Logbird's own
    /// callbacks, where waiting would wait on itself. Never throws.
    /// </summary>
    /// <param name="client">The client.</param>
    /// <param name="timeout">The longest to wait.</param>
    public static bool Flush(this ILogbirdClient client, TimeSpan timeout)
    {
        Guard.NotNull(client, nameof(client));
        if (LogbirdClient.IsInsideDelivery || (timeout < TimeSpan.Zero && timeout != Timeout.InfiniteTimeSpan))
        {
            return false;
        }

        try
        {
            using var cancellation = new CancellationTokenSource(timeout);
            var flush = Task.Run(() => client.FlushAsync(cancellation.Token), cancellation.Token);
            return flush.Wait(timeout) && flush.Result;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
