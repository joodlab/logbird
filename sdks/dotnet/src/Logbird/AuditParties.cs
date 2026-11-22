namespace Logbird;

/// <summary>
/// Who caused an event: a signed-in user, an API key, a scheduler or another service.
/// Resolve it from authenticated state, never from request input.
/// </summary>
/// <param name="Type">The kind of actor, for example <c>user</c>, <c>api_key</c>, <c>service</c> or <c>system</c>.</param>
/// <param name="Id">A stable identifier for the actor, such as a user id.</param>
public sealed record AuditActor(string Type, string Id)
{
    /// <summary>Lists only the kind of value, never ids, names or emails, so logging this object cannot leak them.</summary>
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Type = ").Append(Type);
        return true;
    }

    /// <summary>A display name shown in the Logbird console.</summary>
    public string? Name { get; init; }

    /// <summary>The actor's email address, if your privacy policy allows storing it.</summary>
    public string? Email { get; init; }

    /// <summary>Creates a <c>user</c> actor.</summary>
    /// <param name="id">The user's stable id.</param>
    /// <param name="name">An optional display name.</param>
    /// <param name="email">An optional email address.</param>
    public static AuditActor User(string id, string? name = null, string? email = null)
        => new("user", id) { Name = name, Email = email };

    /// <summary>Creates a <c>system</c> actor for scheduled or automatic work, for example <c>AuditActor.System("nightly-billing")</c>.</summary>
    /// <param name="id">The scheduler or subsystem id.</param>
    /// <param name="name">An optional display name.</param>
    public static AuditActor System(string id, string? name = null) => new("system", id) { Name = name };

    /// <summary>Creates a <c>service</c> actor for another backend acting on its own behalf.</summary>
    /// <param name="id">The service id.</param>
    /// <param name="name">An optional display name.</param>
    public static AuditActor Service(string id, string? name = null) => new("service", id) { Name = name };

    /// <summary>Creates an <c>api_key</c> actor for requests authenticated with an API key.</summary>
    /// <param name="id">The key id (never the secret).</param>
    /// <param name="name">An optional display name.</param>
    public static AuditActor ApiKey(string id, string? name = null) => new("api_key", id) { Name = name };
}

/// <summary>The person really operating the session when someone acts on behalf of the <see cref="AuditActor"/>, for example a support agent.</summary>
/// <param name="Id">The impersonator's stable id.</param>
public sealed record AuditImpersonator(string Id)
{
    /// <summary>Lists no values, so logging this object cannot leak ids or names.</summary>
#pragma warning disable CA1822 // The compiler-generated record ToString calls this instance member by name.
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        _ = builder;
        return false;
    }
#pragma warning restore CA1822

    /// <summary>A display name.</summary>
    public string? Name { get; init; }
}

/// <summary>
/// What performed the change: the API process, a background worker, a job attempt.
/// A worker doing work a user requested keeps that user as the actor and sets itself as the executor.
/// </summary>
/// <param name="Type">The kind of executor, for example <c>api</c> or <c>worker</c>.</param>
public sealed record AuditExecutor(string Type)
{
    /// <summary>Lists only the kind of value, never ids, names or emails, so logging this object cannot leak them.</summary>
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Type = ").Append(Type);
        return true;
    }

    /// <summary>The executor's id, for example a service or queue name.</summary>
    public string? Id { get; init; }

    /// <summary>A display name.</summary>
    public string? Name { get; init; }

    /// <summary>The job id when a background job performed the change.</summary>
    public string? JobId { get; init; }

    /// <summary>The job attempt, starting at 1.</summary>
    public int? Attempt { get; init; }

    /// <summary>Creates an <c>api</c> executor.</summary>
    /// <param name="id">The API service id.</param>
    /// <param name="name">An optional display name.</param>
    public static AuditExecutor Api(string? id = null, string? name = null) => new("api") { Id = id, Name = name };

    /// <summary>Creates a <c>worker</c> executor for a background job.</summary>
    /// <param name="id">The worker or queue id.</param>
    /// <param name="jobId">The job id.</param>
    /// <param name="attempt">The attempt number, starting at 1.</param>
    /// <param name="name">An optional display name.</param>
    public static AuditExecutor Worker(string id, string? jobId = null, int? attempt = null, string? name = null)
        => new("worker") { Id = id, JobId = jobId, Attempt = attempt, Name = name };
}

/// <summary>The business scope an event belongs to, such as a customer account or workspace. Resolve it after authorization.</summary>
/// <param name="Id">The tenant's stable id.</param>
public sealed record AuditTenant(string Id)
{
    /// <summary>Lists no values, so logging this object cannot leak ids or names.</summary>
#pragma warning disable CA1822 // The compiler-generated record ToString calls this instance member by name.
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        _ = builder;
        return false;
    }
#pragma warning restore CA1822

    /// <summary>A display name.</summary>
    public string? Name { get; init; }
}

/// <summary>A record the event affected.</summary>
/// <param name="Type">The record type, for example <c>invoice</c>.</param>
/// <param name="Id">The record's stable id.</param>
public sealed record AuditTarget(string Type, string Id)
{
    /// <summary>Lists only the kind of value, never ids, names or emails, so logging this object cannot leak them.</summary>
    private bool PrintMembers(System.Text.StringBuilder builder)
    {
        builder.Append("Type = ").Append(Type);
        return true;
    }

    /// <summary>A safe display name, for example an invoice number.</summary>
    public string? Name { get; init; }
}
