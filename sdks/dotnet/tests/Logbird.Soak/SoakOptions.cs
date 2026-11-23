using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;

namespace Logbird.Soak;

/// <summary>Command-line options. Keys and the ClickHouse login come from the environment, never from arguments.</summary>
internal sealed class SoakOptions
{
    public static readonly string Usage = string.Join(Environment.NewLine,
    [
        "usage: Logbird.Soak [--duration 30m] [--rate 200] [--producers 4] [--restart-every 2m] [--flush-every 1m]",
        "                    [--sample-every 5s] [--request-timeout 10s] [--max-queue 10000] [--seed 1] [--report soak-report]",
        "                    [--faults ok=50,latency=10,partial=6,unavailable=4,ratelimited=4,reset=3,resetafterstore=4,hang=2,emptyack=3,reject=4,toolarge=1]",
        "                    [--upstream http://127.0.0.1:4741]",
        "Durations end in s, m or h; --duration is 10s to 5h. --upstream accepts only a loopback address and needs",
        "LOGBIRD_SOAK_INGEST_KEY, LOGBIRD_SOAK_READ_KEY, LOGBIRD_SOAK_PROJECT_ID and LOGBIRD_SOAK_CLICKHOUSE_URL (loopback),",
        "LOGBIRD_SOAK_CLICKHOUSE_USER, LOGBIRD_SOAK_CLICKHOUSE_PASSWORD, LOGBIRD_SOAK_CLICKHOUSE_DATABASE.",
    ]);

    public static readonly IReadOnlyDictionary<Fault, int> DefaultFaults = new Dictionary<Fault, int>
    {
        [Fault.Ok] = 50,
        [Fault.Latency] = 10,
        [Fault.PartialUnavailable] = 6,
        [Fault.Unavailable] = 4,
        [Fault.RateLimited] = 4,
        [Fault.Reset] = 3,
        [Fault.ResetAfterStore] = 4,
        [Fault.Hang] = 2,
        [Fault.EmptyAck] = 3,
        [Fault.Reject] = 4,
        [Fault.TooLarge] = 1,
    };

    public TimeSpan Duration { get; private set; } = TimeSpan.FromMinutes(30);

    public int Rate { get; private set; } = 200;

    public int Producers { get; private set; } = 4;

    public TimeSpan RestartEvery { get; private set; } = TimeSpan.FromMinutes(2);

    public TimeSpan FlushEvery { get; private set; } = TimeSpan.FromMinutes(1);

    public TimeSpan SampleEvery { get; private set; } = TimeSpan.FromSeconds(5);

    public TimeSpan RequestTimeout { get; private set; } = TimeSpan.FromSeconds(10);

    public int MaxQueueSize { get; private set; } = 10_000;

    public int Seed { get; private set; } = 1;

    public string ReportDirectory { get; private set; } = "soak-report";

    public IReadOnlyDictionary<Fault, int> Faults { get; private set; } = DefaultFaults;

    public Uri? Upstream { get; private set; }

    public string IngestKey { get; private set; } = "lb_ingest_soakstandin";

    public string? ReadKey { get; private set; }

    public string? ProjectId { get; private set; }

    public Uri? ClickHouseUrl { get; private set; }

    public string? ClickHouseUser { get; private set; }

    public string? ClickHousePassword { get; private set; }

    public string? ClickHouseDatabase { get; private set; }

    /// <summary>The most events one run may track: its exact bookkeeping (five tables) stays under about 700 MB.</summary>
    public const long MaxEvents = 4_000_000;

    /// <summary>An estimate of the events the run tracks, to size the bookkeeping tables once.</summary>
    public long ExpectedEvents => (long)(Rate * Duration.TotalSeconds * 1.3) + 10_000;

    public static SoakOptions Parse(string[] args)
    {
        try
        {
            return ParseCore(args);
        }
        catch (Exception e) when (e is FormatException or OverflowException or UriFormatException)
        {
            throw new ArgumentException(e.Message, e);
        }
    }

    private static SoakOptions ParseCore(string[] args)
    {
        var o = new SoakOptions();
        for (var i = 0; i < args.Length; i++)
        {
            var name = args[i];
            if (i + 1 >= args.Length)
            {
                throw new ArgumentException("missing value for " + name);
            }

            var value = args[++i];
            switch (name)
            {
                case "--duration": o.Duration = Span(value, TimeSpan.FromSeconds(10), TimeSpan.FromHours(5), name); break;
                case "--rate": o.Rate = Range(value, 1, 5000, name); break;
                case "--producers": o.Producers = Range(value, 1, 64, name); break;
                case "--restart-every": o.RestartEvery = Span(value, TimeSpan.FromSeconds(5), TimeSpan.FromHours(5), name); break;
                case "--flush-every": o.FlushEvery = Span(value, TimeSpan.FromSeconds(5), TimeSpan.FromHours(5), name); break;
                case "--sample-every": o.SampleEvery = Span(value, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(5), name); break;
                case "--request-timeout": o.RequestTimeout = Span(value, TimeSpan.FromSeconds(1), TimeSpan.FromMinutes(2), name); break;
                case "--max-queue": o.MaxQueueSize = Range(value, 100, 1_000_000, name); break;
                case "--seed": o.Seed = int.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture); break;
                case "--report": o.ReportDirectory = value; break;
                case "--faults": o.Faults = ParseFaults(value); break;
                case "--upstream": o.Upstream = Loopback(value, "--upstream"); break;
                default: throw new ArgumentException("unknown option " + name);
            }
        }

        if (o.Rate * o.Duration.TotalSeconds > MaxEvents)
        {
            throw new ArgumentException($"--rate x --duration is {o.Rate * o.Duration.TotalSeconds:F0} events; one run tracks at most {MaxEvents} exactly (for example 2h at 500/s or 5h at 200/s)");
        }

        if (o.Upstream is not null)
        {
            o.IngestKey = Required("LOGBIRD_SOAK_INGEST_KEY");
            o.ReadKey = Required("LOGBIRD_SOAK_READ_KEY");
            o.ProjectId = Required("LOGBIRD_SOAK_PROJECT_ID");
            o.ClickHouseUrl = Loopback(Required("LOGBIRD_SOAK_CLICKHOUSE_URL"), "LOGBIRD_SOAK_CLICKHOUSE_URL");
            o.ClickHouseUser = Required("LOGBIRD_SOAK_CLICKHOUSE_USER");
            o.ClickHousePassword = Environment.GetEnvironmentVariable("LOGBIRD_SOAK_CLICKHOUSE_PASSWORD") ?? string.Empty;
            o.ClickHouseDatabase = Required("LOGBIRD_SOAK_CLICKHOUSE_DATABASE");

            // Layer 2 does not use the reject fault (the real server decides rejections); something else must remain.
            if (!o.Faults.Any(f => f.Key != Fault.Reject && f.Value > 0))
            {
                throw new ArgumentException("--upstream needs a fault mix with at least one fault other than reject");
            }

            // The SDK's own HTTP client honours the proxy variables, and on Linux they apply to loopback too: the real
            // ingest key would go to the proxy. Refuse unless loopback is exempt.
            foreach (var variable in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
            {
                if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(variable)) && !LoopbackExempt())
                {
                    throw new ArgumentException(variable + " is set: unset it, or add 127.0.0.1,localhost,::1 to NO_PROXY, so keys never reach a proxy");
                }
            }
        }

        return o;
    }

    /// <summary>The configuration for the report (no keys, no credentials).</summary>
    public JsonObject ToJson()
    {
        var faults = new JsonObject();
        foreach (var f in Faults.OrderBy(f => f.Key))
        {
            faults[f.Key.ToString()] = f.Value;
        }

        return new JsonObject
        {
            ["duration"] = Duration.ToString(),
            ["rate"] = Rate,
            ["producers"] = Producers,
            ["restartEvery"] = RestartEvery.ToString(),
            ["flushEvery"] = FlushEvery.ToString(),
            ["requestTimeout"] = RequestTimeout.ToString(),
            ["maxQueueSize"] = MaxQueueSize,
            ["seed"] = Seed,
            ["upstream"] = Upstream?.ToString(),
            ["faults"] = faults,
        };
    }

    /// <summary>
    /// A loopback http(s) URL with no user info, query or fragment. Requests carry keys, and production limits forbid a
    /// soak run on any shared server, so only this machine is accepted.
    /// </summary>
    private static Uri Loopback(string value, string name)
    {
        var uri = new Uri(value, UriKind.Absolute);
        var host = uri.Host.Trim('[', ']');
        if ((uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !(host == "127.0.0.1" || host == "::1" || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)))
        {
            throw new ArgumentException(name + " must be http(s)://127.0.0.1, ::1 or localhost: a soak run never targets another machine");
        }

        if (uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
        {
            throw new ArgumentException(name + " must not carry user info, a query or a fragment (credentials come from the environment)");
        }

        return new Uri(uri.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/");
    }

    private static bool LoopbackExempt()
    {
        var list = (Environment.GetEnvironmentVariable("NO_PROXY") ?? Environment.GetEnvironmentVariable("no_proxy") ?? string.Empty)
            .Split(',').Select(v => v.Trim()).ToArray();
        return list.Contains("*") || (list.Contains("127.0.0.1") && list.Contains("localhost") && (list.Contains("::1") || list.Contains("[::1]")));
    }

    private static string Required(string variable)
        => Environment.GetEnvironmentVariable(variable) is { Length: > 0 } value ? value : throw new ArgumentException("--upstream needs " + variable);

    private static TimeSpan Span(string value, TimeSpan min, TimeSpan max, string name)
    {
        if (value.Length < 2)
        {
            throw new ArgumentException(name + ": durations end in s, m or h");
        }

        var number = double.Parse(value.Substring(0, value.Length - 1), NumberStyles.Float, CultureInfo.InvariantCulture);
        if (double.IsNaN(number) || double.IsInfinity(number) || number <= 0)
        {
            throw new ArgumentException(name + " must be a positive duration");
        }

        var span = value[value.Length - 1] switch
        {
            's' => TimeSpan.FromSeconds(number),
            'm' => TimeSpan.FromMinutes(number),
            'h' => TimeSpan.FromHours(number),
            _ => throw new ArgumentException(name + ": durations end in s, m or h"),
        };
        return span >= min && span <= max ? span : throw new ArgumentException($"{name} must be between {min} and {max}");
    }

    private static int Range(string value, int min, int max, string name)
    {
        var n = int.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture);
        return n >= min && n <= max ? n : throw new ArgumentException($"{name} must be {min} to {max}");
    }

    private static Dictionary<Fault, int> ParseFaults(string value)
    {
        var names = Enum.GetValues(typeof(Fault)).Cast<Fault>().ToDictionary(f => f.ToString().ToLowerInvariant(), f => f);
        names["partial"] = Fault.PartialUnavailable;
        var faults = new Dictionary<Fault, int>();
        foreach (var pair in value.Split(','))
        {
            var parts = pair.Split('=');
            if (parts.Length != 2 || !names.TryGetValue(parts[0].Trim().ToLowerInvariant(), out var fault))
            {
                throw new ArgumentException("unknown fault " + pair);
            }

            faults[fault] = Range(parts[1], 0, 1000, "fault weight");
        }

        return faults.Values.Any(w => w > 0) ? faults : throw new ArgumentException("--faults needs at least one positive weight");
    }
}
