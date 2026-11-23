namespace Logbird.Tests;

/// <summary>
/// The defaults of Logbird's public option types are recorded in src/Logbird/PublicAPI.Defaults.txt, beside the
/// signatures the public API analyzer records. A changed default fails here until that file changes on purpose.
/// </summary>
public class OptionDefaultsTests
{
    [Fact]
    public void Option_defaults_match_the_committed_record()
        => Logbird.ApiBaseline.OptionDefaults.Verify("Logbird", [typeof(LogbirdOptions), typeof(RedactionOptions), typeof(LogbirdReadOptions), typeof(EventSearch)]);
}
