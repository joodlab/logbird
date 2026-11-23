// A small billing API that records an audit trail with Logbird: sign-in, a record change with before and after values,
// and a background job that continues the same operation. Everything here is fictional; copy the patterns, not the data.
using System.Security.Claims;
using Logbird;
using Logbird.AspNetCore;
using Logbird.Example.AspNetCore;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

var builder = WebApplication.CreateBuilder(args);

// Logbird reads Endpoint, IngestKey and the other options from the "Logbird" section. Keep the ingest key out of source
// control: set it with `dotnet user-secrets set Logbird:IngestKey <key>` or the Logbird__IngestKey environment variable.
// Call AddLogbird before registering hosted services that record events, so Logbird stops after them.
builder.Services.AddLogbird(builder.Configuration.GetSection("Logbird"), configureRequests: requests =>
{
    requests.ServiceName = "billing-api";
    requests.ActorEmailClaimTypes.Add(ClaimTypes.Email); // email is opt-in
});

builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options => options.Events.OnRedirectToLogin = context =>
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    });
builder.Services.AddAuthorization();
builder.Services.AddSingleton<InvoiceStore>();
builder.Services.AddSingleton<InvoiceEmailQueue>();
builder.Services.AddHostedService<InvoiceEmailWorker>();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();
app.UseLogbird();

// Sign-in. The user is not on HttpContext.User until the next request, so the event names the actor and tenant itself.
app.MapPost("/sign-in", async (SignIn request, HttpContext http, IAuditLog audit) =>
{
    var user = DemoUsers.Find(request.Email, request.Password);
    if (user is null)
    {
        audit.Record("user.sign_in_failed", e =>
        {
            e.Outcome = AuditOutcome.Failure;
            e.Severity = AuditSeverity.Notice;
            e.Description = "A sign-in attempt failed";
        });
        return Results.Unauthorized();
    }

    var identity = new ClaimsIdentity(
        [
            new Claim("sub", user.Id),
            new Claim("name", user.Name),
            new Claim(ClaimTypes.Email, user.Email),
            new Claim("tenant_id", user.TenantId),
        ],
        CookieAuthenticationDefaults.AuthenticationScheme);
    await http.SignInAsync(new ClaimsPrincipal(identity));

    var eventId = audit.Record("user.signed_in", e =>
    {
        e.Actor = AuditActor.User(user.Id, user.Name, user.Email);
        e.Tenant = new AuditTenant(user.TenantId);
    });
    return Results.Ok(new { eventId });
});

// A record change. Actor, tenant, IP, user agent and request ids come from the request; the event says what changed.
app.MapPut("/invoices/{id}/status", (string id, StatusChange request, ClaimsPrincipal user, InvoiceStore invoices, IAuditLog audit) =>
{
    var change = invoices.SetStatus(user.FindFirstValue("tenant_id"), id, request.Status);
    if (change is null)
    {
        return Results.NotFound();
    }

    var eventId = audit.Record("invoice.status_changed", e => e
        .Target("invoice", id)
        .Change("status", change.Value.Before, change.Value.After));
    return Results.Ok(new { eventId, status = change.Value.After });
}).RequireAuthorization();

// A background job. The request records that it asked for the email, and the job's events continue the same operation
// with the same actor and tenant, linked to that event as their parent.
app.MapPost("/invoices/{id}/send", (string id, ClaimsPrincipal user, InvoiceStore invoices, InvoiceEmailQueue queue, IAuditLog audit) =>
{
    if (!invoices.Exists(user.FindFirstValue("tenant_id"), id))
    {
        return Results.NotFound();
    }

    var eventId = audit.Record("invoice.send_requested", e => e.Target("invoice", id));
    var jobId = queue.Enqueue(id, audit.Carrier(parentEventId: eventId));
    return Results.Accepted(value: new { eventId, jobId });
}).RequireAuthorization();

app.Run();

/// <summary>The sign-in form.</summary>
internal sealed record SignIn(string Email, string Password);

/// <summary>A status change request.</summary>
internal sealed record StatusChange(string Status);
