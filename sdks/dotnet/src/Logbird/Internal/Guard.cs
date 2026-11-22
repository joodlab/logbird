using System;

namespace Logbird.Internal;

internal static class Guard
{
    public static T NotNull<T>(T? value, string name)
        where T : class
        => value ?? throw new ArgumentNullException(name);

    public static string NotBlank(string? value, string name)
    {
        if (value is null)
        {
            throw new ArgumentNullException(name);
        }

        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("Value must not be empty.", name);
        }

        return value;
    }
}
