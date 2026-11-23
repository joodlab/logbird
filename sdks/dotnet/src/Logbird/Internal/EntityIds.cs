using System.Collections.Generic;

namespace Logbird.Internal;

/// <summary>
/// The SDK's look at entity identifiers before an event is queued: actor, impersonator, executor and tenant ids, and each
/// target's type and id. Identifiers are sent exactly as given (never trimmed, truncated or repaired), and the SDK never
/// refuses an event because of one: the server decides. The SDK only warns about a property a server may index
/// differently from what was sent; the warnings are raised after the event is queued, on the notification thread, so the
/// event may already be on its way. Logbird up to 0.2.x stores the payload as sent and indexes a repaired copy, in this
/// order (packages/clickhouse/src/normalize.ts):
/// <list type="number">
/// <item>surrounding whitespace trimmed;</item>
/// <item>each lone surrogate replaced with U+FFFD;</item>
/// <item>cut to at most 256 UTF-16 code units (64 for a target type), never splitting a surrogate pair;</item>
/// <item>only the first 64 targets indexed.</item>
/// </list>
/// A server with the exact-identifier rule (issue #269) may instead reject an event it cannot index as given; that
/// rejection is reported as the drop, with the server's code. One field gets at most one warning, naming every property
/// it has. Warnings are kept as compact records until delivery and only then formatted, so a backlog of notifications
/// holds a few bytes per warning, not its text.
/// </summary>
internal static class EntityIds
{
    /// <summary>The longest trimmed id Logbird up to 0.2.x indexes whole; a longer one is indexed cut to at most this length.</summary>
    public const int IndexedIdLength = 256;

    /// <summary>The longest target type Logbird up to 0.2.x indexes as given.</summary>
    public const int IndexedTargetTypeLength = 64;

    /// <summary>How many targets Logbird up to 0.2.x indexes; the rest are kept in the stored payload only.</summary>
    public const int IndexedTargets = 64;

    private const string LaterServer = "; a server that rejects such an identifier rejects the event, and the SDK reports that rejection as the drop with the server's code";

    private const string LaterServerTargets = "; a server that rejects more targets than it indexes rejects the event, and the SDK reports that rejection as the drop with the server's code";

    /// <summary>Which field a warning is about.</summary>
    public enum Field : byte
    {
        ActorId,
        ImpersonatorId,
        ExecutorId,
        TenantId,
        TargetType,
        TargetId,

        /// <summary>The whole event has more targets than Logbird up to 0.2.x indexes; the position is the count.</summary>
        TargetCount,
    }

    /// <summary>The properties a field has.</summary>
    [System.Flags]
    public enum Property : byte
    {
        None = 0,
        Whitespace = 1,
        TooLong = 2,
        LoneSurrogate = 4,
    }

    /// <summary>One warning, kept compact until it is delivered: a field, its target position (or the target count) and its properties.</summary>
    public readonly record struct Warning(Field Field, int Position, Property Properties);

    /// <summary>Adds at most one warning per field, and one for the target count, for what a server may index differently.</summary>
    public static void Inspect(AuditEvent e, List<Warning> warnings)
    {
        Check(Field.ActorId, -1, e.Actor?.Id, warnings);
        Check(Field.ImpersonatorId, -1, e.Impersonator?.Id, warnings);
        Check(Field.ExecutorId, -1, e.Executor?.Id, warnings);
        Check(Field.TenantId, -1, e.Tenant?.Id, warnings);
        if (!e.EmitTargets)
        {
            return;
        }

        // Positions are counted as sent: a null target is not serialized, so it takes no position.
        var index = 0;
        foreach (var target in e.Targets)
        {
            if (target is null)
            {
                continue;
            }

            Check(Field.TargetType, index, target.Type, warnings);
            Check(Field.TargetId, index, target.Id, warnings);
            index++;
        }

        if (index > IndexedTargets)
        {
            warnings.Add(new Warning(Field.TargetCount, index, Property.None));
        }
    }

    /// <summary>The warning's text: field names, positions and limits only, never a value.</summary>
    public static string Describe(Warning w)
    {
        if (w.Field == Field.TargetCount)
        {
            return $"the event has {w.Position} targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first {IndexedTargets}, so the others are in the stored payload only" + LaterServerTargets;
        }

        var field = FieldName(w);
        var limit = w.Field == Field.TargetType ? IndexedTargetTypeLength : IndexedIdLength;
        var p = w.Properties;
        var later = (p & (Property.TooLong | Property.LoneSurrogate)) != 0 ? LaterServer : string.Empty;
        if (w.Position >= IndexedTargets)
        {
            return $"{Subject(field, p, limit)}: sent exactly as given; Logbird up to 0.2.x indexes only the first {IndexedTargets} targets, so this one is kept in the stored payload only" + later;
        }

        // The texts for one property alone are the ones callers already see (#272 for whitespace).
        switch (p)
        {
            case Property.Whitespace:
                return $"surrounding whitespace in {field}: sent exactly as given; Logbird up to 0.2.x indexes it trimmed, so a search for the value with its whitespace does not find it";
            case Property.TooLong:
                return $"{field} is longer than {limit} UTF-16 code units once trimmed: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it cut to at most {limit} (never splitting a surrogate pair), so search and entity pages show the shortened value" + later;
            case Property.LoneSurrogate:
                return $"{field} contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it with U+FFFD in place of each lone surrogate (before the length cut)" + later;
        }

        // Several properties: one warning, with the server's repairs in its own order.
        var repairs = new List<string>(3);
        if ((p & Property.Whitespace) != 0)
        {
            repairs.Add("trimmed");
        }

        if ((p & Property.LoneSurrogate) != 0)
        {
            repairs.Add("with U+FFFD in place of each lone surrogate");
        }

        if ((p & Property.TooLong) != 0)
        {
            repairs.Add($"cut to at most {limit} (never splitting a surrogate pair)");
        }

        return $"{Subject(field, p, limit)}: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it {string.Join(", then ", repairs)}, so search and entity pages show a different value" + later;
    }

    private static string Subject(string field, Property p, int limit)
    {
        var parts = new List<string>(3);
        if ((p & Property.Whitespace) != 0)
        {
            parts.Add("has surrounding whitespace");
        }

        if ((p & Property.TooLong) != 0)
        {
            parts.Add($"is longer than {limit} UTF-16 code units once trimmed");
        }

        if ((p & Property.LoneSurrogate) != 0)
        {
            parts.Add("contains a lone surrogate");
        }

        return parts.Count switch
        {
            1 when p == Property.Whitespace => "surrounding whitespace in " + field,
            1 => field + " " + parts[0],
            2 => field + " " + parts[0] + " and " + parts[1],
            _ => field + " " + parts[0] + ", " + parts[1] + " and " + parts[2],
        };
    }

    private static string FieldName(Warning w) => w.Field switch
    {
        Field.ActorId => "actor.id",
        Field.ImpersonatorId => "impersonator.id",
        Field.ExecutorId => "executor.id",
        Field.TenantId => "tenant.id",
        Field.TargetType => $"targets[{w.Position}].type",
        _ => $"targets[{w.Position}].id",
    };

    private static void Check(Field field, int position, string? value, List<Warning> warnings)
    {
        // Null or empty means the field is absent.
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        // The server trims before it measures, so the length that matters is the trimmed one.
        var trimmed = EventJson.JsTrim(value!);
        var limit = field == Field.TargetType ? IndexedTargetTypeLength : IndexedIdLength;
        var properties = Property.None;
        if (trimmed.Length != value!.Length)
        {
            properties |= Property.Whitespace;
        }

        if (trimmed.Length > limit)
        {
            properties |= Property.TooLong;
        }

        if (HasLoneSurrogate(value))
        {
            properties |= Property.LoneSurrogate;
        }

        if (properties != Property.None)
        {
            warnings.Add(new Warning(field, position, properties));
        }
    }

    internal static bool HasLoneSurrogate(string value)
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
