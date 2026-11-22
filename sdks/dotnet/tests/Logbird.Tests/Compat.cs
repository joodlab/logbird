#if NETFRAMEWORK
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Logbird.Tests.Compat;

internal static class HttpContentCompat
{
    public static Task<byte[]> ReadAsByteArrayAsync(this HttpContent content, CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        return content.ReadAsByteArrayAsync();
    }
}
#endif
