namespace Logbird.Tests;

/// <summary>
/// The public API of Logbird is recorded in sdks/dotnet/api: net8.0 from the .NET 8 and .NET 10 runs, netstandard2.0
/// from the .NET Framework run. Any change to the surface fails here until the baseline is updated on purpose.
/// </summary>
public class PublicApiTests
{
    [Fact]
    public void The_public_API_matches_the_committed_baseline()
        => Logbird.ApiBaseline.PublicApiListing.Verify(typeof(LogbirdClient).Assembly);
}
