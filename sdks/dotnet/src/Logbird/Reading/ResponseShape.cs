using System;
using System.Text.Json;

namespace Logbird;

/// <summary>
/// The members a success answer must have before the read client reads it, as the server's contract defines them. The
/// required members are unchanged since Logbird 0.1.0 for search and detail and since 0.2.0 for facets (search's
/// optional <c>totalExact</c> came later). A member that is missing, or
/// <c>null</c> where the contract does not allow it, makes the answer <c>invalid_response</c>, never an empty page or a
/// <see langword="null"/> collection. Members the contract marks optional (<c>totalExact</c>, a facet value's
/// <c>groups</c> and <c>groupsOtherCount</c>) may be absent, and members this SDK does not know are ignored.
/// </summary>
internal static class ResponseShape
{
    private static readonly string[] EventStrings =
        ["id", "projectId", "timestamp", "receivedAt", "environment", "action", "category", "outcome", "severity", "description", "schemaVersion", "sdk"];

    private static readonly string[] ContextStrings = ["operationId", "parentEventId", "requestId", "traceId", "ip", "userAgent"];

    /// <summary>The check for an answer read as <paramref name="type"/>, or <see langword="null"/> when it has none.</summary>
    internal static Func<JsonElement, bool>? For(Type type)
        => type == typeof(EventPage) ? Page
            : type == typeof(EventDetail) ? Detail
            : type == typeof(FacetResult) ? Facets
            : null;

    internal static bool Page(JsonElement page)
        => page.ValueKind == JsonValueKind.Object
            && ArrayOf(page, "data", Event)
            && TextOrNull(page, "nextCursor")
            && Number(page, "total")
            && OptionalBoolean(page, "totalExact")
            && Number(page, "tookMs");

    internal static bool Detail(JsonElement detail)
        => detail.ValueKind == JsonValueKind.Object
            && detail.TryGetProperty("event", out var stored) && Event(stored)
            && detail.TryGetProperty("payload", out _)
            && ArrayOf(detail, "parents", Event)
            && Number(detail, "childCount")
            && Number(detail, "operationSize");

    internal static bool Facets(JsonElement facets)
        => facets.ValueKind == JsonValueKind.Object
            && Text(facets, "field")
            && TextOrNull(facets, "by")
            && ArrayOf(facets, "values", FacetValue)
            && Number(facets, "otherCount");

    private static bool FacetValue(JsonElement value)
        => FacetGroup(value)
            && (!value.TryGetProperty("groups", out var groups) || (groups.ValueKind == JsonValueKind.Array && All(groups, FacetGroup)))
            && (!value.TryGetProperty("groupsOtherCount", out var other) || other.ValueKind == JsonValueKind.Number);

    private static bool FacetGroup(JsonElement value)
        => value.ValueKind == JsonValueKind.Object && Text(value, "value") && Text(value, "label") && Number(value, "count");

    internal static bool Event(JsonElement stored)
        => stored.ValueKind == JsonValueKind.Object
            && Texts(stored, EventStrings)
            && Number(stored, "conformance")
            && ObjectOrNull(stored, "actor", static actor => Texts(actor, "type", "id", "name", "email"))
            && ObjectOrNull(stored, "impersonator", static impersonator => Texts(impersonator, "id", "name"))
            && ObjectOrNull(stored, "executor", static executor => Texts(executor, "type", "id", "name", "jobId") && Number(executor, "attempt"))
            && ObjectOrNull(stored, "tenant", static tenant => Texts(tenant, "id", "name"))
            && TextOrNull(stored, "source")
            && ArrayOf(stored, "targets", static target => target.ValueKind == JsonValueKind.Object && Texts(target, "type", "id", "name"))
            && ArrayOf(stored, "changes", static change => change.ValueKind == JsonValueKind.Object && Texts(change, "field", "before", "after"))
            && stored.TryGetProperty("context", out var context) && context.ValueKind == JsonValueKind.Object && Texts(context, ContextStrings)
            && stored.TryGetProperty("attributes", out var attributes) && attributes.ValueKind == JsonValueKind.Object && AllTexts(attributes);

    private static bool Texts(JsonElement value, params string[] names)
    {
        foreach (var name in names)
        {
            if (!Text(value, name))
            {
                return false;
            }
        }

        return true;
    }

    private static bool AllTexts(JsonElement value)
    {
        foreach (var property in value.EnumerateObject())
        {
            if (property.Value.ValueKind != JsonValueKind.String)
            {
                return false;
            }
        }

        return true;
    }

    private static bool All(JsonElement array, Func<JsonElement, bool> item)
    {
        foreach (var element in array.EnumerateArray())
        {
            if (!item(element))
            {
                return false;
            }
        }

        return true;
    }

    private static bool Text(JsonElement value, string name)
        => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String;

    private static bool TextOrNull(JsonElement value, string name)
        => value.TryGetProperty(name, out var member) && member.ValueKind is JsonValueKind.String or JsonValueKind.Null;

    private static bool Number(JsonElement value, string name)
        => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.Number;

    private static bool OptionalBoolean(JsonElement value, string name)
        => !value.TryGetProperty(name, out var member) || member.ValueKind is JsonValueKind.True or JsonValueKind.False;

    private static bool ArrayOf(JsonElement value, string name, Func<JsonElement, bool> item)
        => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.Array && All(member, item);

    private static bool ObjectOrNull(JsonElement value, string name, Func<JsonElement, bool> members)
        => value.TryGetProperty(name, out var member)
            && (member.ValueKind == JsonValueKind.Null || (member.ValueKind == JsonValueKind.Object && members(member)));
}
