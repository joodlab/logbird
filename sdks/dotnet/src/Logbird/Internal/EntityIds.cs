using System.Collections.Generic;

namespace Logbird.Internal;

/// <summary>
/// The SDK's own identifier check, run before sending so a caller learns about a problem at once. Identifiers (actor,
/// impersonator, executor and tenant ids, and each target's type and id) are sent as given: never trimmed, truncated or
/// repaired. Logbird 0.2.x keeps the payload as sent but indexes a shortened, repaired or trimmed copy, and indexes only
/// the first 64 targets. So an identifier Logbird would not index as given (too long, a lone surrogate) or more than 256
/// targets is refused with <c>invalid_entity_id</c> and the event is not sent; surrounding whitespace is sent as given
/// and reported as a warning (issue #269).
/// </summary>
internal static class EntityIds
{
    public const int MaxIdLength = 256;
    public const int MaxTargetTypeLength = 64;
    public const int MaxTargets = 256;

    /// <summary>How many targets Logbird 0.2.x indexes; the rest are kept in the stored payload only.</summary>
    public const int IndexedTargets = 64;

    /// <summary>The warning for surrounding whitespace in <paramref name="field"/> (a field name only, never a value).</summary>
    public static string WhitespaceReason(string field)
        => TargetIndex(field) >= IndexedTargets
            ? $"surrounding whitespace in {field}: sent exactly as given; Logbird up to 0.2.x indexes only the first {IndexedTargets} targets, so this one is kept in the stored payload only"
            : $"surrounding whitespace in {field}: sent exactly as given; Logbird up to 0.2.x indexes it trimmed, so a search for the value with its whitespace does not find it";

    private static int TargetIndex(string field)
    {
        if (!field.StartsWith("targets[", System.StringComparison.Ordinal))
        {
            return -1;
        }

        // The field names come from CheckTargets ("targets[12].id"), so the index is plain ASCII digits.
        var index = 0;
        for (var i = 8; i < field.Length && field[i] != ']'; i++)
        {
            if (field[i] is < '0' or > '9')
            {
                return -1;
            }

            index = (index * 10) + (field[i] - '0');
        }

        return index;
    }

    /// <summary>Returns the <c>invalid_entity_id</c> reason when the SDK refuses the event, else null.</summary>
    public static string? Validate(AuditEvent e, List<string> whitespaceFields)
    {
        if (e.EmitTargets && e.Targets.Count > MaxTargets)
        {
            return $"invalid_entity_id: the event has more than {MaxTargets} targets, the most this SDK sends (Logbird up to 0.2.x indexes only the first {IndexedTargets}), so the SDK did not send the event";
        }

        return Check("actor.id", e.Actor?.Id, MaxIdLength, whitespaceFields)
            ?? Check("impersonator.id", e.Impersonator?.Id, MaxIdLength, whitespaceFields)
            ?? Check("executor.id", e.Executor?.Id, MaxIdLength, whitespaceFields)
            ?? Check("tenant.id", e.Tenant?.Id, MaxIdLength, whitespaceFields)
            ?? CheckTargets(e, whitespaceFields);
    }

    private static string? CheckTargets(AuditEvent e, List<string> whitespaceFields)
    {
        if (!e.EmitTargets)
        {
            return null;
        }

        var index = 0;
        foreach (var target in e.Targets)
        {
            if (target is not null)
            {
                var reason = Check($"targets[{index}].type", target.Type, MaxTargetTypeLength, whitespaceFields)
                    ?? Check($"targets[{index}].id", target.Id, MaxIdLength, whitespaceFields);
                if (reason is not null)
                {
                    return reason;
                }
            }

            index++;
        }

        return null;
    }

    private static string? Check(string field, string? value, int maxLength, List<string> whitespaceFields)
    {
        // Null or empty means the field is absent.
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        if (value!.Length > maxLength)
        {
            return $"invalid_entity_id: {field} is longer than {maxLength} UTF-16 code units; Logbird would not index it as given, so the SDK did not send the event";
        }

        if (HasLoneSurrogate(value))
        {
            return $"invalid_entity_id: {field} contains a lone surrogate; Logbird would not index it as given, so the SDK did not send the event";
        }

        if (EventJson.JsTrim(value).Length != value.Length)
        {
            whitespaceFields.Add(field);
        }

        return null;
    }

    private static bool HasLoneSurrogate(string value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= value.Length || !char.IsLowSurrogate(value[i + 1]))
                {
                    return true;
                }

                i++;
            }
            else if (char.IsLowSurrogate(c))
            {
                return true;
            }
        }

        return false;
    }
}
