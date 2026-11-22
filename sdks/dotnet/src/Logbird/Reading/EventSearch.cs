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
    /// </summary>
    /// <param name="targetId">Only events with a target of this id (of any type).</param>
    /// <param name="actorId">Only events caused by this actor id.</param>
    /// <param name="tenantId">Only events in this tenant.</param>
    /// <param name="query">An extra Logbird query, combined with AND.</param>
    /// <param name="from">The start of the range.</param>
    /// <param name="to">The end of the range.</param>
    /// <param name="limit">Events per page.</param>
    /// <param name="cursor">A cursor from a previous page.</param>
    /// <remarks>
    /// <para>A search filter is not authorization: check that the caller may see this record or tenant first.</para>
    /// <para>A trail needs at least one selector or a query. Selectors must not be empty, end with <c>*</c> (the query
    /// language reads that as a prefix wildcard) or contain a lone surrogate. To combine a target's type and id on the
    /// same target, use the <c>record:</c> query field once your server supports it.</para>
    /// </remarks>
    public static EventSearch ForTrail(
        string? targetId = null,
        string? actorId = null,
        string? tenantId = null,
        string? query = null,
        DateTimeOffset? from = null,
        DateTimeOffset? to = null,
        int? limit = null,
        string? cursor = null)
    {
        CheckSelector(targetId, nameof(targetId));
        CheckSelector(actorId, nameof(actorId));
        CheckSelector(tenantId, nameof(tenantId));
        if (targetId is null && actorId is null && tenantId is null && string.IsNullOrWhiteSpace(query))
        {
            throw new ArgumentException("A trail needs a target, actor, tenant or query; an empty trail would be the whole project.");
        }

        var terms = new List<string>();
        if (!string.IsNullOrWhiteSpace(query))
        {
            terms.Add("(" + query + ")");
        }

        if (targetId is not null)
        {
            terms.Add("target:" + Quote(targetId));
        }

        if (actorId is not null)
        {
            terms.Add("actor:" + Quote(actorId));
        }

        if (tenantId is not null)
        {
            terms.Add("tenant:" + Quote(tenantId));
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

    /// <summary>
    /// Quotes a value for the Logbird query language: inside double quotes, a backslash makes the next character
    /// literal, so only <c>"</c> and <c>\</c> are escaped and everything else (tabs, newlines, Unicode) stays as it is.
    /// </summary>
    /// <param name="value">The raw value.</param>
    public static string Quote(string value)
    {
        Guard.NotNull(value, nameof(value));
        var builder = new System.Text.StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (var c in value)
        {
            if (c is '"' or '\\')
            {
                builder.Append('\\');
            }

            builder.Append(c);
        }

        return builder.Append('"').ToString();
    }

    // An empty selector would silently widen a history search to the whole project; treat it as a caller bug.
    private static void CheckSelector(string? value, string name)
    {
        if (value is null)
        {
            return;
        }

        if (value.Length == 0)
        {
            throw new ArgumentException("A trail selector must not be empty; pass null to leave it out.", name);
        }

        // The query language reads a trailing * as a prefix wildcard, even inside quotes, and has no escape for it.
        if (value[value.Length - 1] == '*')
        {
            throw new ArgumentException("A trail selector must not end with '*': Logbird would read it as a prefix wildcard.", name);
        }

        for (var i = 0; i < value.Length; i++)
        {
            if (char.IsHighSurrogate(value[i]) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                i++;
            }
            else if (char.IsSurrogate(value[i]))
            {
                throw new ArgumentException("A trail selector must not contain a lone surrogate.", name);
            }
        }
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
