using System;
using System.Globalization;
using System.IO;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Logbird.Internal;

/// <summary>Builds the wire JSON for events. Hand-written so it needs no reflection (trimming and AOT safe).</summary>
internal static class EventJson
{
    // Non-ASCII text stays readable in the stored raw payload; the output is never embedded in HTML.
    public static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
    };

    public static string FormatTimestamp(DateTimeOffset value)
        => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>Converts an event into a JSON object the redactor can walk. Caller-owned JSON nodes are deep cloned.</summary>
    public static JsonObject ToJsonObject(AuditEvent e, string id, DateTimeOffset occurredAt, string? environment, string? source)
    {
        var json = new JsonObject
        {
            ["id"] = id,
            ["action"] = e.Action,
            ["occurredAt"] = FormatTimestamp(occurredAt),
        };
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
        if (e.HasTargets)
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

        if (e.HasChanges)
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

        if (e.ContextOrNull is { IsEmpty: false } context)
        {
            var node = new JsonObject();
            Add(node, "operationId", context.OperationId);
            Add(node, "parentEventId", context.ParentEventId);
            Add(node, "requestId", context.RequestId);
            Add(node, "traceId", context.TraceId);
            Add(node, "ip", context.Ip);
            Add(node, "userAgent", context.UserAgent);
            json["context"] = node;
        }

        if (e.MetadataOrNull is { Count: > 0 } metadata)
        {
            json["metadata"] = metadata.DeepClone();
        }

        Add(json, "schemaVersion", e.SchemaVersion);
        return json;
    }

    public static byte[] ToUtf8(JsonNode node)
    {
        using var stream = new MemoryStream(512);
        using (var writer = new Utf8JsonWriter(stream, WriterOptions))
        {
            node.WriteTo(writer);
        }

        return stream.ToArray();
    }

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
