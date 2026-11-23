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
/// <c>max_result_rows=0</c> and <c>result_overflow_mode=throw</c> (no result may be silently cut),
/// every other <c>*_overflow_mode=throw</c> (read, read leaf, distinct, sort, set, join, transfer, timeout, timeout leaf:
/// a limit a profile sets fails the query instead of returning part of it), <c>limit=0</c> and <c>offset=0</c> (no
/// profile-wide row cap), <c>additional_table_filters={}</c> and <c>additional_result_filter=</c> (no profile-wide
/// filter), <c>use_query_cache=0</c> (no cached, stale answer) and <c>extremes=0</c> (no extra rows after a count);
/// the self-test insert sends <c>optimize_on_insert=0</c>, <c>async_insert=0</c> (its rows must be visible to the count
/// that follows), <c>insert_deduplicate=0</c>, <c>limit=0</c> and <c>offset=0</c> (both rows of its SELECT are inserted).
/// Ids are read as hex, one prefixed line per id, so no id is lost or altered by the text format; an id that is not valid
/// UTF-8 is counted apart, since it can never equal a tracked id.
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
        ("!read_overflow_mode", "throw"),
        ("!read_overflow_mode_leaf", "throw"),
        ("!distinct_overflow_mode", "throw"),
        ("!sort_overflow_mode", "throw"),
        ("!set_overflow_mode", "throw"),
        ("!join_overflow_mode", "throw"),
        ("!transfer_overflow_mode", "throw"),
        ("!timeout_overflow_mode", "throw"),
        ("!timeout_overflow_mode_leaf", "throw"),
        ("!limit", "0"),
        ("!offset", "0"),
        ("!additional_table_filters", "{}"),
        ("!additional_result_filter", ""),
        ("!use_query_cache", "0"),
        ("!extremes", "0"),
    ];

    private static readonly (string Name, string Value)[] InsertSettings =
    [
        ("!optimize_on_insert", "0"),
        ("!async_insert", "0"),
        ("!insert_deduplicate", "0"),
        ("!limit", "0"),
        ("!offset", "0"),
    ];

    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

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

    /// <summary>
    /// The run's distinct event ids in the raw rows, as id hashes. Each id comes back as <c>x</c> plus its bytes in hex, so
    /// an empty id is a line of its own and no character is escaped or lost by the text format. Ids that are not valid
    /// UTF-8 are only counted: decoding would map different byte strings to the same text.
    /// </summary>
    public async Task<(LongMap Ids, int Invalid)> DistinctIdsAsync(string runTag, long expected)
    {
        var text = await QueryAsync(
            "SELECT DISTINCT concat('x', hex(event_id)) FROM events WHERE project_id = {p:String} AND attributes['metadata.soakRun'] = {r:String} FORMAT TabSeparated",
            With(ReadSettings, ("p", _projectId), ("r", runTag))).ConfigureAwait(false);
        var ids = new LongMap(expected);
        var invalid = 0;
        foreach (var line in text.Split([(char)10], StringSplitOptions.RemoveEmptyEntries))
        {
            var hex = line.TrimEnd((char)13);
            if (hex.Length == 0 || hex[0] != 'x' || hex.Length % 2 == 0)
            {
                throw new InvalidOperationException("ClickHouse answered a line that is not a prefixed hex id: " + new string(hex.Take(80).ToArray()));
            }

            var bytes = new byte[(hex.Length - 1) / 2];
            for (var i = 0; i < bytes.Length; i++)
            {
                bytes[i] = (byte)((Nibble(hex[1 + (2 * i)]) << 4) | Nibble(hex[2 + (2 * i)]));
            }

            string id;
            try
            {
                id = StrictUtf8.GetString(bytes);
            }
            catch (DecoderFallbackException)
            {
                invalid++;
                continue;
            }

            ids.TryAdd(LongMap.Hash(id), 0);
        }

        return (ids, invalid);
    }

    private static int Nibble(char c)
        => c is >= '0' and <= '9' ? c - '0'
            : c is >= 'A' and <= 'F' ? c - 'A' + 10
            : c is >= 'a' and <= 'f' ? c - 'a' + 10
            : throw new InvalidOperationException("ClickHouse answered a character that is not hex");

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
