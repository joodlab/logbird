using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using Logbird.Internal;

namespace Logbird;

/// <summary>Sort order for search results.</summary>
public enum SortOrder
{
    /// <summary>Newest first (the default).</summary>
    Descending = 0,

    /// <summary>Oldest first.</summary>
    Ascending = 1,
}

/// <summary>A search over stored events. Every property is optional.</summary>
public sealed record EventSearch
{
    /// <summary>The start of the time range (inclusive). Defaults to the server's default range.</summary>
    public DateTimeOffset? From { get; init; }

    /// <summary>The end of the time range.</summary>
    public DateTimeOffset? To { get; init; }

    /// <summary>
    /// A Logbird query, for example <c>action:invoice.* actor:user_42 -outcome:success</c>.
    /// See the query language reference in the Logbird docs.
    /// </summary>
    public string? Query { get; init; }

    /// <summary>The cursor from a previous <see cref="EventPage.NextCursor"/>.</summary>
    public string? Cursor { get; init; }

    /// <summary>Events per page, 1 to 200. Defaults to 50.</summary>
    public int? Limit { get; init; }

    /// <summary>The sort order. Defaults to newest first.</summary>
    public SortOrder? Order { get; init; }

    /// <summary>
    /// Builds the search for one record's or person's history, quoting every value so it cannot change the query.
    /// Equivalent to the TypeScript SDK's <c>trailQuery</c>.
    /// </summary>
    /// <param name="targetId">Only events that affected this record id.</param>
    /// <param name="targetType">Only targets of this type (used together with <paramref name="targetId"/>).</param>
    /// <param name="actorId">Only events caused by this actor id.</param>
    /// <param name="tenantId">Only events in this tenant.</param>
    /// <param name="query">An extra Logbird query, combined with AND.</param>
    /// <param name="from">The start of the range.</param>
    /// <param name="to">The end of the range.</param>
    /// <param name="limit">Events per page.</param>
    /// <param name="cursor">A cursor from a previous page.</param>
    /// <remarks>A search filter is not authorization: check that the caller may see this record or tenant first.</remarks>
    public static EventSearch ForTrail(
        string? targetId = null,
        string? targetType = null,
        string? actorId = null,
        string? tenantId = null,
        string? query = null,
        DateTimeOffset? from = null,
        DateTimeOffset? to = null,
        int? limit = null,
        string? cursor = null)
    {
        var terms = new List<string>();
        if (!string.IsNullOrEmpty(query))
        {
            terms.Add("(" + query + ")");
        }

        if (!string.IsNullOrEmpty(targetId))
        {
            terms.Add("target:" + Quote(targetId!));
            if (!string.IsNullOrEmpty(targetType))
            {
                terms.Add("target.type:" + Quote(targetType!));
            }
        }

        if (!string.IsNullOrEmpty(actorId))
        {
            terms.Add("actor:" + Quote(actorId!));
        }

        if (!string.IsNullOrEmpty(tenantId))
        {
            terms.Add("tenant:" + Quote(tenantId!));
        }

        return new EventSearch
        {
            Query = string.Join(" AND ", terms),
            From = from,
            To = to,
            Limit = limit,
            Cursor = cursor,
        };
    }

    /// <summary>Quotes a value for the query language exactly like JavaScript's <c>JSON.stringify</c>.</summary>
    /// <param name="value">The raw value.</param>
    public static string Quote(string value)
    {
        Guard.NotNull(value, nameof(value));
        var builder = new StringBuilder(value.Length + 2);
        builder.Append('"');
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            switch (c)
            {
                case '"': builder.Append("\\\""); break;
                case '\\': builder.Append("\\\\"); break;
                case '\b': builder.Append("\\b"); break;
                case '\f': builder.Append("\\f"); break;
                case '\n': builder.Append("\\n"); break;
                case '\r': builder.Append("\\r"); break;
                case '\t': builder.Append("\\t"); break;
                default:
                    var lone = (char.IsHighSurrogate(c) && (i + 1 >= value.Length || !char.IsLowSurrogate(value[i + 1])))
                        || (char.IsLowSurrogate(c) && (i == 0 || !char.IsHighSurrogate(value[i - 1])));
                    if (c < 0x20 || lone)
                    {
                        builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        builder.Append(c);
                    }

                    break;
            }
        }

        return builder.Append('"').ToString();
    }

    internal string ToQueryString()
    {
        var parts = new List<string>();
        void Add(string key, string? value)
        {
            if (value is not null)
            {
                parts.Add(key + "=" + Uri.EscapeDataString(value));
            }
        }

        Add("from", From is { } from ? EventJson.FormatTimestamp(from) : null);
        Add("to", To is { } to ? EventJson.FormatTimestamp(to) : null);
        Add("q", Query);
        Add("cursor", Cursor);
        Add("limit", Limit?.ToString(CultureInfo.InvariantCulture));
        Add("order", Order switch
        {
            SortOrder.Ascending => "asc",
            SortOrder.Descending => "desc",
            _ => null,
        });
        return parts.Count == 0 ? string.Empty : "?" + string.Join("&", parts);
    }
}
