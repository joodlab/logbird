using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace Logbird.Soak;

/// <summary>
/// Layer 2's checks on the raw rows of a local Logbird's ClickHouse. Search answers one row per event id
/// (<c>LIMIT 1 BY event_id</c>), so it cannot show that the server stored an event twice; the raw rows can, until a
/// background merge of the ReplacingMergeTree collapses copies with the same sorting key. The check counts, without
/// FINAL, the run's event ids that have more than one row, and lists the run's distinct ids so they can be reconciled
/// with what was tracked and read back. It proves itself first with a control that no merge can collapse.
/// <para>
/// Every statement sets the ClickHouse settings it depends on, so no server or user profile changes its meaning, and
/// asks for <c>FORMAT TabSeparated</c> explicitly:
/// reads send <c>final=0</c> (a profile with <c>final=1</c> would apply FINAL and hide duplicates),
/// <c>empty_result_for_aggregation_by_empty_set=0</c> (a count over no rows is 0, not an empty result),
/// <c>max_rows_to_group_by=0</c> and <c>group_by_overflow_mode=throw</c> (no GROUP BY may silently drop ids),
/// <c>max_result_rows=0</c> and <c>result_overflow_mode=throw</c> (no result may be silently cut);
/// the self-test insert sends <c>optimize_on_insert=0</c>, <c>async_insert=0</c> (its rows must be visible to the count
/// that follows) and <c>insert_deduplicate=0</c>.
/// </para>
/// </summary>
internal sealed class ClickHouseCheck : IDisposable
{
    private static readonly (string Name, string Value)[] ReadSettings =
    [
        ("!final", "0"),
        ("!empty_result_for_aggregation_by_empty_set", "0"),
        ("!max_rows_to_group_by", "0"),
        ("!group_by_overflow_mode", "throw"),
        ("!max_result_rows", "0"),
        ("!result_overflow_mode", "throw"),
    ];

    private static readonly (string Name, string Value)[] InsertSettings =
    [
        ("!optimize_on_insert", "0"),
        ("!async_insert", "0"),
        ("!insert_deduplicate", "0"),
    ];

    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _projectId;

    public ClickHouseCheck(Uri url, string user, string password, string database, string projectId)
    {
        // Never follow a redirect and never use a proxy: the login travels in headers and must not leave this machine.
        _http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseProxy = false }) { Timeout = TimeSpan.FromMinutes(5) };
        _http.DefaultRequestHeaders.Add("X-ClickHouse-User", user);
        _http.DefaultRequestHeaders.Add("X-ClickHouse-Key", password);
        _baseUrl = url.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/?database=" + Uri.EscapeDataString(database);
        _projectId = projectId;
    }

    /// <summary>The settings each statement sends, for the report.</summary>
    public static string SettingsSummary
        => "reads: " + string.Join(", ", ReadSettings.Select(s => s.Name.TrimStart((char)33) + "=" + s.Value))
            + "; self-test insert: " + string.Join(", ", InsertSettings.Select(s => s.Name.TrimStart((char)33) + "=" + s.Value));

    public void Dispose() => _http.Dispose();

    /// <summary>Raw rows of one event id in the fixture project (all versions, no FINAL).</summary>
    public async Task<long> RowsOfAsync(string eventId)
        => Count(await QueryAsync(
            "SELECT count() FROM events WHERE project_id = {p:String} AND event_id = {id:String} FORMAT TabSeparated",
            With(ReadSettings, ("p", _projectId), ("id", eventId))).ConfigureAwait(false));

    /// <summary>Event ids of the run with more than one raw row.</summary>
    public async Task<long> DuplicatedIdsAsync(string runTag)
        => Count(await QueryAsync(
            "SELECT count() FROM (SELECT event_id FROM events WHERE project_id = {p:String} AND attributes['metadata.soakRun'] = {r:String} GROUP BY event_id HAVING count() > 1) FORMAT TabSeparated",
            With(ReadSettings, ("p", _projectId), ("r", runTag))).ConfigureAwait(false));

    /// <summary>The run's distinct event ids in the raw rows, as id hashes.</summary>
    public async Task<LongMap> DistinctIdsAsync(string runTag, long expected)
    {
        var text = await QueryAsync(
            "SELECT DISTINCT event_id FROM events WHERE project_id = {p:String} AND attributes['metadata.soakRun'] = {r:String} FORMAT TabSeparated",
            With(ReadSettings, ("p", _projectId), ("r", runTag))).ConfigureAwait(false);
        var ids = new LongMap(expected);
        foreach (var line in text.Split([(char)10], StringSplitOptions.RemoveEmptyEntries))
        {
            ids.TryAdd(LongMap.Hash(line.TrimEnd((char)13)), 0);
        }

        return ids;
    }

    /// <summary>
    /// Inserts one event id twice, at timestamps one millisecond apart, under a fresh self-test tag, and returns whether
    /// the duplicate check reports it. The two rows have different sorting keys (project, timestamp, id), so no merge can
    /// ever collapse them: a healthy check always sees them, and a broken query never does.
    /// </summary>
    public async Task<bool> SelfTestAsync(string selfTestTag, DateTimeOffset at)
    {
        var when = at.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
        var id = "soak-selftest-" + Guid.NewGuid().ToString("N");
        await QueryAsync(
            "INSERT INTO events (project_id, event_id, timestamp, received_at, action, attributes) SELECT {p:String}, {id:String}, toDateTime64({t:String}, 3, 'UTC') + toIntervalMillisecond(number), toDateTime64({t:String}, 3, 'UTC'), 'soak.selftest', map('metadata.soakRun', {r:String}) FROM numbers(2)",
            With(InsertSettings, ("p", _projectId), ("id", id), ("t", when), ("r", selfTestTag))).ConfigureAwait(false);
        return await DuplicatedIdsAsync(selfTestTag).ConfigureAwait(false) == 1;
    }

    private static (string Name, string Value)[] With((string Name, string Value)[] settings, params (string Name, string Value)[] parameters)
        => [.. parameters, .. settings];

    private static long Count(string text)
        => long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var n)
            ? n
            : throw new InvalidOperationException("ClickHouse answered something that is not a count: " + new string(text.Take(80).ToArray()));

    private async Task<string> QueryAsync(string sql, (string Name, string Value)[] parameters)
    {
        var url = new StringBuilder(_baseUrl);
        foreach (var (name, value) in parameters)
        {
            // A name starting with '!' is a ClickHouse setting for this query; the others are query parameters.
            url.Append('&').Append(name.Length > 0 && name[0] == (char)33 ? name.Substring(1) : "param_" + name)
                .Append('=').Append(Uri.EscapeDataString(value));
        }

        using var content = new StringContent(sql, Encoding.UTF8, "text/plain");
        using var response = await _http.PostAsync(url.ToString(), content).ConfigureAwait(false);
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            // ClickHouse's own message; it never contains the credentials, which travel in headers.
            throw new InvalidOperationException("ClickHouse answered " + (int)response.StatusCode + ": " + new string(text.Take(300).ToArray()));
        }

        return text.Trim();
    }
}
