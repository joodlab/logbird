using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace Logbird.Tests;

/// <summary>
/// EventSearch.ForTrail builds the same query as the TypeScript SDK's trailQuery, case by case, from the golden file
/// written by sdks/dotnet/tests/cross-sdk/trail-query.ts (the .NET CI job re-checks it against packages/sdk).
/// </summary>
public class EventSearchParityTests
{
    private static readonly char[] LineFeed = ['\n'];

    [Fact]
    public void Trail_queries_match_the_TypeScript_SDK_for_every_golden_case()
    {
        var lines = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "trail-query.golden.txt"), Encoding.UTF8)
            .Split(LineFeed, StringSplitOptions.RemoveEmptyEntries);
        Assert.True(lines.Length >= 10, "golden cases: " + lines.Length);
        foreach (var line in lines)
        {
            using var document = JsonDocument.Parse(line);
            var input = document.RootElement.GetProperty("input");
            string? targetType = null;
            string? targetId = null;
            if (input.TryGetProperty("target", out var target))
            {
                targetId = target.GetProperty("id").GetString();
                targetType = target.TryGetProperty("type", out var type) ? type.GetString() : null;
            }

            var search = EventSearch.ForTrail(
                targetId: targetId,
                actorId: Text(input, "actor"),
                tenantId: Text(input, "tenant"),
                query: Text(input, "q"),
                targetType: targetType);
            Assert.Equal(document.RootElement.GetProperty("q").GetString(), search.Query);
        }
    }

    [Fact]
    public void A_target_type_needs_a_target_id_and_neither_may_be_empty()
    {
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetType: "invoice"));
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId: "inv_1", targetType: string.Empty));
        Assert.Throws<ArgumentException>(() => EventSearch.ForTrail(targetId: "inv_1", targetType: "a" + (char)0xD800));
    }

    [Fact]
    public void Quote_escapes_quote_backslash_and_star_and_writes_a_carriage_return_as_backslash_r()
    {
        var bs = '\\';
        Assert.Equal("\"a" + bs + "\"b" + bs + bs + "c" + bs + "*d" + bs + "re\tf\ng\"", EventSearch.Quote("a\"b" + bs + "c*d" + (char)13 + "e\tf\ng"));
        Assert.Equal("\"請求書 ✓\"", EventSearch.Quote("請求書 ✓"));
    }

    private static string? Text(JsonElement input, string name)
        => input.TryGetProperty(name, out var value) ? value.GetString() : null;
}
