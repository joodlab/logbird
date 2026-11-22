using System;

namespace Logbird.Internal;

/// <summary>Validation and route building shared by the ingest and read clients.</summary>
internal static class Endpoints
{
    /// <summary>
    /// Requires an absolute HTTPS origin (optionally with a path prefix). Plain HTTP is accepted only for loopback hosts
    /// or with <paramref name="allowInsecureHttp"/>, because every request carries a bearer key. Queries, fragments and
    /// user info are rejected so the route can never end up outside the path.
    /// </summary>
    public static void Validate(Uri? endpoint, bool allowInsecureHttp, string paramName)
    {
        if (endpoint is null || !endpoint.IsAbsoluteUri || (endpoint.Scheme != Uri.UriSchemeHttps && endpoint.Scheme != Uri.UriSchemeHttp))
        {
            throw new ArgumentException("Endpoint must be an absolute https URL, for example https://audit.example.com.", paramName);
        }

        if (endpoint.Scheme == Uri.UriSchemeHttp && !endpoint.IsLoopback && !allowInsecureHttp)
        {
            throw new ArgumentException(
                "Endpoint must use https: requests carry your Logbird key. Plain http is allowed for localhost, or set AllowInsecureHttp = true for a private network you trust.",
                paramName);
        }

        if (!string.IsNullOrEmpty(endpoint.Query) || !string.IsNullOrEmpty(endpoint.Fragment) || !string.IsNullOrEmpty(endpoint.UserInfo))
        {
            throw new ArgumentException("Endpoint must not contain a query, a fragment or credentials; use the Logbird origin, for example https://audit.example.com.", paramName);
        }
    }

    /// <summary>Appends <paramref name="route"/> to the endpoint's path, keeping a path prefix such as <c>/audit</c>.</summary>
    public static Uri Append(Uri endpoint, string route)
    {
        var builder = new UriBuilder(endpoint)
        {
            Path = endpoint.AbsolutePath.TrimEnd('/') + route,
            Query = string.Empty,
            Fragment = string.Empty,
        };
        return builder.Uri;
    }
}
