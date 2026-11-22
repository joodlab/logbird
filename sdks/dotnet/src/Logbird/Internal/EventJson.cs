using System;
using System.Globalization;
using System.IO;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>Builds the wire JSON for events. Hand-written so it needs no reflection (trimming and AOT safe).</summary>
internal static class EventJson
{
    public static string FormatTimestamp(DateTimeOffset value)
        => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Converts an event into a JSON object the redactor can walk. Caller-owned JSON nodes are deep cloned.</summary>
    public static JsonObject ToJsonObject(AuditEvent e, string id, DateTimeOffset? occurredAt, string? environment, string? source, bool fullEnvelope)
    {
        var json = new JsonObject
        {
            ["id"] = id,
            ["action"] = e.Action,
        };
        if (occurredAt is { } at)
        {
            json["occurredAt"] = FormatTimestamp(at);
        }

        Add(json, "environment", e.Environment ?? environment);
        Add(json, "outcome", e.Outcome);
        Add(json, "severity", e.Severity);
        Add(json, "description", e.Description);
        if (e.Actor is { } actor)
        {
            var node = new JsonObject { ["type"] = actor.Type, ["id"] = actor.Id };
            Add(node, "name", actor.Name);
            Add(node, "email", actor.Email);
            json["actor"] = node;
        }

        if (e.Impersonator is { } impersonator)
        {
            var node = new JsonObject { ["id"] = impersonator.Id };
            Add(node, "name", impersonator.Name);
            json["impersonator"] = node;
        }

        if (e.Executor is { } executor)
        {
            var node = new JsonObject { ["type"] = executor.Type };
            Add(node, "id", executor.Id);
            Add(node, "name", executor.Name);
            Add(node, "jobId", executor.JobId);
            if (executor.Attempt is { } attempt)
            {
                node["attempt"] = attempt;
            }

            json["executor"] = node;
        }

        if (e.Tenant is { } tenant)
        {
            var node = new JsonObject { ["id"] = tenant.Id };
            Add(node, "name", tenant.Name);
            json["tenant"] = node;
        }

        Add(json, "source", e.Source ?? source);
        if (e.EmitTargets)
        {
            var targets = new JsonArray();
            foreach (var target in e.Targets)
            {
                if (target is null)
                {
                    continue;
                }

                var node = new JsonObject { ["type"] = target.Type, ["id"] = target.Id };
                Add(node, "name", target.Name);
                targets.Add((JsonNode)node);
            }

            json["targets"] = targets;
        }

        if (e.EmitChanges)
        {
            var changes = new JsonArray();
            foreach (var change in e.Changes)
            {
                if (change is null)
                {
                    continue;
                }

                var node = new JsonObject { ["field"] = change.Field };
                if (change.HasBefore)
                {
                    node["before"] = change.Before?.DeepClone();
                }

                if (change.HasAfter)
                {
                    node["after"] = change.After?.DeepClone();
                }

                changes.Add((JsonNode)node);
            }

            json["changes"] = changes;
        }

        // Like the TypeScript SDK, context and metadata are always present (empty when unset). The server fingerprints
        // the parsed input, so the same event replayed from either SDK must have the same shape.
        // Without a BeforeSend hook, like the TypeScript SDK's merge, both are always present. After a hook, what it returned
        // is sent as it is: an event it built without them has neither.
        if (fullEnvelope || e.ContextOrNull is not null)
        {
            var contextNode = new JsonObject();
            if (e.ContextOrNull is { } context)
            {
                Add(contextNode, "operationId", context.OperationId);
                Add(contextNode, "parentEventId", context.ParentEventId);
                Add(contextNode, "requestId", context.RequestId);
                Add(contextNode, "traceId", context.TraceId);
                Add(contextNode, "ip", context.Ip);
                Add(contextNode, "userAgent", context.UserAgent);
            }

            json["context"] = contextNode;
        }

        if (fullEnvelope || e.MetadataOrNull is not null)
        {
            json["metadata"] = e.MetadataOrNull?.DeepClone() ?? new JsonObject();
        }

        Add(json, "schemaVersion", e.SchemaVersion);
        return json;
    }

    public static byte[] ToUtf8(JsonNode node) => JsJson.ToUtf8(node);

    public static byte[] BuildBatchBody(QueuedEvent[] batch, int[] indices)
    {
        var length = 13; // {"events":[ ... ]}
        foreach (var index in indices)
        {
            length += batch[index].Json.Length + 1;
        }

        using var stream = new MemoryStream(length);
        WriteAscii(stream, "{\"events\":[");
        for (var i = 0; i < indices.Length; i++)
        {
            if (i > 0)
            {
                stream.WriteByte((byte)',');
            }

            var json = batch[indices[i]].Json;
            stream.Write(json, 0, json.Length);
        }

        WriteAscii(stream, "]}");
        return stream.ToArray();
    }

    /// <summary>Trims the same characters as JavaScript's <c>String.prototype.trim</c>, which the server uses for ids.</summary>
    public static string JsTrim(string value)
    {
        var start = 0;
        var end = value.Length - 1;
        while (start <= end && IsJsWhiteSpace(value[start]))
        {
            start++;
        }

        while (end >= start && IsJsWhiteSpace(value[end]))
        {
            end--;
        }

        return start == 0 && end == value.Length - 1 ? value : value.Substring(start, end - start + 1);
    }

    private static bool IsJsWhiteSpace(char c)
    {
        int code = c;
        return code is 0x09 or 0x0A or 0x0B or 0x0C or 0x0D or 0x20 or 0xA0 or 0x1680 or 0x2028 or 0x2029 or 0x202F
            or 0x205F or 0x3000 or 0xFEFF || code is >= 0x2000 and <= 0x200A;
    }

    private static void Add(JsonObject json, string key, string? value)
    {
        if (value is not null)
        {
            json[key] = value;
        }
    }

    private static void WriteAscii(Stream stream, string value)
    {
        foreach (var c in value)
        {
            stream.WriteByte((byte)c);
        }
    }
}
