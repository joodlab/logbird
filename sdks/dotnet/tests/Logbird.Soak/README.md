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

## Two layers

**Layer 1: stand-in (CI).** The SDK talks over a real loopback socket to an in-process HTTP/1.1 stand-in
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

**Layer 2: real server (manual, part of the pre-publication gate).** `--upstream <url>` turns the stand-in into a
proxy in front of a real Logbird. It forwards the original request bytes with every header except the hop-by-hop ones
(so the server parses and records exactly what the SDK sent), and lets the server decide about the key, the body and
each event.
- **Faults that reach the server:**
  - `latency` delays the server's answer on its way back;
  - `resetafterstore` forwards the batch, then resets the connection whatever the server answered;
  - `emptyack` replaces a 202 with `{}`;
  - `partial` turns a 202 into a 503 `ingest_pending` that lists some stored events as unresolved (never a rejected
    one, matched by position), keeping the server's other warnings, so the client resends them and the server's
    deduplication is exercised.

  When the server's own answer is not a 202, `emptyack` and `partial` pass its status, body and `Retry-After` through; the sample marks it as
  `passthrough`.
- **Faults that never reach the server:** `reset`, `hang`, `ratelimited`, `unavailable` and `toolarge` answer without
  forwarding, as a broken network or gateway would. `reject` is not used, and the report shows the weights actually
  used.
- **Canary:** before the load, one event goes straight to the server and must be delivered, so a wrong ingest key fails
  at once.
  - It goes through the ingest key, so it can only land in that key's own project. Nothing is written to ClickHouse
    directly, and no load is sent, until the canary has confirmed the project.
  - The server offers no way to learn an ingest key's project without writing, so an ingest key for another project on
    the same local server leaves that one fictional event there before the mismatch below stops the run. The event says
    what it is (action `soak.canary`, source `logbird-soak-canary`, the run tag and a note that it is safe to delete),
    and the failed check names the project it landed in, when the read key can see it, and that one event was written
    there.
  - It is then read back with the read key, and its project must be `LOGBIRD_SOAK_PROJECT_ID`.
  - It must also be found in the configured ClickHouse database under that project before anything is written there
    directly.
- **Self-test:** the duplicate check proves itself with a control no merge can collapse: one event id written at two
  timestamps a millisecond apart (different sorting keys), which must be reported as one duplicated id.
- **Completeness:** after the load, the run pages through its events by tag (`metadata.soakRun`). A failed page is
  retried with the same cursor and the earlier pages are kept. It continues until every id the server acknowledged to
  the client is there, or a deadline of five minutes plus 100 ms per expected page passes.
- **Reconciliation:** the run's distinct event ids in the raw ClickHouse rows must all be tracked events, and every
  event read back must have a raw row. A tracked id present in the raw rows but absent from the read-back (it settled
  after the last page, or search left it out; the two observations cannot tell which) counts as stored, so the
  accounting checks cover it; the report gives their number. An id that is not valid UTF-8 counts as never tracked. An
  empty run passes.
- **Duplicates:** the run counts its event ids with more than one raw row (no `FINAL`).
- **Deduplication exercised:** whenever `partial`, `resetafterstore` or `emptyack` is configured, the server must have
  acknowledged at least one event id again after an earlier answer of its own had already acknowledged it. A resend that
  never reached the server, or that it refused, does not count.
- **ClickHouse settings:** every statement sets what it depends on, so no server or user profile changes its meaning,
  and asks for `FORMAT TabSeparated` explicitly.
  - Reads send `final=0`, `empty_result_for_aggregation_by_empty_set=0`, `max_rows_to_group_by=0`,
    `group_by_overflow_mode=throw`, `max_result_rows=0` and `result_overflow_mode=throw`.
  - Reads also send every other overflow mode as `throw` (`read`, `read_leaf`, `distinct`, `sort`, `set`, `join`,
    `transfer`, `timeout`, `timeout_leaf`), so a limit a profile sets fails the query instead of returning part of it.
  - Reads also send `limit=0`, `offset=0`, `additional_table_filters={}`, `additional_result_filter=` (empty) and
    `use_query_cache=0`: no profile-wide row cap, filter or cached answer. They send `extremes=0`, so no extra rows follow
    a count.
  - The self-test insert sends `optimize_on_insert=0`, `async_insert=0`, `insert_deduplicate=0`, `limit=0` and
    `offset=0`.
  - Event ids are read as hex, one prefixed line each, so the text format can neither drop nor alter one.

  The report lists them too.

**What the read-back proves, and what it cannot.**
- **It proves, for the rows of the run that carry its tag and are visible when the run counts them:**
  - every event the server acknowledged to the client is stored and readable by its id;
  - no event id has more than one raw row;
  - every one of those ids is an event the harness tracked.

  Together with the accounting, that shows the SDK's retries, resends after a lost answer and partial resends (counted
  as "deduplication exercised") did not leave the server with an id stored twice at that moment.
- **It cannot show:**
  - **Copies that leave no trace in those rows.** Two rows with the same sorting key (project, timestamp, id) that a
    background merge collapsed before the count, or an extra copy stored without the run's tag. The count is a
    snapshot, not a history.
  - **An event stored twice under two different ids.** Only a copy under an untracked id is caught (as a raw row that
    was never tracked). A copy re-keyed onto another tracked event's id shows only if both rows survive to the count.
  - **Content.** It compares ids, not payloads. The stand-in's first-arrival fingerprint covers changed retries on the
    wire, not what the server keeps.
  - **Durability across a server restart**, which the run does not perform.
  - **Hash collisions.** Ids are compared as 64-bit hashes; the chance of a collision is about n² / 2⁶⁵, under one in a
    million for the 4 million events a run may track.
  - **Receipt by the SDK.** "Acknowledged to the client" means the proxy finished writing that answer. If the SDK had
    already abandoned the request, `Stats.Delivered` would come out lower and the counter check would fail spuriously,
    unless the SDK then reported that event dropped. The check leaves dropped ids out, and that is the documented outcome
    for an event whose answer was lost: an unconfirmed drop reason, checked by "an event both stored and dropped has an
    unconfirmed reason". Otherwise the check compares totals, so it could pass wrongly only if an SDK overcount elsewhere
    exactly offset a missed answer. It has not happened in a run: answers come within the fault's 2 s, well inside the 10 s request timeout.

**Safety.** Layer 2 accepts only loopback addresses (`127.0.0.1`, `::1`, `localhost`) for the server and ClickHouse,
with no user info, query or fragment. Every HTTP client it uses, the SDK clients included, is given a handler that never
uses a proxy (environment or system) and never follows a redirect, so keys never leave the machine and a production host
is refused. Keys and the ClickHouse login come only from the environment:

```bash
# From the repository root, with the root .env (local services) and a server from master on 127.0.0.1:4741.
# dotenv fills in only what your shell has not set, so pass explicitly whatever differs from .env for the server under
# test, for example DATABASE_URL=<its scratch database> before each command (and its own endpoint below).
# local-only.mjs then refuses unless DATABASE_URL, CLICKHOUSE_URL and REDIS_URL all point at this machine, before the
# fixture script writes anything.
F=/path/outside/the/repo/soak.env
pnpm exec dotenv -e .env -- node sdks/dotnet/tests/Logbird.Soak/local-only.mjs &&
  pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts create "$F" http://127.0.0.1:4741
pnpm exec dotenv -e .env -e "$F" -- sh -c '
  export LOGBIRD_SOAK_INGEST_KEY="$LOGBIRD_IT_INGEST_KEY" LOGBIRD_SOAK_READ_KEY="$LOGBIRD_IT_READ_KEY"
  export LOGBIRD_SOAK_PROJECT_ID="$LOGBIRD_IT_PROJECT_ID" LOGBIRD_SOAK_CLICKHOUSE_URL="$CLICKHOUSE_URL"
  export LOGBIRD_SOAK_CLICKHOUSE_USER="$CLICKHOUSE_USER" LOGBIRD_SOAK_CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD"
  export LOGBIRD_SOAK_CLICKHOUSE_DATABASE="$CLICKHOUSE_DATABASE"
  cd sdks/dotnet && dotnet run -c Release -f net8.0 --project tests/Logbird.Soak -- --upstream http://127.0.0.1:4741 --duration 2h --rate 50'
pnpm exec dotenv -e .env -- node sdks/dotnet/tests/Logbird.Soak/local-only.mjs &&
  pnpm exec dotenv -e .env -- pnpm exec tsx sdks/dotnet/tests/integration/fixture.ts delete "$F"
```

The fixture file holds fresh keys with owner-only permissions; keep it outside the repository. `delete` purges the
project, including the canary and the ClickHouse self-test rows, then the fictional workspace. If a recent insert is
still settling it fails with `ingest_pending` and keeps the file: run it again a minute later.

Before NuGet publishing is enabled, the gate needs one layer-2 run of at least 2 hours against a local server built from
master, with its report attached to the gate brief.

## Checks

- **Exact accounting** (tracked = every id given to `Track`; stored = what the stand-in stored or, in layer 2, what
  the server returns; dropped = each `OnDrop` report):
  - every tracked event is stored or reported dropped;
  - no event is reported dropped twice;
  - every drop report names a tracked event;
  - nothing untracked is stored;
  - no event arrived with content different from its first arrival;
  - an event both stored and dropped has a reason the docs call "not confirmed" (`HttpError`, `Unacknowledged`,
    `Shutdown`).
- **The client's own counters, in both layers:**
  - the summed `Stats.Delivered` equals the ids acknowledged to the client and not reported dropped;
  - `Rejected + Dropped` equals the drop reports.
- **Only documented drop reasons.** `TooLarge` and `Invalid` also fail, because the harness never sends such events.
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
- **Coverage:** every configured fault appears, and a fault counts only when its exchange shows the fault happened: a
  429 `rate_limited` for `ratelimited`, a 503 `ingest_pending` with unresolved events for `partial`, a 202 with a
  rejection the stand-in injected (its reason ends in "(fault injection)") for `reject`, a measured wait of at least 1 ms
  for `latency`. An answer the fault cannot give fails, unless a
  whole-request error came first.

The `reject` fault rejects valid events on purpose, to exercise the rejection path; that is the safe direction.

## What a 30-minute run can and cannot show

It catches:
- an event lost or counted twice under any of the faults above (layer 1 stores one entry per id, so it cannot show the
  server storing an event twice; layer 2's raw-row check does);
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
- problems that only appear with real server latency, real TLS or real storage (layer 1 has none).

The long manual run (`workflow_dispatch` with `duration: 2h` or more) and layer 2 are there for those, and
`metrics.csv` shows any trend directly.

## CI

`.github/workflows/dotnet-soak.yml`:
- **Pull requests that touch the harness:** 3 minutes on ubuntu (net8.0) and windows (net48).
- **Every night:** 30 minutes on ubuntu (net8.0, net10.0) and windows (net48, net8.0).
- **Manually:** any duration up to 5 hours.

It needs no secrets and only `contents: read`. Scheduled and manual runs queue instead of overlapping. A failing run is
red and still uploads `soak-<os>-<tfm>` (report, CSV, samples, kept 30 days). The master reads failures until the owner
names someone else.
