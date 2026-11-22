using System;
using System.IO;
using System.Text;

namespace Logbird.Tests;

/// <summary>
/// The fields FacetQuery accepts are the contracts' FACETABLE_FIELDS, from the golden file written by
/// sdks/dotnet/tests/cross-sdk/facet-fields.ts (the .NET CI job re-checks it against packages/contracts).
/// </summary>
public class FacetFieldParityTests
{
    private static readonly char[] LineFeed = [(char)10];

    [Fact]
    public void Facet_fields_match_the_contracts()
    {
        var golden = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "facet-fields.golden.txt"), Encoding.UTF8)
            .Split(LineFeed, StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(golden, FacetFields.Named);
    }
}
