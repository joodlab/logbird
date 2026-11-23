# Logbird .NET SDK soak harness

A console runner that keeps the SDK under sustained load from several threads for minutes or hours, injects failures,
restarts the client every few minutes, and then accounts for every event. It runs on .NET 8, .NET 10 and .NET Framework
4.8 (the `netstandard2.0` build).

```bash
cd sdks/dotnet
dotnet run -c Release -f net8.0 --project tests/Logbird.Soak -- --duration 30m --rate 200 --report ../../soak-report
```

The run ends with a list of checks and exits 1 if any fails. `soak-report/` holds `report.json` (configuration, totals,
fault and drop counts, latency, resource summary, every check), `metrics.csv` (a row every 5 seconds: tracked,
delivered, rejected, dropped, queue length, heap, working set, handles, threads, restarts) and
`stand-in-samples.jsonl`.

## Two layers

**Layer 1: stand-in (CI).** The SDK talks over a real loopback socket to an in-process HTTP/1.1 stand-in
(`StandIn.cs`) that records every event it stores. It injects one fault per request, by weight (`--faults`):

| Fault | What the client sees |
| --- | --- |
| `latency` | up to 2 s, then 202 |
| `partial` | 503 `ingest_pending` whose details settle some events and list the rest as unresolved |
| `unavailable` | 503 `ingest_unavailable`, no details |
| `ratelimited` | 429 `rate_limited`, `Retry-After: 1` |
| `reset` | connection reset before the request is read |
| `resetafterstore` | the events are stored, then the connection is reset before the answer |
| `hang` | no answer until after the request timeout, then a reset |
| `emptyack` | 202 `{}`: a proxy answering for the server, acknowledging nothing |
| `reject` | 202 with some not-yet-stored events rejected (`invalid_event`) |
| `toolarge` | 413 `payload_too_large` |

**Layer 2: real server (manual, part of the pre-publication gate).** `--upstream <url>` turns the stand-in into a
proxy in front of a real Logbird. It forwards every batch and injects the same transport faults: resets, hangs, 429,
503, a 202 replaced by `{}`, a reset after the server stored the batch, and a 503 that reports stored events as
unresolved. The run then reads back every event of the run by its tag (`metadata.soakRun`) and fails if the server
holds any id twice. Keys come from the environment, never from arguments:

```bash
export LOGBIRD_SOAK_INGEST_KEY=... LOGBIRD_SOAK_READ_KEY=...   # a fictional project on a local server
dotnet run -c Release -f net8.0 --project tests/Logbird.Soak -- --upstream http://127.0.0.1:4741 --duration 2h --rate 50
```

It refuses a production host. Before NuGet publishing is enabled, the gate needs one layer-2 run of at least 2 hours
against a local server built from master, with its report attached to the gate brief.

## Checks

- **Exact accounting**, where tracked means every id given to `Track`, stored means what the stand-in stored (or, in
  layer 2, what the server returns), and dropped means each `OnDrop` report:
  - every tracked event is stored or reported dropped;
  - no event is reported dropped twice;
  - nothing untracked is stored;
  - no retried event changed content;
  - an event both stored and dropped has a reason the docs call "not confirmed" (`HttpError`, `Unacknowledged`,
    `Shutdown`).
- **The client's own counters**, layer 1 only:
  - the summed `Stats.Delivered` equals the events stored and not dropped;
  - `Rejected + Dropped` equals the drop reports.
- **Only documented drop reasons** (the `DropReason` values the docs list). `TooLarge`, `Invalid` and
  `InvalidEntityId` fail the run, because the harness never sends such events.
- **Never throws into the caller**: no `Track` call throws.
- **No stuck flush**: a periodic `FlushAsync` takes at most 6 minutes (a batch's 5-minute retry budget plus slack), and
  the final flush, with faults off, completes within 2 minutes.
- **Latency**: `Track` p99 stays under 5 ms. p50, p99, p99.9 and max are reported.
- **Bounded resources** in the last third of the run, against a baseline taken after 10% of it:
  - heap after a full collection grows by at most the harness's own bookkeeping (200 bytes per tracked event) plus
    32 MB;
  - handles stay within 1.5 × baseline + 100;
  - threads stay within baseline + 50;
  - the queue never exceeds `MaxQueueSize`.

## Fidelity

The stand-in's answers follow `packages/contracts`:
- 202 bodies follow `ingestResponseSchema`, and rejection codes come from `ingestRejectionCodeSchema`;
- 503 details follow `ingestPendingDetailsSchema` and the server's settle-or-list rule;
- error bodies follow `apiErrorSchema`, with the server's own codes and messages for 413, 429 and 503.

It refuses what the server refuses: more than 1,000 events or 5 MB a batch, an event over 256 KB, or a missing action.
A stand-in that accepted what the real server rejects would make the accounting meaningless, so every run keeps a
sample of each answer and accepted batch, and CI checks them with `tests/cross-sdk/validate-stand-in.ts` against the
contracts' zod schemas. The `reject` fault rejects valid events on purpose, to exercise the rejection path; that is the
safe direction.

## What a 30-minute run can and cannot show

It catches:
- an event lost or counted twice under any of the faults above;
- a retry that changes an event;
- an undocumented drop reason;
- a stuck flush;
- an exception into the caller;
- growth that happens per restart, per connection or per failure. With a restart every 2 minutes and hundreds of
  faults, a leak of a few objects each time shows within 30 minutes.

It does not catch:
- a slow leak (a few bytes per event, or memory that grows only after hours), which hides inside the 32 MB slack and
  the noise of a full collection;
- handle or thread growth below the margins;
- problems that only appear with real server latency, real TLS or real storage (layer 1 has none).

The long manual run (`workflow_dispatch` with `duration: 2h` or more) and the layer-2 run are there for those, and the
CSV shows any trend directly.

## CI

`.github/workflows/dotnet-soak.yml`:
- **Pull requests that touch the harness:** 3 minutes on ubuntu (net8.0) and windows (net48).
- **Every night:** 30 minutes on ubuntu (net8.0, net10.0) and windows (net48, net8.0).
- **Manually:** any duration up to 5 hours.

It needs no secrets and only `contents: read`. Scheduled and manual runs queue instead of overlapping. A failing run is
red and still uploads `soak-<os>-<tfm>` (report, CSV, samples, kept 30 days). The master reads failures until the owner
names someone else.
