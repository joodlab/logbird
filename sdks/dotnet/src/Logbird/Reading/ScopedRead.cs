using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Serialization;
using Logbird.Internal;

namespace Logbird;

/// <summary>Fields a viewer scope hides from the events it can read.</summary>
[Flags]
public enum ViewerMask
{
    /// <summary>Nothing is hidden.</summary>
    None = 0,

    /// <summary>Empties <c>context.ip</c>.</summary>
    Ip = 1,

    /// <summary>Empties <c>context.userAgent</c>.</summary>
    UserAgent = 2,

    /// <summary>Replaces <c>actor.email</c> with a stable keyed hash (<c>masked:…</c>).</summary>
    ActorEmail = 4,
}

/// <summary>The one target a scope is limited to: an event matches only when one of its targets has this type and id.</summary>
public sealed class ViewerScopeTarget
{
    /// <summary>Creates a scope target.</summary>
    /// <param name="type">The target type, as stored (1 to 60 characters).</param>
    /// <param name="id">The target id, as stored (1 to 250 characters).</param>
    public ViewerScopeTarget(string type, string id)
    {
        Type = type;
        Id = id;
    }

    /// <summary>The target type.</summary>
    public string Type { get; }

    /// <summary>The target id.</summary>
    public string Id { get; }
}

/// <summary>
/// What a viewer token (or a scoped read key) may read: one tenant's events, optionally only those touching one target
/// and only actions with given prefixes, optionally with fields masked. The server enforces it on every read route;
/// nothing in a query can widen it. See <c>docs/scoped-read-access.md</c>.
/// </summary>
/// <remarks>
/// Identifiers must be in the form Logbird stored them: no surrounding whitespace, no U+FFFD replacement character, no
/// lone surrogate, and at most 250 characters (60 for a target type, 190 for an action prefix). The client checks this
/// before sending, so a scope that could never match fails at once instead of silently showing nothing.
/// </remarks>
public sealed class ViewerScope
{
    /// <summary>Creates a scope for one tenant.</summary>
    /// <param name="tenantId">The tenant whose events may be read (the event's <c>tenant.id</c>).</param>
    public ViewerScope(string tenantId)
    {
        TenantId = tenantId;
    }

    /// <summary>The tenant whose events may be read.</summary>
    public string TenantId { get; }

    /// <summary>When set, only events with a target of exactly this type and id together.</summary>
    public ViewerScopeTarget? Target { get; init; }

    /// <summary>When set, only events whose action starts with one of these prefixes (1 to 20 of them).</summary>
    public IReadOnlyList<string>? ActionPrefixes { get; init; }

    /// <summary>Fields to hide. Any mask also hides the original payload (event detail returns no payload).</summary>
    public ViewerMask Mask { get; init; }

    /// <summary>Lists no values (tenant and target ids), so logging this object cannot leak them.</summary>
    public override string ToString() => nameof(ViewerScope);

    internal void Validate()
    {
        CheckStored(TenantId, 250, nameof(TenantId));
        if (Target is not null)
        {
            CheckStored(Target.Type, 60, "Target.Type");
            CheckStored(Target.Id, 250, "Target.Id");
        }

        if (ActionPrefixes is not null)
        {
            if (ActionPrefixes.Count is < 1 or > 20)
            {
                throw new ArgumentException("ActionPrefixes must hold 1 to 20 prefixes, or be null for every action.", nameof(ActionPrefixes));
            }

            foreach (var prefix in ActionPrefixes)
            {
                CheckStored(prefix, 190, nameof(ActionPrefixes));
            }
        }

        if ((Mask & ~(ViewerMask.Ip | ViewerMask.UserAgent | ViewerMask.ActorEmail)) != 0)
        {
            throw new ArgumentException("Unknown ViewerMask value.", nameof(Mask));
        }
    }

    internal ViewerScopeWire ToWire() => new()
    {
        TenantId = TenantId,
        Target = Target is null ? null : new ViewerScopeTargetWire { Type = Target.Type, Id = Target.Id },
        ActionPrefixes = ActionPrefixes?.ToList(),
        Mask = MaskNames(Mask),
    };

    internal static ViewerScope FromWire(ViewerScopeWire wire) => new(wire.TenantId ?? string.Empty)
    {
        Target = wire.Target is null ? null : new ViewerScopeTarget(wire.Target.Type ?? string.Empty, wire.Target.Id ?? string.Empty),
        ActionPrefixes = wire.ActionPrefixes,
        Mask = MaskFromNames(wire.Mask),
    };

    /// <summary>Whether two scopes grant exactly the same access (prefix order and repeats ignored).</summary>
    internal bool SameAccessAs(ViewerScope other)
        => string.Equals(TenantId, other.TenantId, StringComparison.Ordinal)
            && (Target is null ? other.Target is null
                : other.Target is not null && string.Equals(Target.Type, other.Target.Type, StringComparison.Ordinal) && string.Equals(Target.Id, other.Target.Id, StringComparison.Ordinal))
            && PrefixSet(ActionPrefixes).SetEquals(PrefixSet(other.ActionPrefixes))
            && (ActionPrefixes is null) == (other.ActionPrefixes is null)
            && Mask == other.Mask;

    private static HashSet<string> PrefixSet(IReadOnlyList<string>? prefixes) => new(prefixes ?? [], StringComparer.Ordinal);

    private static List<string>? MaskNames(ViewerMask mask)
    {
        if (mask == ViewerMask.None)
        {
            return null;
        }

        var names = new List<string>();
        if ((mask & ViewerMask.Ip) != 0)
        {
            names.Add("ip");
        }

        if ((mask & ViewerMask.UserAgent) != 0)
        {
            names.Add("user_agent");
        }

        if ((mask & ViewerMask.ActorEmail) != 0)
        {
            names.Add("actor_email");
        }

        return names;
    }

    private static ViewerMask MaskFromNames(IReadOnlyList<string>? names)
    {
        var mask = ViewerMask.None;
        foreach (var name in names ?? [])
        {
            mask |= name switch
            {
                "ip" => ViewerMask.Ip,
                "user_agent" => ViewerMask.UserAgent,
                "actor_email" => ViewerMask.ActorEmail,
                // An unknown mask from a newer server is kept as "not the same scope" by comparing against the request.
                _ => (ViewerMask)(1 << 30),
            };
        }

        return mask;
    }

    private static void CheckStored(string? value, int maxLength, string name)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException(name + " must not be empty.", name);
        }

        if (value!.Length > maxLength)
        {
            throw new ArgumentException(name + " must be at most " + maxLength.ToString(CultureInfo.InvariantCulture) + " characters.", name);
        }

        if (EventJson.JsTrim(value).Length != value.Length)
        {
            throw new ArgumentException(name + " must not start or end with whitespace: scopes match ids as Logbird stored them.", name);
        }

        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (c == (char)0xFFFD)
            {
                throw new ArgumentException(name + " must not contain the Unicode replacement character.", name);
            }

            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                i++;
            }
            else if (char.IsSurrogate(c))
            {
                throw new ArgumentException(name + " must not contain a lone surrogate.", name);
            }
        }
    }
}

/// <summary>A short-lived token that reads one scope, for a browser or another server. Keep it out of URLs and logs.</summary>
public sealed class ViewerToken
{
    internal ViewerToken(string token, DateTimeOffset expiresAt, ViewerScope scope)
    {
        Token = token;
        ExpiresAt = expiresAt;
        Scope = scope;
    }

    /// <summary>The token (<c>lbv1.…</c>). Send it as <c>Authorization: Bearer</c> on the read routes; never in a URL.</summary>
    public string Token { get; }

    /// <summary>When the token stops working. It also stops within 30 seconds of the minting key being revoked.</summary>
    public DateTimeOffset ExpiresAt { get; }

    /// <summary>The scope the server granted (the same as requested; otherwise minting fails).</summary>
    public ViewerScope Scope { get; }

    /// <summary>Never includes the token.</summary>
    public override string ToString() => "ViewerToken (expires " + ExpiresAt.UtcDateTime.ToString("u", CultureInfo.InvariantCulture) + ")";
}

/// <summary>A facet request: how many in-range events have each value of a field, optionally split by a second field.</summary>
public sealed class FacetQuery
{
    /// <summary>Creates a facet request for a field.</summary>
    /// <param name="field">A query field such as <c>action</c>, <c>actor</c> or <c>target.type</c>, or <c>attr.&lt;path&gt;</c>.</param>
    public FacetQuery(string field)
    {
        Field = field;
    }

    /// <summary>The field to count values of.</summary>
    public string Field { get; }

    /// <summary>An optional second field to split each value by.</summary>
    public string? By { get; init; }

    /// <summary>An optional Logbird query that narrows the events counted.</summary>
    public string? Query { get; init; }

    /// <summary>The start of the range.</summary>
    public DateTimeOffset? From { get; init; }

    /// <summary>The end of the range.</summary>
    public DateTimeOffset? To { get; init; }

    /// <summary>How many values to return, 1 to 100 (server default 10).</summary>
    public int? Limit { get; init; }

    /// <summary>How many second-level groups per value, 1 to 20 (server default 5).</summary>
    public int? ByLimit { get; init; }

    internal string ToQueryString()
    {
        if (string.IsNullOrEmpty(Field))
        {
            throw new ArgumentException("A facet needs a field.", nameof(Field));
        }

        if (Limit is < 1 or > 100)
        {
            throw new ArgumentException("Limit must be between 1 and 100.", nameof(Limit));
        }

        if (ByLimit is < 1 or > 20)
        {
            throw new ArgumentException("ByLimit must be between 1 and 20.", nameof(ByLimit));
        }

        return Query2.Build(
            ("from", From is { } from ? EventJson.FormatTimestamp(from) : null),
            ("to", To is { } to ? EventJson.FormatTimestamp(to) : null),
            ("q", Query),
            ("field", Field),
            ("limit", Limit?.ToString(CultureInfo.InvariantCulture)),
            ("by", By),
            ("byLimit", ByLimit?.ToString(CultureInfo.InvariantCulture)));
    }
}

/// <summary>Facet counts. Values are event data (ids, names, emails): this object's <c>ToString()</c> lists none.</summary>
public sealed class FacetResult
{
    /// <summary>The field counted.</summary>
    public string Field { get; init; } = string.Empty;

    /// <summary>The second field, when one was requested.</summary>
    public string? By { get; init; }

    /// <summary>The most frequent values, most frequent first.</summary>
    public IReadOnlyList<FacetValue> Values { get; init; } = [];

    /// <summary>How many events have a value not listed.</summary>
    public long OtherCount { get; init; }
}

/// <summary>One value of a facet.</summary>
public sealed class FacetValue
{
    /// <summary>The value.</summary>
    public string Value { get; init; } = string.Empty;

    /// <summary>A display label for the value.</summary>
    public string Label { get; init; } = string.Empty;

    /// <summary>How many events have it.</summary>
    public long Count { get; init; }

    /// <summary>The second-level split, when <see cref="FacetQuery.By"/> was given.</summary>
    public IReadOnlyList<FacetGroup>? Groups { get; init; }

    /// <summary>Events with this value whose second-level value is not listed.</summary>
    public long? GroupsOtherCount { get; init; }
}

/// <summary>One second-level group of a facet value.</summary>
public sealed class FacetGroup
{
    /// <summary>The value.</summary>
    public string Value { get; init; } = string.Empty;

    /// <summary>A display label for the value.</summary>
    public string Label { get; init; } = string.Empty;

    /// <summary>How many events have it.</summary>
    public long Count { get; init; }
}

/// <summary>Export file formats.</summary>
public enum ExportFormat
{
    /// <summary>Comma-separated values, one event per row.</summary>
    Csv,

    /// <summary>JSON Lines, one stored event per line.</summary>
    Jsonl,

    /// <summary>JSON Lines with each event's original payload; refused (<c>masked_export</c>) for a masked scope.</summary>
    JsonlEvidence,
}

/// <summary>An export request: every matching event in the range, streamed in one format.</summary>
public sealed class ExportQuery
{
    /// <summary>Creates an export request.</summary>
    /// <param name="format">The file format.</param>
    public ExportQuery(ExportFormat format)
    {
        Format = format;
    }

    /// <summary>The file format.</summary>
    public ExportFormat Format { get; }

    /// <summary>An optional Logbird query that narrows the events exported.</summary>
    public string? Query { get; init; }

    /// <summary>The start of the range.</summary>
    public DateTimeOffset? From { get; init; }

    /// <summary>The end of the range.</summary>
    public DateTimeOffset? To { get; init; }

    internal string ToQueryString() => Query2.Build(
        ("from", From is { } from ? EventJson.FormatTimestamp(from) : null),
        ("to", To is { } to ? EventJson.FormatTimestamp(to) : null),
        ("q", Query),
        ("format", Format switch
        {
            ExportFormat.Csv => "csv",
            ExportFormat.Jsonl => "jsonl",
            ExportFormat.JsonlEvidence => "jsonl-evidence",
            _ => throw new ArgumentException("Unknown ExportFormat.", nameof(Format)),
        }));
}

internal static class Query2
{
    public static string Build(params (string Key, string? Value)[] pairs)
    {
        var parts = pairs.Where(p => p.Value is not null).Select(p => p.Key + "=" + Uri.EscapeDataString(p.Value!)).ToArray();
        return parts.Length == 0 ? string.Empty : "?" + string.Join("&", parts);
    }
}

internal sealed class ViewerScopeWire
{
    public string? TenantId { get; set; }

    public ViewerScopeTargetWire? Target { get; set; }

    public List<string>? ActionPrefixes { get; set; }

    public List<string>? Mask { get; set; }
}

internal sealed class ViewerScopeTargetWire
{
    public string? Type { get; set; }

    public string? Id { get; set; }
}

internal sealed class MintViewerTokenRequest
{
    public ViewerScopeWire? Scope { get; set; }

    public int? TtlSeconds { get; set; }
}

internal sealed class MintViewerTokenResponse
{
    public string? Token { get; set; }

    public string? ExpiresAt { get; set; }

    public ViewerScopeWire? Scope { get; set; }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(MintViewerTokenRequest))]
[JsonSerializable(typeof(MintViewerTokenResponse))]
[JsonSerializable(typeof(FacetResult))]
internal sealed partial class ScopedJsonContext : JsonSerializerContext
{
}
