using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Logbird.AspNetCore;
using Microsoft.Extensions.DependencyInjection;

namespace Logbird.AspNetCore.Tests;

/// <summary>Step-4 review, security and privacy, ASP.NET Core package: A06 (no proxy) and A11 (no input in exceptions).</summary>
public class Step4SecurityAspNetCoreTests
{
    [Fact]
    public void The_named_clients_primary_handler_follows_no_redirect_and_uses_no_proxy()
    {
        using var handler = Assert.IsType<SocketsHttpHandler>(LogbirdServiceCollectionExtensions.CreatePrimaryHandler());
        Assert.False(handler.UseProxy);
        Assert.False(handler.AllowAutoRedirect);
        Assert.Equal(TimeSpan.FromMinutes(5), handler.PooledConnectionLifetime);
    }

    [Theory]
    [InlineData("{\"fictionalSecretMember\":\"x\"}")]
    [InlineData("{\"operationId\":\"op_1\",")]
    [InlineData("[\"fictionalSecretValue\"]")]
    [InlineData("{\"actor\":{\"type\":\"user\",\"id\":7,\"fictionalSecretMember\":1}}")]
    public void A_refused_carrier_says_so_without_quoting_the_input(string json)
    {
        var fromText = Assert.Throws<JsonException>(() => AuditCarrier.FromJson(json));
        var fromBytes = Assert.Throws<JsonException>(() => AuditCarrier.FromJson(Encoding.UTF8.GetBytes(json)));

        foreach (var error in new[] { fromText, fromBytes })
        {
            Assert.DoesNotContain("fictionalSecret", error.ToString(), StringComparison.Ordinal);
            Assert.Null(error.InnerException);
            Assert.Null(error.Path);
        }
    }

    [Fact]
    public void Text_that_is_not_UTF16_valid_is_refused_with_the_same_fixed_exception()
    {
        var error = Assert.Throws<JsonException>(() => AuditCarrier.FromJson("{\"operationId\":\"" + (char)0xD800 + "\"}"));
        Assert.Null(error.InnerException);
    }
}
