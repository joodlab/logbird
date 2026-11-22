using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Logbird.Tests;

/// <summary>Mirrors packages/sdk/src/webhooks.test.ts so both SDKs accept and reject exactly the same requests.</summary>
public class WebhookVerifierTests
{
    // Official fixed signing vector ("sign function works"):
    // https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/webhook.test.ts
    private const string Secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // gitleaks:allow -- Official public test vector, not a credential.
    private const string Id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    private const long Timestamp = 1_614_265_330;
    private const string Payload = "{\"test\": 2432232314}";
    private const string Signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
    private static readonly string NewSecret = "whsec_" + Convert.ToBase64String(Enumerable.Repeat((byte)42, 32).ToArray());
    private static readonly string WrongSecret = "whsec_" + Convert.ToBase64String(Enumerable.Repeat((byte)43, 32).ToArray());
    private static readonly DateTimeOffset At = DateTimeOffset.FromUnixTimeSeconds(Timestamp);

    private static Dictionary<string, string?> Headers(string signature = Signature, string? time = null) => new()
    {
        [WebhookHeaders.Id] = Id,
        [WebhookHeaders.Timestamp] = time ?? Timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture),
        [WebhookHeaders.Signature] = signature,
    };

    private static JsonElement Verify(WebhookVerifier verifier, string payload, IDictionary<string, string?> headers, DateTimeOffset? now = null)
        => verifier.Verify(payload, name => headers.TryGetValue(name, out var value) ? value : null, now ?? At);

    private static string IndependentSignature(string key, string body = Payload, long time = Timestamp)
    {
        using var hmac = new HMACSHA256(Convert.FromBase64String(key.Substring(6)));
        return "v1," + Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{Id}.{time}.{body}")));
    }

    private static void Fails(WebhookFailure reason, Action action)
        => Assert.Equal(reason, Assert.Throws<WebhookVerificationException>(action).Reason);

    [Fact]
    public void Signs_and_verifies_the_official_fixed_vector()
    {
        Assert.Equal(Signature, WebhookVerifier.Sign(Id, Timestamp, Payload, Secret));
        var body = Verify(new WebhookVerifier(Secret), Payload, Headers());
        Assert.Equal(2_432_232_314, body.GetProperty("test").GetInt64());
    }

    [Fact]
    public void Signs_exact_utf8_body_bytes_and_rotation_headers_like_independent_crypto()
    {
        const string body = "{ \"action\": \"hotel.updated\", \"description\": \"\u0645\u0631\u062D\u0628\u0627 \u2713\" }\n";
        var signed = WebhookVerifier.Sign(Id, Timestamp, body, Secret, NewSecret);
        Assert.Equal(IndependentSignature(Secret, body) + " " + IndependentSignature(NewSecret, body), signed);
        Assert.Equal("hotel.updated", Verify(new WebhookVerifier(NewSecret), body, Headers(signed)).GetProperty("action").GetString());
        Assert.Equal("hotel.updated", new WebhookVerifier(NewSecret).Verify(Encoding.UTF8.GetBytes(body), Id, Timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture), signed, At).GetProperty("action").GetString());
    }

    [Fact]
    public void Accepts_either_receiver_secret_during_sender_rotation()
    {
        var signed = WebhookVerifier.Sign(Id, Timestamp, Payload, Secret, NewSecret);
        foreach (var receiver in new[] { Secret, NewSecret })
        {
            Verify(new WebhookVerifier(receiver), Payload, Headers(signed));
        }
    }

    [Fact]
    public void Accepts_either_sender_with_multiple_receiver_secrets()
    {
        var verifier = new WebhookVerifier([Secret, NewSecret]);
        foreach (var sender in new[] { Secret, NewSecret })
        {
            Verify(verifier, Payload, Headers(IndependentSignature(sender)));
        }
    }

    [Fact]
    public void Rejects_a_changed_body_id_or_timestamp_and_a_wrong_secret()
    {
        var verifier = new WebhookVerifier(Secret);
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(verifier, Payload + "\n", Headers()));
        var changedId = Headers();
        changedId[WebhookHeaders.Id] = "msg_changed";
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(verifier, Payload, changedId));
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(verifier, Payload, Headers(Signature, (Timestamp + 1).ToString(System.Globalization.CultureInfo.InvariantCulture))));
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(new WebhookVerifier(WrongSecret), Payload, Headers()));
    }

    [Theory]
    [InlineData(WebhookHeaders.Id)]
    [InlineData(WebhookHeaders.Timestamp)]
    [InlineData(WebhookHeaders.Signature)]
    public void Rejects_missing_or_empty_headers(string name)
    {
        foreach (var value in new[] { null, string.Empty })
        {
            var headers = Headers();
            headers[name] = value;
            Fails(WebhookFailure.MissingHeader, () => Verify(new WebhookVerifier(Secret), Payload, headers));
        }
    }

    [Theory]
    [InlineData("hello")]
    [InlineData("1.5")]
    [InlineData("-1")]
    [InlineData("1e9")]
    [InlineData("1614265330junk")]
    [InlineData(" 1614265330")]
    [InlineData("Infinity")]
    [InlineData("9007199254740992")]
    [InlineData("\u0661\u0662")]
    public void Rejects_invalid_timestamps(string time)
        => Fails(WebhookFailure.InvalidTimestamp, () => Verify(new WebhookVerifier(Secret), Payload, Headers(Signature, time)));

    [Theory]
    [InlineData(-300_000)]
    [InlineData(300_000)]
    public void Accepts_the_inclusive_tolerance_edge(long offsetMs)
        => Verify(new WebhookVerifier(Secret), Payload, Headers(), At.AddMilliseconds(offsetMs));

    [Theory]
    [InlineData(-301_000)]
    [InlineData(301_000)]
    [InlineData(-300_001)]
    [InlineData(300_001)]
    public void Rejects_outside_the_tolerance(long offsetMs)
        => Fails(WebhookFailure.TimestampOutOfTolerance, () => Verify(new WebhookVerifier(Secret), Payload, Headers(), At.AddMilliseconds(offsetMs)));

    [Fact]
    public void Honors_custom_and_zero_tolerance()
    {
        Verify(new WebhookVerifier(Secret, TimeSpan.Zero), Payload, Headers());
        Fails(WebhookFailure.TimestampOutOfTolerance, () => Verify(new WebhookVerifier(Secret), Payload, Headers(), At.AddSeconds(301)));
        Verify(new WebhookVerifier(Secret, TimeSpan.FromSeconds(301)), Payload, Headers(), At.AddSeconds(301));
    }

    [Fact]
    public void Uses_the_wall_clock_by_default()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var signed = WebhookVerifier.Sign(Id, now, Payload, Secret);
        new WebhookVerifier(Secret).Verify(Payload, Id, now.ToString(System.Globalization.CultureInfo.InvariantCulture), signed);
        Fails(WebhookFailure.TimestampOutOfTolerance, () => new WebhookVerifier(Secret).Verify(Payload, Id, Timestamp.ToString(System.Globalization.CultureInfo.InvariantCulture), Signature));
    }

    [Fact]
    public void Refuses_a_negative_tolerance_as_a_configuration_error()
        => Assert.Throws<ArgumentOutOfRangeException>(() => new WebhookVerifier(Secret, TimeSpan.FromSeconds(-1)));

    [Theory]
    [InlineData("")]
    [InlineData("whsec_")]
    [InlineData("bare-base64")]
    [InlineData("whsec_!!!!")]
    [InlineData("whsec_YQ==")]
    [InlineData("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData(Secret + "=")]
    [InlineData(Secret + " ")]
    public void Refuses_a_malformed_or_out_of_spec_secret_when_signing_and_verifying(string invalid)
    {
        Assert.Throws<ArgumentException>(() => WebhookVerifier.Sign(Id, Timestamp, Payload, invalid));
        Assert.Throws<ArgumentException>(() => new WebhookVerifier(invalid));
    }

    [Fact]
    public void Refuses_an_empty_secret_list_or_an_invalid_rotation_member()
    {
        Assert.Throws<ArgumentException>(() => WebhookVerifier.Sign(Id, Timestamp, Payload));
        Assert.Throws<ArgumentException>(() => new WebhookVerifier(Array.Empty<string>()));
        Assert.Throws<ArgumentException>(() => WebhookVerifier.Sign(Id, Timestamp, Payload, Secret, "whsec_"));
        Assert.Throws<ArgumentException>(() => new WebhookVerifier([Secret, "whsec_"]));
        Assert.Throws<ArgumentException>(() => new WebhookVerifier([Secret, null!]));
    }

    [Theory]
    [InlineData("v2,AAA=")]
    [InlineData("v1")]
    [InlineData("v1,")]
    [InlineData("v1,not-base64!")]
    [InlineData("v1,AA==")]
    [InlineData(Signature + ",extra")]
    [InlineData("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ")]
    public void Rejects_unknown_malformed_or_truncated_signatures(string value)
        => Fails(WebhookFailure.NoMatchingSignature, () => Verify(new WebhookVerifier(Secret), Payload, Headers(value)));

    [Fact]
    public void Skips_malformed_and_unknown_signatures_alongside_a_valid_v1()
    {
        var value = $"v1 v1,not-base64! v2,{Signature.Substring(3)} {IndependentSignature(WrongSecret)} {Signature}";
        Verify(new WebhookVerifier(Secret), Payload, Headers(value));
    }

    [Theory]
    [InlineData("not JSON")]
    [InlineData("")]
    public void Rejects_an_authenticated_non_json_body(string body)
    {
        Fails(WebhookFailure.InvalidPayload, () => Verify(new WebhookVerifier(Secret), body, Headers(IndependentSignature(Secret, body))));
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(new WebhookVerifier(Secret), body, Headers()));
    }

    [Fact]
    public void Generates_distinct_32_byte_secrets_that_round_trip()
    {
        var generated = WebhookVerifier.GenerateSecret();
        Assert.Matches("^whsec_[A-Za-z0-9+/]{43}=$", generated);
        Assert.Equal(32, Convert.FromBase64String(generated.Substring(6)).Length);
        Assert.NotEqual(generated, WebhookVerifier.GenerateSecret());
        var signed = WebhookVerifier.Sign(Id, Timestamp, Payload, generated);
        Assert.Equal(IndependentSignature(generated), signed);
        Verify(new WebhookVerifier(generated), Payload, Headers(signed));
    }

    [Theory]
    [InlineData("")]
    [InlineData("id.with.dot")]
    [InlineData("id\r\nheader")]
    public void Refuses_unsafe_signer_ids(string invalidId)
        => Assert.Throws<ArgumentException>(() => WebhookVerifier.Sign(invalidId, Timestamp, Payload, Secret));

    [Theory]
    [InlineData(-1L)]
    [InlineData(9_007_199_254_740_992L)]
    public void Refuses_invalid_signer_timestamps(long time)
        => Assert.Throws<ArgumentOutOfRangeException>(() => WebhookVerifier.Sign(Id, time, Payload, Secret));

    [Fact]
    public void Checks_a_bounded_number_of_claimed_signatures()
    {
        var junk = string.Join(" ", Enumerable.Range(0, 300).Select(i => "v1," + Convert.ToBase64String(Enumerable.Repeat((byte)(i % 256), 32).ToArray())));
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(new WebhookVerifier([Secret, NewSecret]), Payload, Headers(junk)));

        // A valid signature past the cap isn't looked at: the cap bounds the work for any header.
        var late = string.Join(" ", Enumerable.Repeat(IndependentSignature(WrongSecret), 10)) + " " + Signature;
        Fails(WebhookFailure.NoMatchingSignature, () => Verify(new WebhookVerifier(Secret), Payload, Headers(late)));
    }
}
