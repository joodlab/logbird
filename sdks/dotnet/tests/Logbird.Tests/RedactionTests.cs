using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Logbird.Tests;

/// <summary>Mirrors packages/sdk/src/redact.test.ts.</summary>
public class RedactionTests
{
    [Fact]
    public void Redacts_nested_metadata_actor_fields_arrays_and_change_values_without_mutation()
    {
        var input = JsonNode.Parse("""
            {
              "id": "token-id",
              "action": "password.changed",
              "actor": { "id": "user", "token": "secret" },
              "metadata": { "nested": [{ "api_key": "secret", "safe": 1 }] },
              "changes": [
                { "field": "password", "before": { "value": "secret" }, "after": "secret" },
                { "field": "name", "after": "safe" }
              ]
            }
            """)!.AsObject();
        var original = input.ToJsonString();
        var result = new Redactor().Redact(input);
        var expected = JsonNode.Parse("""
            {
              "id": "token-id",
              "action": "password.changed",
              "actor": { "id": "user", "token": "[redacted]" },
              "metadata": { "nested": [{ "api_key": "[redacted]", "safe": 1 }] },
              "changes": [
                { "field": "password", "before": "[redacted]", "after": "[redacted]" },
                { "field": "name", "after": "safe" }
              ]
            }
            """);
        Assert.True(JsonNode.DeepEquals(expected, result), result.ToJsonString());
        Assert.Equal(original, input.ToJsonString());
    }

    [Fact]
    public void Supports_custom_patterns_and_never_redacts_identifiers()
    {
        var redactor = new Redactor(new Regex("id|email"), new Regex("phone"), "hidden");
        var result = redactor.Redact(JsonNode.Parse("""
            { "id": "id", "action": "action", "actor": { "id": "u", "email": "fiction@example.test" }, "changes": [{ "field": "phone", "after": "123" }] }
            """)!.AsObject());
        Assert.Equal("id", (string?)result["id"]);
        Assert.Equal("action", (string?)result["action"]);
        // Identifier fields are structural and never redacted (stricter than the TypeScript redact()); the email is.
        Assert.Equal("u", (string?)result["actor"]!["id"]);
        Assert.Equal("hidden", (string?)result["actor"]!["email"]);
        Assert.Equal("hidden", (string?)result["changes"]![0]!["after"]);
        Assert.False(result["changes"]![0]!.AsObject().ContainsKey("before"));
    }

    [Fact]
    public void Default_pattern_matches_the_typescript_sdk()
    {
        foreach (var key in new[] { "password", "passwd", "clientSecret", "accessToken", "otp", "apiKey", "api-key", "API_KEY", "Authorization", "cookie", "credentials", "private_key", "privateKey" })
        {
            Assert.Matches(Redactor.DefaultSecretKeys, key);
        }

        foreach (var key in new[] { "name", "email", "status", "id" })
        {
            Assert.DoesNotMatch(Redactor.DefaultSecretKeys, key);
        }
    }

    [Fact]
    public void AddKeys_keeps_the_default_secret_pattern_and_escapes_names()
    {
        var options = new RedactionOptions().AddKeys("email", "a.b");
        var redactor = options.CreateRedactor()!;
        Assert.True(redactor.IsKey("password"));
        Assert.True(redactor.IsKey("Email"));
        Assert.True(redactor.IsKey("a.b"));
        Assert.False(redactor.IsKey("axb"));
        Assert.Matches(Redactor.DefaultSecretKeys, "token");
        Assert.DoesNotMatch(Redactor.DefaultSecretKeys, "email");
    }

    [Fact]
    public void Array_index_keys_are_matched_like_javascript_object_entries()
    {
        var result = new Redactor(new Regex("^1$")).Redact(JsonNode.Parse("""{ "id": "x", "action": "y", "metadata": { "list": ["a", "b"] } }""")!.AsObject());
        Assert.Equal("""["a","[redacted]"]""", result["metadata"]!["list"]!.ToJsonString());
    }
}
