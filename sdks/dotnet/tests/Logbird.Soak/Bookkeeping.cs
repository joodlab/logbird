using System;
using System.Collections.Generic;

namespace Logbird.Soak;

/// <summary>
/// A fixed-capacity map from a 64-bit id hash to a 64-bit value, allocated once when the run starts. The harness keeps all
/// its per-event bookkeeping in these maps, so the process heap does not grow with the number of events and the heap
/// check measures the SDK, not the harness. Thread-safe (one lock; a few hundred operations a second).
/// </summary>
internal sealed class LongMap
{
    private readonly object _gate = new();
    private long[] _keys;
    private long[] _values;
    private int _count;

    public LongMap(long expected)
    {
        var capacity = 1024;
        while (capacity < expected * 2 && capacity < (1 << 28))
        {
            capacity <<= 1;
        }

        _keys = new long[capacity];
        _values = new long[capacity];
    }

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _count;
            }
        }
    }

    /// <summary>How many times the table had to grow (a growth allocates, which the report shows).</summary>
    public int Growths { get; private set; }

    /// <summary>The id hash used as a key: FNV-1a over the UTF-16 code units, never 0 (0 marks an empty slot).</summary>
    public static long Hash(string id)
    {
        unchecked
        {
            var hash = (long)14695981039346656037UL;
            foreach (var c in id)
            {
                hash = (hash ^ c) * 1099511628211L;
            }

            return hash == 0 ? 1 : hash;
        }
    }

    /// <summary>Adds the key with the value, or returns the existing value; true when added.</summary>
    public bool TryAdd(long key, long value, out long existing)
    {
        lock (_gate)
        {
            var slot = Find(_keys, key);
            if (_keys[slot] == key)
            {
                existing = _values[slot];
                return false;
            }

            if ((_count + 1) * 2 > _keys.Length)
            {
                Grow();
                slot = Find(_keys, key);
            }

            _keys[slot] = key;
            _values[slot] = value;
            _count++;
            existing = value;
            return true;
        }
    }

    public bool TryAdd(long key, long value) => TryAdd(key, value, out _);

    public bool TryGetValue(long key, out long value)
    {
        lock (_gate)
        {
            var slot = Find(_keys, key);
            value = _values[slot];
            return _keys[slot] == key;
        }
    }

    public bool Contains(long key) => TryGetValue(key, out _);

    /// <summary>A copy of every entry, for the report at the end of the run.</summary>
    public List<KeyValuePair<long, long>> Entries()
    {
        lock (_gate)
        {
            var entries = new List<KeyValuePair<long, long>>(_count);
            for (var i = 0; i < _keys.Length; i++)
            {
                if (_keys[i] != 0)
                {
                    entries.Add(new KeyValuePair<long, long>(_keys[i], _values[i]));
                }
            }

            return entries;
        }
    }

    private static int Find(long[] keys, long key)
    {
        var mask = keys.Length - 1;
        var slot = (int)((ulong)key * 11400714819323198485UL >> 4) & mask;
        while (keys[slot] != 0 && keys[slot] != key)
        {
            slot = (slot + 1) & mask;
        }

        return slot;
    }

    private void Grow()
    {
        var keys = new long[_keys.Length * 2];
        var values = new long[_keys.Length * 2];
        for (var i = 0; i < _keys.Length; i++)
        {
            if (_keys[i] != 0)
            {
                var slot = Find(keys, _keys[i]);
                keys[slot] = _keys[i];
                values[slot] = _values[i];
            }
        }

        _keys = keys;
        _values = values;
        Growths++;
    }
}
