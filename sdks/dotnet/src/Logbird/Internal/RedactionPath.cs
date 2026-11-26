using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;

namespace Logbird.Internal;

/// <summary>A trie node for each literal segment or single-segment wildcard in a redaction path.</summary>
internal sealed class RedactionPath
{
    private readonly Dictionary<string, RedactionPath> _children = new(StringComparer.Ordinal);
    private RedactionPath? _wildcard;

    internal bool Redact { get; private set; }

    internal bool Keep { get; private set; }

    private static readonly (string Field, string[] Segments)[] Identifiers = Enumerable
        .Concat(["id", "action"], Redactor.IdentifierFields)
        .Select(field => (field, field.Replace("[]", ".*").Split('.')))
        .ToArray();

    internal static IReadOnlyList<RedactionPath>? Compile(
        IReadOnlyList<string> paths, IReadOnlyList<string> keepPaths, out IReadOnlyList<string> identifiersMatched)
    {
        if (paths.Count == 0 && keepPaths.Count == 0)
        {
            identifiersMatched = Array.Empty<string>();
            return null;
        }

        var root = new RedactionPath();
        var matched = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < paths.Count; i++)
        {
            var segments = Parse(paths[i], nameof(RedactionOptions.AddPaths), i);
            root.Add(segments).Redact = true;
            foreach (var (field, identifier) in Identifiers)
            {
                if (MatchesIdentifier(segments, identifier))
                {
                    matched.Add(field);
                }
            }
        }

        for (var i = 0; i < keepPaths.Count; i++)
        {
            root.Add(Parse(keepPaths[i], nameof(RedactionOptions.KeepPaths), i)).Keep = true;
        }

        identifiersMatched = matched.ToArray();
        return [root];
    }

    private static bool MatchesIdentifier(List<string?> segments, string[] identifier)
    {
        if (segments.Count != identifier.Length)
        {
            return false;
        }

        for (var i = 0; i < segments.Count; i++)
        {
            var segment = segments[i];
            if (segment is not null && (identifier[i] == "*" ? !IsArrayIndex(segment) : segment != identifier[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsArrayIndex(string segment)
        => segment.Length > 0 && (segment.Length == 1 || segment[0] != '0') && segment.All(c => c is >= '0' and <= '9');

    private static List<string?> Parse(string? path, string option, int index)
    {
        if (path is null)
        {
            throw Invalid();
        }

        var segments = new List<string?>();
        var text = new StringBuilder();
        var wildcard = false;
        for (var i = 0; i <= path.Length; i++)
        {
            if (i == path.Length || path[i] == '.')
            {
                if (!wildcard && text.Length == 0)
                {
                    throw Invalid();
                }

                segments.Add(wildcard ? null : text.ToString());
                text.Clear();
                wildcard = false;
                continue;
            }

            var character = path[i];
            if (wildcard)
            {
                throw Invalid();
            }

            if (character == '*')
            {
                if (text.Length != 0)
                {
                    throw Invalid();
                }

                wildcard = true;
                continue;
            }

            if (character == '\\')
            {
                i++;
                if (i == path.Length || path[i] is not ('.' or '*' or '\\'))
                {
                    throw Invalid();
                }

                character = path[i];
            }

            text.Append(character);
        }

        return segments;

        ArgumentException Invalid() => new($"Invalid redaction {option} entry at index {index}.");
    }

    private RedactionPath Add(List<string?> segments)
    {
        var node = this;
        foreach (var segment in segments)
        {
            if (segment is null)
            {
                node = node._wildcard ??= new RedactionPath();
                continue;
            }

            if (!node._children.TryGetValue(segment, out var child))
            {
                child = new RedactionPath();
                node._children.Add(segment, child);
            }

            node = child;
        }

        return node;
    }

    internal static List<RedactionPath>? Children(IReadOnlyList<RedactionPath>? nodes, string key)
    {
        if (nodes is null)
        {
            return null;
        }

        List<RedactionPath>? matches = null;
        foreach (var node in nodes)
        {
            if (node._children.TryGetValue(key, out var exact))
            {
                (matches ??= []).Add(exact);
            }

            if (node._wildcard is { } wildcard)
            {
                (matches ??= []).Add(wildcard);
            }
        }

        return matches;
    }
}
