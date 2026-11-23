namespace Logbird.AspNetCore.Tests;

/// <summary>
/// The defaults of Logbird.AspNetCore's public option types are recorded in src/Logbird.AspNetCore/PublicAPI.Defaults.txt.
/// A changed default fails here until that file changes on purpose.
/// </summary>
public class OptionDefaultsTests
{
    [Fact]
    public void Option_defaults_match_the_committed_record()
        => Logbird.ApiBaseline.OptionDefaults.Verify("Logbird.AspNetCore", [typeof(LogbirdRequestOptions)]);
}
