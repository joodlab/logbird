namespace Logbird.AspNetCore.Tests;

/// <summary>
/// The public API of Logbird.AspNetCore is recorded in sdks/dotnet/api. Any change to the surface fails here until the
/// baseline is updated on purpose.
/// </summary>
public class PublicApiTests
{
    [Fact]
    public void The_public_API_matches_the_committed_baseline()
        => Logbird.ApiBaseline.PublicApiListing.Verify(typeof(Microsoft.Extensions.DependencyInjection.LogbirdServiceCollectionExtensions).Assembly);
}
