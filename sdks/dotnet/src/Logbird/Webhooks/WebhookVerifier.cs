using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Logbird.Internal;

namespace Logbird;

/// <summary>Why a webhook request failed verification. Answer such a request with 400 and move on.</summary>
public enum WebhookFailure
{
    /// <summary>A <c>webhook-id</c>, <c>webhook-timestamp</c> or <c>webhook-signature</c> header is missing, empty or repeated.</summary>
    MissingHeader = 0,

    /// <summary>The timestamp is not whole Unix seconds.</summary>
    InvalidTimestamp = 1,

    /// <summary>The timestamp is further from now than the tolerance (a replay or a wrong clock).</summary>
    TimestampOutOfTolerance = 2,

    /// <summary>No signature matches any of your secrets: the body, id or timestamp changed, or the secret is wrong.</summary>
    NoMatchingSignature = 3,

    /// <summary>The body is authentic but is not JSON.</summary>
    InvalidPayload = 4,
}

/// <summary>A webhook request failed verification. A misconfigured secret throws <see cref="ArgumentException"/> instead.</summary>
public sealed class WebhookVerificationException : Exception
{
    /// <summary>Creates the exception.</summary>
    /// <param name="reason">Why verification failed.</param>
    public WebhookVerificationException(WebhookFailure reason)
        : base("Webhook verification failed: " + reason)
    {
        Reason = reason;
    }

    /// <summary>Why verification failed.</summary>
    public WebhookFailure Reason { get; }
}

/// <summary>The Standard Webhooks header names.</summary>
public static class WebhookHeaders
{
    /// <summary>The <c>webhook-id</c> header: the delivery id, stable across retries.</summary>
    public const string Id = "webhook-id";

    /// <summary>The <c>webhook-timestamp</c> header: Unix seconds when the delivery was signed.</summary>
    public const string Timestamp = "webhook-timestamp";

    /// <summary>The <c>webhook-signature</c> header: one or more space-separated <c>v1,&lt;base64&gt;</c> signatures.</summary>
    public const string Signature = "webhook-signature";
}

/// <summary>
/// Verifies Logbird webhook deliveries (Standard Webhooks, https://www.standardwebhooks.com/). Create one per
/// endpoint secret configuration and reuse it; it is thread-safe. Passes the same test vectors as the TypeScript SDK.
/// </summary>
/// <example>
/// <code>
/// var verifier = new WebhookVerifier(configuration["Logbird:WebhookSecret"]!);
/// JsonElement delivery = verifier.Verify(rawBody, headerName => request.Headers[headerName]);
/// </code>
/// </example>
public sealed class WebhookVerifier
{
    /// <summary>Signatures checked per request: enough for any rotation overlap, bounded against a header stuffed with junk.</summary>
    private const int MaxSignatures = 10;
    private const int SignatureBytes = 32;
    private static readonly Regex Base64 = new("^[A-Za-z0-9+/]+={0,2}$", RegexOptions.CultureInvariant);
    private static readonly Regex Digits = new("^[0-9]+$", RegexOptions.CultureInvariant);
    private static readonly Regex Separator = new(@"\s+", RegexOptions.CultureInvariant);
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private static readonly char[] UnsafeIdCharacters = ['.', '\r', '\n'];
    private static readonly long UnixEpochTicks = new DateTimeOffset(1970, 1, 1, 0, 0, 0, TimeSpan.Zero).UtcTicks;

    private readonly byte[][] _keys;
    private readonly TimeSpan _tolerance;

    /// <summary>Creates a verifier for one secret.</summary>
    /// <param name="secret">The endpoint secret, <c>whsec_</c> followed by base64.</param>
    /// <param name="tolerance">How far the timestamp may be from now. Defaults to five minutes.</param>
    /// <exception cref="ArgumentException">The secret is not a valid <c>whsec_…</c> secret.</exception>
    public WebhookVerifier(string secret, TimeSpan? tolerance = null)
        : this([secret], tolerance)
    {
    }

    /// <summary>Creates a verifier that accepts any of several secrets, for example during secret rotation.</summary>
    /// <param name="secrets">The endpoint secrets.</param>
    /// <param name="tolerance">How far the timestamp may be from now. Defaults to five minutes.</param>
    /// <exception cref="ArgumentException">A secret is invalid or the list is empty.</exception>
    /// <exception cref="ArgumentOutOfRangeException">The tolerance is negative.</exception>
    public WebhookVerifier(IEnumerable<string> secrets, TimeSpan? tolerance = null)
    {
        _keys = DecodeSecrets(Guard.NotNull(secrets, nameof(secrets)));
        _tolerance = tolerance ?? TimeSpan.FromMinutes(5);
        if (_tolerance < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(tolerance), tolerance, "The tolerance must not be negative.");
        }
    }

    /// <summary>Authenticates the raw body, then parses it as JSON and returns it.</summary>
    /// <param name="payload">The exact raw request body. Do not parse and reserialize it first.</param>
    /// <param name="getHeader">Looks up a request header by name, returning <see langword="null"/> when it is missing or repeated.</param>
    /// <param name="now">The current time; defaults to the current whole second.</param>
    /// <returns>The parsed body. It is not validated against a schema.</returns>
    /// <exception cref="WebhookVerificationException">The request failed verification.</exception>
    public JsonElement Verify(string payload, Func<string, string?> getHeader, DateTimeOffset? now = null)
    {
        Guard.NotNull(getHeader, nameof(getHeader));
        return Verify(payload, getHeader(WebhookHeaders.Id), getHeader(WebhookHeaders.Timestamp), getHeader(WebhookHeaders.Signature), now);
    }

    /// <summary>Authenticates the raw body, then parses it as JSON and returns it.</summary>
    /// <param name="payload">The exact raw request body.</param>
    /// <param name="webhookId">The <c>webhook-id</c> header.</param>
    /// <param name="webhookTimestamp">The <c>webhook-timestamp</c> header.</param>
    /// <param name="webhookSignature">The <c>webhook-signature</c> header.</param>
    /// <param name="now">The current time; defaults to the current whole second.</param>
    /// <returns>The parsed body.</returns>
    /// <exception cref="WebhookVerificationException">The request failed verification.</exception>
    public JsonElement Verify(string payload, string? webhookId, string? webhookTimestamp, string? webhookSignature, DateTimeOffset? now = null)
    {
        Guard.NotNull(payload, nameof(payload));
        Authenticate(Encoding.UTF8.GetBytes(payload), webhookId, webhookTimestamp, webhookSignature, now);
        return Parse(() => JsonDocument.Parse(payload));
    }

    /// <summary>Authenticates the raw body bytes, then parses them as JSON and returns the result.</summary>
    /// <param name="payload">The exact raw request body bytes.</param>
    /// <param name="webhookId">The <c>webhook-id</c> header.</param>
    /// <param name="webhookTimestamp">The <c>webhook-timestamp</c> header.</param>
    /// <param name="webhookSignature">The <c>webhook-signature</c> header.</param>
    /// <param name="now">The current time; defaults to the current whole second.</param>
    /// <returns>The parsed body.</returns>
    /// <exception cref="WebhookVerificationException">The request failed verification.</exception>
    public JsonElement Verify(byte[] payload, string? webhookId, string? webhookTimestamp, string? webhookSignature, DateTimeOffset? now = null)
    {
        Guard.NotNull(payload, nameof(payload));
        Authenticate(payload, webhookId, webhookTimestamp, webhookSignature, now);
        return Parse(() => JsonDocument.Parse(payload));
    }

    /// <summary>Signs a payload, returning the <c>webhook-signature</c> header value: one <c>v1,&lt;base64&gt;</c> per secret, space-separated.</summary>
    /// <param name="id">The delivery id; nonempty, without dots or newlines.</param>
    /// <param name="timestamp">Whole Unix seconds, also sent as <c>webhook-timestamp</c>.</param>
    /// <param name="payload">The exact body that will be sent.</param>
    /// <param name="secrets">One or more <c>whsec_…</c> secrets.</param>
    /// <exception cref="ArgumentException">The id or a secret is invalid.</exception>
    /// <exception cref="ArgumentOutOfRangeException">The timestamp is negative or too large.</exception>
    public static string Sign(string id, long timestamp, string payload, params string[] secrets)
    {
        if (string.IsNullOrEmpty(id) || id.IndexOfAny(UnsafeIdCharacters) >= 0)
        {
            throw new ArgumentException("Webhook id must be nonempty and contain no dots or newlines.", nameof(id));
        }

        if (timestamp is < 0 or > MaxSafeInteger)
        {
            throw new ArgumentOutOfRangeException(nameof(timestamp), timestamp, "Webhook timestamp must be whole Unix seconds.");
        }

        Guard.NotNull(payload, nameof(payload));
        var message = SignedContent(id, timestamp.ToString(CultureInfo.InvariantCulture), Encoding.UTF8.GetBytes(payload));
        return string.Join(" ", DecodeSecrets(secrets).Select(key => "v1," + Convert.ToBase64String(Hmac(key, message))));
    }

    /// <summary>Generates a new endpoint secret: <c>whsec_</c> and 32 random bytes in base64.</summary>
    public static string GenerateSecret()
    {
        var bytes = new byte[32];
        using (var random = RandomNumberGenerator.Create())
        {
            random.GetBytes(bytes);
        }

        return "whsec_" + Convert.ToBase64String(bytes);
    }

    private void Authenticate(byte[] payload, string? id, string? timestamp, string? signatureHeader, DateTimeOffset? now)
    {
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(timestamp) || string.IsNullOrEmpty(signatureHeader))
        {
            throw new WebhookVerificationException(WebhookFailure.MissingHeader);
        }

        if (!Digits.IsMatch(timestamp) || !long.TryParse(timestamp, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds) || seconds > MaxSafeInteger)
        {
            throw new WebhookVerificationException(WebhookFailure.InvalidTimestamp);
        }

        double nowSeconds = now is { } explicitNow
            ? (explicitNow.UtcTicks - UnixEpochTicks) / (double)TimeSpan.TicksPerSecond
            : DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Math.Abs(nowSeconds - seconds) > _tolerance.TotalSeconds)
        {
            throw new WebhookVerificationException(WebhookFailure.TimestampOutOfTolerance);
        }

        var candidates = new List<byte[]>();
        foreach (var entry in Separator.Split(signatureHeader!))
        {
            if (candidates.Count == MaxSignatures)
            {
                break;
            }

            if (!entry.StartsWith("v1,", StringComparison.Ordinal))
            {
                continue;
            }

            if (DecodeBase64(entry.Substring(3)) is { Length: SignatureBytes } signature)
            {
                candidates.Add(signature);
            }
        }

        // One HMAC of the body per secret, however many signatures the header claims.
        var message = SignedContent(id!, timestamp!, payload);
        var matched = false;
        foreach (var key in _keys)
        {
            var expected = Hmac(key, message);
            foreach (var candidate in candidates)
            {
                matched = FixedTimeEquals(candidate, expected) | matched;
            }
        }

        if (!matched)
        {
            throw new WebhookVerificationException(WebhookFailure.NoMatchingSignature);
        }
    }

    private static JsonElement Parse(Func<JsonDocument> parse)
    {
        try
        {
            using var document = parse();
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            throw new WebhookVerificationException(WebhookFailure.InvalidPayload);
        }
    }

    private static byte[][] DecodeSecrets(IEnumerable<string> secrets)
    {
        var keys = new List<byte[]>();
        foreach (var secret in secrets)
        {
            if (secret is null)
            {
                throw new ArgumentException("A webhook secret must be a string such as \"whsec_...\".", nameof(secrets));
            }

            var key = secret.StartsWith("whsec_", StringComparison.Ordinal) ? DecodeBase64(secret.Substring(6)) : null;

            // Standard Webhooks symmetric keys contain 24 to 64 random bytes.
            if (key is null || key.Length < 24 || key.Length > 64)
            {
                throw new ArgumentException("A webhook secret must be \"whsec_\" followed by 24 to 64 bytes in base64.", nameof(secrets));
            }

            keys.Add(key);
        }

        if (keys.Count == 0)
        {
            throw new ArgumentException("At least one webhook secret is required.", nameof(secrets));
        }

        return [.. keys];
    }

    /// <summary>Strict base64 like the TypeScript SDK: optional padding, but only canonical encodings are accepted.</summary>
    internal static byte[]? DecodeBase64(string value)
    {
        if (!Base64.IsMatch(value))
        {
            return null;
        }

        var unpadded = value.TrimEnd('=');
        if ((unpadded.Length != value.Length && value.Length % 4 != 0) || unpadded.Length % 4 == 1)
        {
            return null;
        }

        byte[] decoded;
        try
        {
            decoded = Convert.FromBase64String(unpadded.PadRight(unpadded.Length + ((4 - (unpadded.Length % 4)) % 4), '='));
        }
        catch (FormatException)
        {
            return null;
        }

        return Convert.ToBase64String(decoded).TrimEnd('=') == unpadded ? decoded : null;
    }

    private static byte[] SignedContent(string id, string timestamp, byte[] payload)
    {
        var prefix = Encoding.UTF8.GetBytes(id + "." + timestamp + ".");
        var message = new byte[prefix.Length + payload.Length];
        Buffer.BlockCopy(prefix, 0, message, 0, prefix.Length);
        Buffer.BlockCopy(payload, 0, message, prefix.Length, payload.Length);
        return message;
    }

    private static byte[] Hmac(byte[] key, byte[] message)
    {
        using var hmac = new HMACSHA256(key);
        return hmac.ComputeHash(message);
    }

    /// <summary>Compares equal-length byte strings without an early exit on the first difference.</summary>
    private static bool FixedTimeEquals(byte[] a, byte[] b)
    {
        if (a.Length != b.Length)
        {
            return false;
        }

        var difference = 0;
        for (var i = 0; i < a.Length; i++)
        {
            difference |= a[i] ^ b[i];
        }

        return difference == 0;
    }
}
