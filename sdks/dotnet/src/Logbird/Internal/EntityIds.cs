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
/// rejection is reported as the drop, with the server's code.
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

    /// <summary>
    /// Adds a warning for every identifier property a server may index differently from what is sent. The warnings name
    /// fields and limits only, never a value.
    /// </summary>
    public static void Inspect(AuditEvent e, List<string> warnings)
    {
        Check("actor.id", e.Actor?.Id, IndexedIdLength, warnings);
        Check("impersonator.id", e.Impersonator?.Id, IndexedIdLength, warnings);
        Check("executor.id", e.Executor?.Id, IndexedIdLength, warnings);
        Check("tenant.id", e.Tenant?.Id, IndexedIdLength, warnings);
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

            Check($"targets[{index}].type", target.Type, IndexedTargetTypeLength, warnings, index);
            Check($"targets[{index}].id", target.Id, IndexedIdLength, warnings, index);
            index++;
        }

        if (index > IndexedTargets)
        {
            warnings.Add($"the event has {index} targets: all are sent; Logbird up to 0.2.x stores them all but indexes only the first {IndexedTargets}, so the others are in the stored payload only" + LaterServerTargets);
        }
    }

    /// <summary>The warning for surrounding whitespace in <paramref name="field"/> (a field name only, never a value).</summary>
    public static string WhitespaceReason(string field, int targetIndex = -1)
        => targetIndex >= IndexedTargets
            ? $"surrounding whitespace in {field}: sent exactly as given; Logbird up to 0.2.x indexes only the first {IndexedTargets} targets, so this one is kept in the stored payload only"
            : $"surrounding whitespace in {field}: sent exactly as given; Logbird up to 0.2.x indexes it trimmed, so a search for the value with its whitespace does not find it";

    private static void Check(string field, string? value, int indexedLength, List<string> warnings, int targetIndex = -1)
    {
        // Null or empty means the field is absent.
        if (string.IsNullOrEmpty(value))
        {
            return;
        }

        // The server trims before it measures, so the length that matters is the trimmed one.
        var trimmed = EventJson.JsTrim(value!);
        var indexed = targetIndex < IndexedTargets;
        if (trimmed.Length > indexedLength)
        {
            warnings.Add(indexed
                ? $"{field} is longer than {indexedLength} UTF-16 code units once trimmed: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it cut to at most {indexedLength} (never splitting a surrogate pair), so search and entity pages show the shortened value" + LaterServer
                : $"{field} is longer than {indexedLength} UTF-16 code units once trimmed: sent exactly as given; Logbird up to 0.2.x indexes only the first {IndexedTargets} targets, so this one is kept in the stored payload only" + LaterServer);
        }

        if (HasLoneSurrogate(value!))
        {
            warnings.Add(indexed
                ? $"{field} contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x stores it as sent but indexes it with U+FFFD in place of each lone surrogate (before the length cut)" + LaterServer
                : $"{field} contains a lone surrogate: sent exactly as given; Logbird up to 0.2.x indexes only the first {IndexedTargets} targets, so this one is kept in the stored payload only" + LaterServer);
        }

        if (trimmed.Length != value!.Length)
        {
            warnings.Add(WhitespaceReason(field, targetIndex));
        }
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
