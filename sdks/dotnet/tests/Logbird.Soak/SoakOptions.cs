using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json.Nodes;

namespace Logbird.Soak;

/// <summary>Command-line options. Keys for an upstream server come from the environment, never from arguments.</summary>
internal sealed class SoakOptions
{
    public const string Usage =
        "usage: Logbird.Soak [--duration 30m] [--rate 200] [--producers 4] [--restart-every 2m] [--flush-every 1m]\n" +
        "                    [--sample-every 5s] [--request-timeout 5s] [--max-queue 10000] [--seed 1] [--report soak-report]\n" +
        "                    [--faults ok=50,latency=10,partial=6,unavailable=4,ratelimited=4,reset=3,resetafterstore=4,hang=2,emptyack=3,reject=4,toolarge=1]\n" +
        "                    [--upstream http://127.0.0.1:4741]   (then LOGBIRD_SOAK_INGEST_KEY and LOGBIRD_SOAK_READ_KEY are required)";

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

    public TimeSpan RequestTimeout { get; private set; } = TimeSpan.FromSeconds(5);

    public int MaxQueueSize { get; private set; } = 10_000;

    public int Seed { get; private set; } = 1;

    public string ReportDirectory { get; private set; } = "soak-report";

    public IReadOnlyDictionary<Fault, int> Faults { get; private set; } = DefaultFaults;

    public Uri? Upstream { get; private set; }

    public string IngestKey { get; private set; } = "lb_ingest_soakstandin";

    public string? ReadKey { get; private set; }

    public static SoakOptions Parse(string[] args)
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
                case "--duration": o.Duration = Span(value); break;
                case "--rate": o.Rate = Positive(value, name); break;
                case "--producers": o.Producers = Positive(value, name); break;
                case "--restart-every": o.RestartEvery = Span(value); break;
                case "--flush-every": o.FlushEvery = Span(value); break;
                case "--sample-every": o.SampleEvery = Span(value); break;
                case "--request-timeout": o.RequestTimeout = Span(value); break;
                case "--max-queue": o.MaxQueueSize = Positive(value, name); break;
                case "--seed": o.Seed = int.Parse(value, CultureInfo.InvariantCulture); break;
                case "--report": o.ReportDirectory = value; break;
                case "--faults": o.Faults = ParseFaults(value); break;
                case "--upstream": o.Upstream = new Uri(value.TrimEnd('/') + "/"); break;
                default: throw new ArgumentException("unknown option " + name);
            }
        }

        if (o.Upstream is not null)
        {
            o.IngestKey = Environment.GetEnvironmentVariable("LOGBIRD_SOAK_INGEST_KEY") ?? throw new ArgumentException("--upstream needs LOGBIRD_SOAK_INGEST_KEY");
            o.ReadKey = Environment.GetEnvironmentVariable("LOGBIRD_SOAK_READ_KEY") ?? throw new ArgumentException("--upstream needs LOGBIRD_SOAK_READ_KEY");
            if (o.Upstream.Host.IndexOf("joodlab.com", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                // Production limits forbid a soak run there (at most 100 events/s and 300,000 per campaign).
                throw new ArgumentException("--upstream must be a local or test server, never production");
            }
        }

        return o;
    }

    /// <summary>The configuration for the report (no keys).</summary>
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

    private static TimeSpan Span(string value)
    {
        var unit = value.Length > 0 ? value[value.Length - 1] : ' ';
        var number = double.Parse(value.Substring(0, value.Length - 1), CultureInfo.InvariantCulture);
        return unit switch
        {
            's' => TimeSpan.FromSeconds(number),
            'm' => TimeSpan.FromMinutes(number),
            'h' => TimeSpan.FromHours(number),
            _ => throw new ArgumentException("durations end in s, m or h: " + value),
        };
    }

    private static int Positive(string value, string name)
    {
        var n = int.Parse(value, CultureInfo.InvariantCulture);
        return n > 0 ? n : throw new ArgumentException(name + " must be positive");
    }

    private static Dictionary<Fault, int> ParseFaults(string value)
    {
        var names = Enum.GetValues(typeof(Fault)).Cast<Fault>().ToDictionary(f => f.ToString().ToLowerInvariant(), f => f);
        names["partial"] = Fault.PartialUnavailable;
        names["unavailable"] = Fault.Unavailable;
        var faults = new Dictionary<Fault, int>();
        foreach (var pair in value.Split(','))
        {
            var parts = pair.Split('=');
            if (parts.Length != 2 || !names.TryGetValue(parts[0].Trim().ToLowerInvariant(), out var fault))
            {
                throw new ArgumentException("unknown fault " + pair);
            }

            faults[fault] = int.Parse(parts[1], CultureInfo.InvariantCulture);
        }

        return faults;
    }
}
