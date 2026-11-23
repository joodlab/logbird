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
    /// <summary>
    /// <c>ToString()</c> lists no values (queries name customers and records), so writing this object as text cannot leak them. A structured logger that serializes its properties still sees them.
    /// </summary>
#pragma warning disable CA1822 // The compiler-generated record ToString calls this instance member by name.
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        _ = builder;
        return false;
    }
#pragma warning restore CA1822

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
    /// Builds the search for one record's or person's history, quoting every value so it cannot change the query. The
    /// result is the same query the TypeScript SDK's <c>trailQuery</c> builds for the same input.
    /// </summary>
    /// <param name="targetId">Only events with a target of this id (of any type, unless <paramref name="targetType"/> is given).</param>
    /// <param name="actorId">Only events caused by this actor id.</param>
    /// <param name="tenantId">Only events in this tenant.</param>
    /// <param name="query">An extra Logbird query, combined with AND.</param>
    /// <param name="from">The start of the range.</param>
    /// <param name="to">The end of the range.</param>
    /// <param name="limit">Events per page.</param>
    /// <param name="cursor">A cursor from a previous page.</param>
    /// <param name="targetType">
    /// With <paramref name="targetId"/>: only events with a target of exactly this type and id together (the
    /// <c>record:</c> query field, Logbird 0.2.0 and later), rather than any target with that id.
    /// </param>
    /// <remarks>
    /// <para>A search filter is not authorization: check that the caller may see this record or tenant first.</para>
    /// <para>A trail needs at least one selector or a query. Selectors must not be empty or contain a lone surrogate;
    /// every other character, including <c>*</c>, quotes and line breaks, is matched literally. A trail with
    /// <paramref name="targetType"/>, or with a selector that ends in <c>*</c> or contains a carriage return, needs
    /// Logbird 0.2.0 or later (older servers read those differently); <see cref="LogbirdReadClient"/> checks the server's
    /// version before sending such a trail and fails instead of running a different search.</para>
    /// </remarks>
    public static EventSearch ForTrail(
        string? targetId = null,
        string? actorId = null,
        string? tenantId = null,
        string? query = null,
        DateTimeOffset? from = null,
        DateTimeOffset? to = null,
        int? limit = null,
        string? cursor = null,
        string? targetType = null)
    {
        CheckSelector(targetId, nameof(targetId));
        CheckSelector(targetType, nameof(targetType));
        if (targetType is not null && targetId is null)
        {
            throw new ArgumentException("A target type needs a target id: a record is a type and an id together.", nameof(targetType));
        }

        CheckSelector(actorId, nameof(actorId));
        CheckSelector(tenantId, nameof(tenantId));
        // Blank means what JavaScript's trim() removes, so a query is blank in exactly the cases trailQuery treats as blank.
        var blankQuery = query is null || Internal.EventJson.JsTrim(query).Length == 0;
        if (targetId is null && actorId is null && tenantId is null && blankQuery)
        {
            throw new ArgumentException("A trail needs a target, actor, tenant or query; an empty trail would be the whole project.");
        }

        var terms = new List<string>();
        if (!blankQuery)
        {
            terms.Add("(" + query + ")");
        }

        if (targetType is not null)
        {
            terms.Add("record:" + Quote(EncodeRecordPair(targetType, targetId!)));
        }
        else if (targetId is not null)
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
            NeedsServer020 = targetType is not null || NeedsLiteralEscapes(targetId) || NeedsLiteralEscapes(actorId) || NeedsLiteralEscapes(tenantId),
        };
    }

    /// <summary>The eight-parameter form from earlier releases, kept so compiled code and method groups keep working.</summary>
    /// <param name="targetId">Only events with a target of this id (of any type).</param>
    /// <param name="actorId">Only events caused by this actor id.</param>
    /// <param name="tenantId">Only events in this tenant.</param>
    /// <param name="query">An extra Logbird query, combined with AND.</param>
    /// <param name="from">The start of the range.</param>
    /// <param name="to">The end of the range.</param>
    /// <param name="limit">Events per page.</param>
    /// <param name="cursor">A cursor from a previous page.</param>
    public static EventSearch ForTrail(
        string? targetId,
        string? actorId,
        string? tenantId,
        string? query,
        DateTimeOffset? from,
        DateTimeOffset? to,
        int? limit,
        string? cursor)
        => ForTrail(targetId, actorId, tenantId, query, from, to, limit, cursor, targetType: null);

    /// <summary>
    /// Whether this search needs Logbird 0.2.0 or later: it uses <c>record:</c>, or escapes a trailing <c>*</c> or a
    /// carriage return that older servers read as a wildcard or a letter.
    /// </summary>
    internal bool NeedsServer020 { get; init; }

    // Older servers read an escaped trailing star as a prefix wildcard and \r as the letter r; interior stars were literal.
#pragma warning disable CA2249 // string.Contains(char) is not available on netstandard2.0.
    private static bool NeedsLiteralEscapes(string? value)
        => value is { Length: > 0 } && (value[value.Length - 1] == '*' || value.IndexOf('\r') >= 0);
#pragma warning restore CA2249

    /// <summary>
    /// Quotes an exact value for the Logbird query language, the same way the shared <c>quoteQueryValue</c> does:
    /// inside double quotes a backslash makes the next character literal, so <c>"</c>, <c>\</c> and <c>*</c> (which
    /// would otherwise end a value in a wildcard) are escaped, and a carriage return is written as <c>\r</c> so the
    /// text survives editors and the clipboard. Everything else (tabs, newlines, Unicode) stays as it is.
    /// </summary>
    /// <remarks>
    /// A value that contains a carriage return or ends in <c>*</c> is matched literally only by Logbird 0.2.0 and later;
    /// older servers read <c>\r</c> as the letter <c>r</c> and a trailing escaped <c>*</c> as a prefix wildcard.
    /// <see cref="ForTrail(string, string, string, string, DateTimeOffset?, DateTimeOffset?, int?, string, string)"/>
    /// marks such a search so <see cref="LogbirdReadClient"/> checks the server's version before sending it; a search
    /// you build yourself from <see cref="Quote"/> is sent without that check.
    /// </remarks>
    /// <param name="value">The raw value.</param>
    public static string Quote(string value)
    {
        Guard.NotNull(value, nameof(value));
        var builder = new System.Text.StringBuilder(value.Length + 2);
        builder.Append('"');
        foreach (var c in value)
        {
            if (c == '\r')
            {
                builder.Append('\\').Append('r');
                continue;
            }

            if (c is '"' or '\\' or '*')
            {
                builder.Append('\\');
            }

            builder.Append(c);
        }

        return builder.Append('"').ToString();
    }

    /// <summary>
    /// A record selector's value before quoting: the type with <c>:</c> and <c>\</c> escaped, a colon, then the id as it
    /// is (the shared <c>encodeRecordPair</c>).
    /// </summary>
    internal static string EncodeRecordPair(string type, string id)
    {
        var builder = new System.Text.StringBuilder(type.Length + id.Length + 4);
        foreach (var c in type)
        {
            if (c is ':' or '\\')
            {
                builder.Append('\\');
            }

            builder.Append(c);
        }

        return builder.Append(':').Append(id).ToString();
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
