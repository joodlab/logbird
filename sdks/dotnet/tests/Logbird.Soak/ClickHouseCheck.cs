using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace Logbird.Soak;

/// <summary>
/// Layer 2's duplicate check on the raw rows of a local Logbird's ClickHouse. Search answers one row per event id
/// (<c>LIMIT 1 BY event_id</c>), so it cannot show that the server stored an event twice; the raw rows can, until a
/// background merge of the ReplacingMergeTree collapses them. The check counts, without FINAL, the event ids of the run
/// that have more than one row. It proves itself first: two identical rows inserted under a self-test tag in the same
/// fictional project must be reported as one duplicated id.
/// </summary>
internal sealed class ClickHouseCheck : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _baseUrl;
    private readonly string _projectId;

    public ClickHouseCheck(Uri url, string user, string password, string database, string projectId)
    {
        // Never follow a redirect: the login travels in headers and must not leave this machine.
        _http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(60) };
        _http.DefaultRequestHeaders.Add("X-ClickHouse-User", user);
        _http.DefaultRequestHeaders.Add("X-ClickHouse-Key", password);
        _baseUrl = url.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/?database=" + Uri.EscapeDataString(database);
        _projectId = projectId;
    }

    public void Dispose() => _http.Dispose();

    /// <summary>Raw rows of the run (all versions, no FINAL).</summary>
    public async Task<long> RowsAsync(string runTag)
        => long.Parse(await QueryAsync(
            "SELECT count() FROM events WHERE project_id = {p:String} AND attributes['metadata.soakRun'] = {r:String}",
            ("p", _projectId), ("r", runTag)).ConfigureAwait(false), CultureInfo.InvariantCulture);

    /// <summary>Event ids of the run with more than one raw row.</summary>
    public async Task<long> DuplicatedIdsAsync(string runTag)
        => long.Parse(await QueryAsync(
            "SELECT count() FROM (SELECT event_id FROM events WHERE project_id = {p:String} AND attributes['metadata.soakRun'] = {r:String} GROUP BY event_id HAVING count() > 1)",
            ("p", _projectId), ("r", runTag)).ConfigureAwait(false), CultureInfo.InvariantCulture);

    /// <summary>
    /// Inserts two identical rows (one statement, so one part) under a fresh self-test tag and returns whether the check
    /// reports them as one duplicated id. A background merge could collapse them before the count, so a healthy check
    /// gets three attempts; a broken query never reports them.
    /// </summary>
    public async Task<bool> SelfTestAsync(string selfTestTag, DateTimeOffset at)
    {
        var when = at.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var tag = selfTestTag + "-" + attempt.ToString(CultureInfo.InvariantCulture);
            var id = "soak-selftest-" + Guid.NewGuid().ToString("N");
            await QueryAsync(
                "INSERT INTO events (project_id, event_id, timestamp, received_at, action, attributes) SELECT {p:String}, {id:String}, toDateTime64({t:String}, 3, 'UTC'), toDateTime64({t:String}, 3, 'UTC'), 'soak.selftest', map('metadata.soakRun', {r:String}) FROM numbers(2)",
                ("p", _projectId), ("id", id), ("t", when), ("r", tag)).ConfigureAwait(false);
            if (await DuplicatedIdsAsync(tag).ConfigureAwait(false) == 1)
            {
                return true;
            }
        }

        return false;
    }

    private async Task<string> QueryAsync(string sql, params (string Name, string Value)[] parameters)
    {
        var url = new StringBuilder(_baseUrl);
        foreach (var (name, value) in parameters)
        {
            url.Append("&param_").Append(name).Append('=').Append(Uri.EscapeDataString(value));
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
