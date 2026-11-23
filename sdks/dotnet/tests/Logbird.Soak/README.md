# Logbird .NET SDK soak harness

A console runner that keeps the SDK under sustained load from several threads for minutes or hours, injects failures,
restarts the client every few minutes, and then accounts for every event. It runs on .NET 8, .NET 10 and .NET Framework
4.8 (the `netstandard2.0` build).

```bash
cd sdks/dotnet
dotnet run -c Release -f net8.0 --project tests/Logbird.Soak -- --duration 30m --rate 200 --report ../../soak-report
```

`--rate` x `--duration` may be at most 4 million events (for example 2 h at 500/s or 5 h at 200/s), and producers never
exceed that total (the run may end a few events short of it when the duration elapses). The exact bookkeeping is allocated once, up front, in tables of about 700 MB at that size.

The run ends with a list of checks and exits 1 if any fails. A watchdog writes a failing report and exits 1 if the run
is still going 15 minutes after its duration. `soak-report/` holds:
- `report.json`: configuration, achieved rate, totals, fault and drop counts, latency, resources and every check;
- `metrics.csv`: one row per sample, summed over every client the run created;
- `stand-in-samples.jsonl`.

## The stand-in

The SDK talks over a real loopback socket to an in-process HTTP/1.1 stand-in
(`StandIn.cs`). It checks the ingest key and records every event it stores, every id it acknowledges in an answer that
reached the client, and each id's first-seen content. It injects one fault per request, by weight (`--faults`). The
first requests of a run go once through every configured fault, so even a short run exercises each:

| Fault | What the client sees |
| --- | --- |
| `latency` | up to 2 s, then the answer |
| `partial` | 503 `ingest_pending` whose details settle some events and list the rest as unresolved |
| `unavailable` | 503 `ingest_unavailable`, no details, `Retry-After: 1` |
| `ratelimited` | 429 `rate_limited`, `Retry-After: 1` |
| `reset` | connection reset after the request headers, before the body is read |
| `resetafterstore` | the events are stored, then the connection is reset before the answer |
| `hang` | no answer until 3 s after the request timeout, then a reset |
| `emptyack` | the events are stored, then 202 `{}`: a proxy answering for the server, acknowledging nothing |
| `reject` | 202 with some not-yet-stored events rejected (`invalid_event`) |
| `toolarge` | 413 `payload_too_large` |

A second layer, the same runner as a proxy in front of a real local Logbird with a read-back duplicate check, comes in
its own pull request once it has run against a real server. Its 2-hour run is part of the pre-publication gate.

## Checks

- **Exact accounting** (tracked = every id given to `Track`; stored = what the stand-in stored; dropped = each `OnDrop` report):
  - every tracked event is stored or reported dropped;
  - no event is reported dropped twice;
  - every drop report names a tracked event;
  - nothing untracked is stored;
  - no event arrived with content different from its first arrival;
  - an event both stored and dropped has a reason the docs call "not confirmed" (`HttpError`, `Unacknowledged`,
    `Shutdown`).
- **The client's own counters:**
  - the summed `Stats.Delivered` equals the ids acknowledged to the client and not reported dropped;
  - `Rejected + Dropped` equals the drop reports.
- **Only documented drop reasons.** `TooLarge`, `Invalid` and `InvalidEntityId` also fail, because the harness never
  sends such events.
- **Never throws into the caller**: no `Track` call throws.
- **No failed or hung flush or shutdown:**
  - a periodic `FlushAsync` must return true within 6 minutes (a batch's 5-minute retry budget plus slack);
  - a restart's shutdown must end within 1 minute;
  - the final drain, with faults off, must flush within 2 minutes and shut down within 1;
  - each is watched by a timer that does not rely on the SDK honouring cancellation.
- **Latency:** at most 1% of `Track` calls take over 5 ms, counted exactly. p50, p99, p99.9 and max are reported.
- **Load:** the achieved rate is at least 90% of the requested rate. Producers pace against elapsed time.
- **Bounded resources**, judged only with at least 10 samples over 60 seconds of load:
  - **Comparison:** the last third of the load against a baseline, the median of the samples taken between 10% and
    25% of it.
  - **Heap:** measured after a full collection, it may grow by at most 32 MB. The harness's per-event bookkeeping
    lives in tables allocated before the baseline, so it does not count.
  - **Handles:** at most 1.5 × baseline + 100.
  - **Threads:** at most baseline + 50.
  - **Queue:** its high-water mark, polled every 50 ms, stays within `MaxQueueSize` plus one batch.
    `MaxQueueSize` bounds the events waiting to be sent, while `Stats.QueueLength` also counts the batch being sent.
  - **Bookkeeping:** the harness's per-event tables never grow during the run, and the stand-in writes its samples to
    disk as they arrive. The harness keeps only one small record per resource sample and per periodic flush (a few
    kilobytes an hour); transient allocations are collected by the full collection before each heap sample.

## Fidelity

The stand-in answers the way the server does:
- **Rules it mirrors:**
  - from `apps/server/src/ingest.ts`: 401 `invalid_api_key` without the key; a body that is an array,
    `{ events }` or one event; 400 `invalid_json`; 422 `validation_error` for an empty batch; 413 for more than
    1,000 events or 5 MB;
  - from `packages/clickhouse/src/normalize.ts`: per-event refusals when the action is not a string, the id is
    invalid, or the event is over 256 KB;
  - a missing id gets a generated one;
  - a changed retry of a stored id is answered with `duplicate_id_conflict`.
- **Answer shapes**, from `packages/contracts`: `ingestResponseSchema`, `ingestPendingDetailsSchema` and
  `apiErrorSchema`, with the server's settle-or-list rule for partial results and its 413, 429 and 503 messages.

Every run samples each kind of exchange: request, fault, status, `Retry-After`, answer and what happened to each event.
CI checks the samples with `tests/cross-sdk/validate-stand-in.ts`:
- **Answer shapes:** the contracts' schemas, strict for 202 bodies and 503 details.
- **Settlement:** `accepted` equals the number of ids, and every event of the batch is settled exactly once (by
  rejection, unresolved index or id). `ingest_pending` always carries details, and `eventIds` names the unresolved
  events.
- **Headers and codes:** 429 and 503 carry `Retry-After`, and every error code is the server's for its status.
- **Events:** every accepted event is valid by `eventInputSchema`.
- **Coverage:** every configured fault appears, and a fault counts only when its exchange shows that fault's own answer
  (for example a 429 `rate_limited` for `ratelimited`). Any other answer fails, unless a whole-request error came first.

The `reject` fault rejects valid events on purpose, to exercise the rejection path; that is the safe direction.

## What a 30-minute run can and cannot show

It catches:
- an event lost or counted twice under any of the faults above (the stand-in stores one entry per id, so it cannot show
  a server storing an event twice; that is the real-server layer's job);
- a retry that changes an event;
- a counter that disagrees with what was acknowledged;
- an undocumented drop reason;
- a failed or hung flush or shutdown;
- an exception into the caller;
- a run that cannot hold its rate;
- growth larger than the margins: more than 32 MB of heap, more than 50 threads, or handles beyond 1.5 × baseline +
  100.

With the defaults (a restart every 2 minutes, about 15 restarts and hundreds of faults in 30 minutes), a leak is
caught only if it exceeds about 2 MB, 3 threads or 20 handles per restart (with a handle baseline near 420, as
measured), or the same share per fault.

It does not catch:
- smaller leaks, or memory that grows only after hours, which hide inside the margins and the noise of a full
  collection;
- problems that only appear with real server latency, real TLS or real storage (the stand-in has none).

The long manual run (`workflow_dispatch` with `duration: 2h` or more) and the real-server layer are there for those, and
`metrics.csv` shows any trend directly.

## CI

`.github/workflows/dotnet-soak.yml`:
- **Pull requests that touch the harness:** 3 minutes on ubuntu (net8.0) and windows (net48).
- **Every night:** 30 minutes on ubuntu (net8.0, net10.0) and windows (net48, net8.0).
- **Manually:** any duration up to 5 hours.

It needs no secrets and only `contents: read`. Scheduled and manual runs queue instead of overlapping. A failing run is
red and still uploads `soak-<os>-<tfm>` (report, CSV, samples, kept 30 days). The master reads failures until the owner
names someone else.
