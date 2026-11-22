using System.Collections.Generic;

namespace Logbird.Internal;

/// <summary>
/// The SDK's identifier check, run before sending so a caller learns about a problem at once. Identifiers (actor,
/// impersonator, executor and tenant ids, and each target's type and id) are sent exactly as given: never trimmed,
/// truncated or repaired. One that Logbird cannot store exactly as given (too long, a lone surrogate, too many targets)
/// is refused with <c>invalid_entity_id</c> and the event is not sent; surrounding whitespace is sent as given and
/// reported as a warning (Logbird up to 0.2.x indexes such an id trimmed; see issue #269).
/// </summary>
internal static class EntityIds
{
    public const int MaxIdLength = 256;
    public const int MaxTargetTypeLength = 64;
    public const int MaxTargets = 256;

    /// <summary>Returns the <c>invalid_entity_id</c> reason when the event cannot be stored, else null.</summary>
    public static string? Validate(AuditEvent e, List<string> whitespaceFields)
    {
        if (e.EmitTargets && e.Targets.Count > MaxTargets)
        {
            return $"invalid_entity_id: the event has more than {MaxTargets} targets; this SDK sends events only exactly as given and Logbird cannot store this one, so the event was not sent";
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
            return $"invalid_entity_id: {field} is longer than {maxLength} UTF-16 code units; this SDK sends identifiers only exactly as given and Logbird cannot store this one, so the event was not sent";
        }

        if (HasLoneSurrogate(value))
        {
            return $"invalid_entity_id: {field} contains a lone surrogate; this SDK sends identifiers only exactly as given and Logbird cannot store this one, so the event was not sent";
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
