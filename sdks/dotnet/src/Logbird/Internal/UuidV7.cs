using System;
using System.Security.Cryptography;

namespace Logbird.Internal;

/// <summary>RFC 9562 UUIDv7: 48-bit Unix milliseconds, then random bits. Sorts by creation time.</summary>
internal static class UuidV7
{
    private static readonly RandomNumberGenerator Random = RandomNumberGenerator.Create();
    private static readonly char[] Hex = "0123456789abcdef".ToCharArray();

    public static string NewId() => Format(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    internal static string Format(long unixMilliseconds)
    {
        var bytes = new byte[16];
        Random.GetBytes(bytes);
        var time = unixMilliseconds;
        for (var i = 5; i >= 0; i--)
        {
            bytes[i] = (byte)(time & 0xFF);
            time >>= 8;
        }

        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        var chars = new char[36];
        var position = 0;
        for (var i = 0; i < 16; i++)
        {
            if (i is 4 or 6 or 8 or 10)
            {
                chars[position++] = '-';
            }

            chars[position++] = Hex[bytes[i] >> 4];
            chars[position++] = Hex[bytes[i] & 0x0F];
        }

        return new string(chars);
    }
}
