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

    private static bool Redacts(RedactionOptions options, string key) => options.CreateRedactor()!.IsKey(key);

    [Fact]
    public void AddKeys_ignores_ascii_case_only_and_escapes_every_character()
    {
        var options = new RedactionOptions().AddKeys("email", "a.b", "tab\there");
        Assert.True(Redacts(options, "EMAIL"));
        Assert.True(Redacts(options, "workEmail"));
        Assert.False(Redacts(options, "\u0435mail"));
        Assert.True(Redacts(options, "A.B"));
        Assert.False(Redacts(options, "axb"));
        Assert.True(Redacts(options, "TAB\tHERE"));
        Assert.False(Redacts(options, "tabthere"));
        Assert.True(Redacts(options, "password"));
        Assert.Equal(["email", "a.b", "tab\there"], options.AddedKeys);

        // A name with a letter that has a look-alike: the look-alike is not taken for it.
        var kelvin = new RedactionOptions { Keys = new Regex("^$") }.AddKeys("key");
        Assert.True(Redacts(kelvin, "KEY"));
        Assert.False(Redacts(kelvin, "\u212Aey"));
    }

    [Theory]
    [InlineData("secret", RegexOptions.IgnoreCase, "SECRET")]
    [InlineData("(?-x)^token$", RegexOptions.IgnorePatternWhitespace, "token")]
    [InlineData("(?x)token # a trailing comment", RegexOptions.None, "token")]
    [InlineData("token # a trailing comment", RegexOptions.IgnorePatternWhitespace, "token")]
    [InlineData("secret", RegexOptions.ECMAScript, "secret")]
    public void Added_names_and_the_current_pattern_never_change_each_other(string pattern, RegexOptions regexOptions, string protectedKey)
    {
        // The names are matched apart from Keys, which is left as it is: neither its options, an inline option nor a
        // trailing comment changes them, and they do not change what it matches.
        var keys = new Regex(pattern, regexOptions);
        var options = new RedactionOptions { Keys = keys }.AddKeys("\u00E9tat", "email", "two words");

        Assert.Same(keys, options.Keys);
        Assert.True(Redacts(options, protectedKey));
        Assert.True(Redacts(options, "\u00E9tat"));
        Assert.False(Redacts(options, "\u00C9tat"));
        Assert.True(Redacts(options, "workEmail"));
        Assert.True(Redacts(options, "two words"));
        Assert.False(Redacts(options, "twowords"));
    }

    [Fact]
    public void Added_names_survive_replacing_the_pattern_and_count_for_change_fields_by_default()
    {
        var options = new RedactionOptions().AddKeys("iban");
        options.Keys = new Regex("^never$");
        Assert.True(Redacts(options, "iban"));

        var result = options.CreateRedactor()!.Redact(JsonNode.Parse("""
            { "id": "e", "action": "a", "changes": [{ "field": "iban", "before": "x", "after": "y" }] }
            """)!.AsObject());
        Assert.Equal("[redacted]", (string?)result["changes"]![0]!["after"]);

        options.ChangeFields = new Regex("^phone$");
        var own = options.CreateRedactor()!.Redact(JsonNode.Parse("""
            { "id": "e", "action": "a", "changes": [{ "field": "iban", "before": "x", "after": "y" }] }
            """)!.AsObject());
        Assert.Equal("y", (string?)own["changes"]![0]!["after"]);
    }
}
