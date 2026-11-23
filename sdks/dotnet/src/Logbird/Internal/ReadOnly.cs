using System;
using System.Collections;
using System.Collections.Generic;

namespace Logbird.Internal;

/// <summary>
/// Read-only copies for the collections a result exposes. System.Text.Json fills an <see cref="IReadOnlyList{T}"/> member
/// with a <see cref="List{T}"/>, which a caller could cast back and change. Each result stores a copy instead, behind a
/// type that implements only the read-only interfaces: not <see cref="IList{T}"/>, <see cref="ICollection"/> or
/// <see cref="IDictionary"/> (whose <c>SyncRoot</c> can be the backing store), so no cast leads to storage a caller can
/// change, and neither can the collection it was given.
/// </summary>
internal static class ReadOnly
{
    /// <summary>A read-only copy of <paramref name="value"/>; an empty one for null or empty.</summary>
    public static IReadOnlyList<T> List<T>(IReadOnlyList<T>? value)
    {
        if (value is null || value.Count == 0)
        {
            return ReadOnlyArray<T>.Empty;
        }

        var copy = new T[value.Count];
        for (var i = 0; i < copy.Length; i++)
        {
            copy[i] = value[i];
        }

        return new ReadOnlyArray<T>(copy);
    }

    /// <summary>A read-only copy of <paramref name="value"/>, or null when it is null.</summary>
    public static IReadOnlyList<T>? ListOrNull<T>(IReadOnlyList<T>? value) => value is null ? null : List(value);

    /// <summary>A read-only copy of <paramref name="value"/> with ordinal keys; an empty one for null or empty.</summary>
    public static IReadOnlyDictionary<string, string> Dictionary(IReadOnlyDictionary<string, string>? value)
    {
        if (value is null || value.Count == 0)
        {
            return ReadOnlyMap.Empty;
        }

        var copy = new Dictionary<string, string>(value.Count, StringComparer.Ordinal);
        foreach (var pair in value)
        {
            copy[pair.Key] = pair.Value;
        }

        return new ReadOnlyMap(copy);
    }

    private sealed class ReadOnlyArray<T>(T[] items) : IReadOnlyList<T>
    {
        public static readonly ReadOnlyArray<T> Empty = new([]);

        public int Count => items.Length;

        public T this[int index] => items[index];

        public IEnumerator<T> GetEnumerator()
        {
            foreach (var item in items)
            {
                yield return item;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class ReadOnlyMap(Dictionary<string, string> items) : IReadOnlyDictionary<string, string>
    {
        public static readonly ReadOnlyMap Empty = new(new Dictionary<string, string>(StringComparer.Ordinal));

        public int Count => items.Count;

        public string this[string key] => items[key];

        public IEnumerable<string> Keys
        {
            get
            {
                foreach (var key in items.Keys)
                {
                    yield return key;
                }
            }
        }

        public IEnumerable<string> Values
        {
            get
            {
                foreach (var value in items.Values)
                {
                    yield return value;
                }
            }
        }

        public bool ContainsKey(string key) => items.ContainsKey(key);

#pragma warning disable CS8767 // The interface's [MaybeNullWhen(false)] is not available on every target framework.
        public bool TryGetValue(string key, out string value) => items.TryGetValue(key, out value!);
#pragma warning restore CS8767

        public IEnumerator<KeyValuePair<string, string>> GetEnumerator()
        {
            foreach (var pair in items)
            {
                yield return pair;
            }
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
