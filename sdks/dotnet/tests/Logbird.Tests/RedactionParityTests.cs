using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Logbird.Tests;

/// <summary>
/// Redaction parity with the TypeScript SDK: Fixtures/redaction-parity.json is run by packages/sdk/src/redact.test.ts
/// too, and both SDKs must produce exactly the expected event for every case.
/// </summary>
public class RedactionParityTests
{
    private static JsonArray Cases()
        => (JsonArray)JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "redaction-parity.json"), Encoding.UTF8))!["cases"]!;

    public static IEnumerable<object[]> Names() => Cases().Select(c => new object[] { (string)c!["name"]! });

    [Theory]
    [MemberData(nameof(Names))]
    public void Matches_the_shared_fixture(string name)
    {
        var parityCase = Cases().Single(c => (string)c!["name"]! == name)!;
        var keys = (string?)parityCase["keys"];
        var changeFields = (string?)parityCase["changeFields"];
        var redactor = new Redactor(
            keys is null ? null : new Regex(keys, RegexOptions.CultureInvariant),
            changeFields is null ? null : new Regex(changeFields, RegexOptions.CultureInvariant),
            (string?)parityCase["replacement"]);
        var input = parityCase["input"]!.AsObject();
        var original = input.ToJsonString();

        var result = redactor.Redact(input);

        Assert.True(JsonNode.DeepEquals(parityCase["expected"], result), name + ": " + result.ToJsonString());
        Assert.Equal(original, input.ToJsonString());
    }

    [Fact]
    public void Lists_the_same_identifier_fields_as_the_typescript_sdk()
        => Assert.Equal(
            ["actor.type", "actor.id", "impersonator.id", "executor.type", "executor.id", "executor.jobId", "executor.attempt", "tenant.id", "targets[].type", "targets[].id"],
            Redactor.IdentifierFields);

    [Fact]
    public void AddKeys_ignores_ascii_case_only_and_escapes_every_character()
    {
        var options = new RedactionOptions().AddKeys("email", "a.b", "tab\there");
        Assert.Matches(options.Keys, "EMAIL");
        Assert.Matches(options.Keys, "workEmail");
        Assert.DoesNotMatch(options.Keys, "еmail");
        Assert.Matches(options.Keys, "A.B");
        Assert.DoesNotMatch(options.Keys, "axb");
        Assert.Matches(options.Keys, "TAB\tHERE");
        Assert.DoesNotMatch(options.Keys, "tabthere");

        // The added names keep their own rules whatever the current pattern's options: not case-insensitive, and not
        // swallowed by a trailing comment of a whitespace-ignoring pattern.
        var caseless = new RedactionOptions { Keys = new Regex("secret", RegexOptions.IgnoreCase) }.AddKeys("état");
        Assert.Matches(caseless.Keys, "SECRET");
        Assert.Matches(caseless.Keys, "ÉTAT".ToLowerInvariant());
        Assert.DoesNotMatch(caseless.Keys, "État");
        var commented = new RedactionOptions { Keys = new Regex("token # the default would be broader", RegexOptions.IgnorePatternWhitespace) }.AddKeys("email", "two words");
        Assert.Matches(commented.Keys, "token");
        Assert.Matches(commented.Keys, "workEmail");
        Assert.Matches(commented.Keys, "two words");
        Assert.DoesNotMatch(commented.Keys, "twowords");
        var ecma = new RedactionOptions { Keys = new Regex("secret", RegexOptions.ECMAScript) }.AddKeys("email");
        Assert.Matches(ecma.Keys, "Email");

        // A name with a letter that has a look-alike: the look-alike is not taken for it.
        var kelvin = new RedactionOptions { Keys = new Regex("^$") }.AddKeys("key");
        Assert.Matches(kelvin.Keys, "KEY");
        Assert.DoesNotMatch(kelvin.Keys, "Key");
    }
}
