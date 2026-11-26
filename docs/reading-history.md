# Read a record's whole history back

This guide shows how to rebuild a complete change history from Logbird with a read key: when each action happened,
who did it, what changed each time, and what caused what. Follow it top to bottom. Each section states a rule and
shows the call that applies it. The checklist at the end lists what to confirm before you call a history complete.

## What you need

- **A read key** (`lb_read_…`) for the project, or a tenant-scoped key or viewer token for one customer's history.
  Keep read keys on servers: a project read key reads the whole project.
- **The base URL** of your Logbird server: its public origin, for example `https://audit.example.com`.
- **How far back history reaches:** `GET /v1/project` answers with the project's retention policy and the oldest
  event your key can find (section 1). Start every whole-history read there.
- For the recipes: `bash`, `curl` and `jq` for the shell examples, `@logbird/sdk/read` (with `readHistoryHorizon`) for
  TypeScript, and `LogbirdReadClient` (with `GetHistoryHorizonAsync`) from the `Logbird` package for .NET.

```sh
export LOGBIRD_URL=https://audit.example.com
export LOGBIRD_READ_KEY=lb_read_...
```

Every call below was run against a local Logbird server with a fictional fixture: an article `art_100` ("Spring
guide") in tenant `biz_atlas`, edited by a writer, an editor and a support agent, published by a background job that
failed once. The `curl` outputs of sections 1 to 9 show the fixture before the two late events of section 10 arrived;
the script and SDK runs came later and include them. The outputs are trimmed with [`jq`](https://jqlang.org/). The
fixed dates in the examples reproduce the fixture: for your own project, carry your own window, tenant and record
through each call.

## 1. One record's history

**Rule.** Select the record with `record:<type>:<id>`, add `tenant:<id>` when the same id can exist in more than one
tenant, give an explicit `from` and `to`, read oldest first, and follow `nextCursor` with the first page's `range`
until it is null.

A record is its type and id together, across the whole project. Two tenants that both have an `article` with id
`art_100` share that record, so `record:article:art_100` alone returns both histories:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -c '{total, tenants: ([.data[].tenant.id] | unique)}'
```

```json
{"total":10,"tenants":["biz_atlas","biz_cedar"]}
```

Add `tenant:biz_atlas` to read one customer's record; a tenant-scoped key adds that condition for you (section 12).
Add `env:<name>` too when environments of one project reuse the same tenant and record ids.

### Writing selectors

Build selectors from variables with the SDKs (`trailQuery` in TypeScript, `EventSearch.ForTrail`
in .NET), which quote and escape every value. In a raw query, the first unescaped colon after `record:` ends the type:
`record:order:archived:A1` is type `order` and id `archived:A1`, and type `order:archived` is written
`record:order\:archived:A1`. Quote a value that holds spaces or query punctuation, and escape a literal `*` as `\*`
in any value (`tenant:team\*`): an unescaped trailing `*` is a prefix wildcard, even inside quotes. The
[query language](query-language.md) has the full rules.

### Where to start: the history horizon

`GET /v1/project` tells you how far back your key can read: the project's retention policy, and
`oldestEventAt`, the timestamp of the oldest event your key can find through search (within its scope), or null.

```sh
curl -s "$LOGBIRD_URL/v1/project" -H "Authorization: Bearer $LOGBIRD_READ_KEY"
```

```json
{"retentionDays":90,"oldestEventAt":"2026-11-16T09:00:00.000Z"}
```

Use `oldestEventAt` as `from`, and an exclusive `to` more than a day after now (the examples use two days): an event
can be dated up to one day after Logbird received it, and without `to` the window ends at the server clock.
`oldestEventAt` describes what is stored now. Nothing older is stored for your key, but an empty history before it
does not prove that nothing happened: retention deletes, for good, events dated more than `retentionDays` before each
run (hourly, and right after the window is shortened), and raising `retentionDays` brings nothing back. It can also
move back, when an event dated before it arrives later: read it again before each whole-history read.

### The first page

`order=asc` reads oldest first (the default is newest first). A page holds at most 200 events
(`limit`, default 50).

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  --data-urlencode 'order=asc' --data-urlencode 'limit=4' \
  | jq -c '{total, totalExact, range, nextCursor: (.nextCursor | if . then .[0:16] + "…" else . end), data: [.data[] | {timestamp, id, action}]}'
```

```json
{"total":9,"totalExact":true,
 "range":{"from":"2026-11-16T09:00:00.000Z","to":"2026-11-28T00:00:00.000Z"},
 "nextCursor":"WyIyMDI2LTExLTE4…",
 "data":[{"timestamp":"2026-11-16T09:00:00.000Z","id":"evt_0100_created","action":"article.created"},
         {"timestamp":"2026-11-17T10:15:00.000Z","id":"evt_0200_retitled","action":"article.updated"},
         {"timestamp":"2026-11-18T14:00:00.000Z","id":"evt_0300_job_failed","action":"job.failed"},
         {"timestamp":"2026-11-18T14:00:00.000Z","id":"evt_0300_schedule","action":"article.scheduled"}]}
```

- `total` counts every matching event in the window, not only this page. When `totalExact` is false it is a lower
  bound: the count was capped at 10001 or could not be completed. The rows are still all there: page to the end.
- `range` is the window the server applied. Send it back as `from` and `to` on every later page: a cursor carries no
  window, so a page sent without bounds would get a new default window.

### Every page

This script reads the whole history into `history.tsv`, oldest first. It exits non-zero, with a
message, unless every page answered, stated the same window and the last one said `nextCursor: null`:

```bash
#!/usr/bin/env bash
# One record's whole history, oldest first, every page, into $OUT (tab-separated).
# Exits non-zero, with a message, unless every page was read and checked.
set -euo pipefail
trap 'echo "Stopped: the history in $OUT is incomplete." >&2' ERR
Q=${Q:-'record:article:art_100 tenant:biz_atlas'}
OUT=${OUT:-history.tsv}
AUTH="Authorization: Bearer $LOGBIRD_READ_KEY"

HORIZON=$(curl -sSf "$LOGBIRD_URL/v1/project" -H "$AUTH")
FROM=$(jq -er 'if has("oldestEventAt") then .oldestEventAt // "none" else error("no horizon") end' <<<"$HORIZON")
if [ "$FROM" = none ]; then echo 'This key can find no events.' >&2; : >"$OUT"; exit 0; fi
TO=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%S.000Z) # macOS: date -u -v+2d +%Y-%m-%dT%H:%M:%S.000Z

: >"$OUT"
RANGE='' CURSOR=''
while :; do
  PAGE=$(curl -sSf -G "$LOGBIRD_URL/v1/events" -H "$AUTH" \
    --data-urlencode "q=$Q" --data-urlencode "from=$FROM" --data-urlencode "to=$TO" \
    --data-urlencode 'order=asc' --data-urlencode 'limit=200' ${CURSOR:+--data-urlencode "cursor=$CURSOR"})
  # The first page states the window; every later page is sent with it and must state it too.
  GOT=$(jq -ec '.range' <<<"$PAGE")
  if [ -z "$RANGE" ]; then
    RANGE=$GOT FROM=$(jq -r .from <<<"$GOT") TO=$(jq -r .to <<<"$GOT")
  elif [ "$GOT" != "$RANGE" ]; then
    echo "The window changed from $RANGE to $GOT." >&2; false
  fi
  jq -r '(.data | if type == "array" then .[] else error("no data") end) | [.timestamp, .id, .action, .outcome, .receivedAt] | @tsv' <<<"$PAGE" >>"$OUT"
  # Only an explicit null ends the history; a missing nextCursor is an answer this script cannot trust.
  NEXT=$(jq -er 'if has("nextCursor") then .nextCursor // "" else error("no nextCursor") end' <<<"$PAGE")
  [ -z "$NEXT" ] && break
  [ "$NEXT" != "$CURSOR" ] || { echo 'The cursor repeated.' >&2; false; }
  CURSOR=$NEXT
done
# Older data can hold one id at two positions: report it instead of counting it twice.
DUPLICATES=$(cut -f2 "$OUT" | sort | uniq -d)
[ -z "$DUPLICATES" ] || echo "Ids listed more than once: $DUPLICATES" >&2
echo "Complete for $RANGE: $(wc -l <"$OUT") events." >&2
```

Saved as `read-history.sh` and run with `bash read-history.sh` (this run came after section 10, so it includes the two
late events):

```text
Complete for {"from":"2026-11-16T09:00:00.000Z","to":"2026-11-28T01:39:13.000Z"}: 11 events.
2026-11-16T09:00:00.000Z  evt_0100_created        article.created      success
2026-11-17T10:15:00.000Z  evt_0200_retitled       article.updated      success
2026-11-18T14:00:00.000Z  evt_0300_job_failed     job.failed           failure
2026-11-18T14:00:00.000Z  evt_0300_schedule       article.scheduled    success
2026-11-19T08:00:05.000Z  evt_0400_published      article.published    success
2026-11-19T08:00:05.120Z  evt_0410_job_completed  job.completed        success
2026-11-19T12:00:00.000Z  evt_1100_late_summary   article.updated      success
2026-11-20T09:00:00.000Z  evt_1000_late_slug      article.updated      success
2026-11-20T11:30:00.000Z  evt_0500_denied         article.updated      denied
2026-11-21T16:45:00.000Z  evt_0600_values         article.updated      success
2026-11-23T12:00:00.000Z  evt_0800_bulk           article.bulk_tagged  success
```

A failed page (a 429 rate limit, a 503 during maintenance, an expired key) stops the script with
`Stopped: the history in history.tsv is incomplete.` and a non-zero exit. Read again later; never use the partial file
as a history.

### TypeScript

`readHistoryHorizon` gives the horizon and `iterateAuditTrail` reads every page. The iterator sends the
first page's window with every later page and, on servers that report `range`, checks that each page reports it and
that every event lies in it. It fails the pass (`read_window_unverified` or `read_invalid_response`) rather than
return a short history, and yields an id stored at two positions once.

```ts
import { type AuditEvent, iterateAuditTrail, readAuditEvent, readHistoryHorizon } from '@logbird/sdk/read';

const reader = { endpoint: process.env.LOGBIRD_URL ?? '', readKey: process.env.LOGBIRD_READ_KEY ?? '' };

type Change = AuditEvent['changes'][number];
/** One side of a change as its kind says: not set, null, quoted text, a number, boolean or JSON, or hidden. */
function show(text: string, kind: Change['beforeKind']) {
  if (text === '[redacted]') return '(value hidden)';
  if (kind === 'absent') return '(not set)';
  if (kind === 'string') return JSON.stringify(text);
  return kind === undefined ? `${text} (kind unknown)` : text;
}
/** Who did it, by id: the actor, the support person acting as them, and the job attempt that performed it. */
function who(event: AuditEvent) {
  const parts = [`actor ${event.actor?.id ?? '-'}`];
  if (event.impersonator) parts.push(`support ${event.impersonator.id}`);
  if (event.executor?.jobId) parts.push(`job ${event.executor.jobId} #${event.executor.attempt}`);
  return parts.join(', ');
}

const horizon = await readHistoryHorizon(reader);
if (horizon.oldestEventAt) {
  const trail = {
    target: { type: 'article', id: 'art_100' },
    tenant: 'biz_atlas',
    // `to` is exclusive and an event can be dated up to a day ahead: end the window two days from now.
    range: { from: horizon.oldestEventAt, to: new Date(Date.now() + 2 * 86_400_000) },
    order: 'asc' as const,
  };
  for await (const event of iterateAuditTrail(reader, trail)) {
    const changes = event.changes.map((c) => `${c.field}: ${show(c.before, c.beforeKind)} → ${show(c.after, c.afterKind)}`);
    const parent = event.context.parentEventId ? ` (caused by ${event.context.parentEventId})` : '';
    console.log(`${event.timestamp} ${event.id} ${event.action} ${event.outcome} [${who(event)}]${parent} ${changes.join('; ')}`);
  }
}

const detail = await readAuditEvent(reader, 'evt_0400_published');
if (detail === null) console.log('Not found, or outside this key’s scope.');
else console.log(detail.parents.map((parent) => parent.id), detail.childCount, detail.operationSize);
```

```text
2026-11-16T09:00:00.000Z evt_0100_created article.created success [actor usr_writer] title: (not set) → "Spring guide"; status: (not set) → "DRAFT"; wordCount: (not set) → 1200
2026-11-17T10:15:00.000Z evt_0200_retitled article.updated success [actor usr_editor] title: "Spring guide" → "Spring guide 2027"; wordCount: 1200 → 1350
2026-11-18T14:00:00.000Z evt_0300_job_failed job.failed failure [actor usr_writer, support usr_support, job job_41 #1] (caused by evt_0300_schedule)
2026-11-18T14:00:00.000Z evt_0300_schedule article.scheduled success [actor usr_writer, support usr_support] status: "DRAFT" → "SCHEDULED"; scheduledAt: null → "2026-11-19T08:00:00.000Z"
2026-11-19T08:00:05.000Z evt_0400_published article.published success [actor usr_writer, support usr_support, job job_41 #2] (caused by evt_0300_schedule) status: "SCHEDULED" → "PUBLISHED"; publishedAt: (not set) → "2026-11-19T08:00:05.000Z"
…
2026-11-21T16:45:00.000Z evt_0600_values article.updated success [actor usr_editor] price: 10 → 12; priceLabel: "10" → "12"; subtitle: "" → "null"; note: null → (not set); tags: ["travel"] → ["travel","summer"]; embedKey: (value hidden) → (value hidden)
…
[ 'evt_0300_schedule' ] 1 4
```

### .NET

`SearchAllAsync` sends the search you pass on every page, so give it both `From` and `To`. It does not drop
an id stored at two positions: keep a set of ids, as below.

```csharp
using System.Globalization;
using System.Text.Json;
using Logbird;

using var reader = new LogbirdReadClient(new LogbirdReadOptions
{
    Endpoint = new Uri(Environment.GetEnvironmentVariable("LOGBIRD_URL")!),
    ReadKey = Environment.GetEnvironmentVariable("LOGBIRD_READ_KEY"),
});

// One side of a change as its kind says: not set, null, quoted text, a number, boolean or JSON, or hidden.
static string Show(string text, string? kind) => text == "[redacted]" ? "(value hidden)"
    : kind switch { "absent" => "(not set)", "string" => JsonSerializer.Serialize(text), null => $"{text} (kind unknown)", _ => text };

HistoryHorizon horizon = await reader.GetHistoryHorizonAsync();
if (horizon.OldestEventAt is { } oldest)
{
    var trail = EventSearch.ForTrail(
        targetType: "article",
        targetId: "art_100",
        tenantId: "biz_atlas",
        from: DateTimeOffset.Parse(oldest, CultureInfo.InvariantCulture),
        // To is exclusive and an event can be dated up to a day ahead: end the window two days from now.
        to: DateTimeOffset.UtcNow.AddDays(2)) with { Order = SortOrder.Ascending };
    var seen = new HashSet<string>();
    await foreach (var e in reader.SearchAllAsync(trail))
    {
        if (!seen.Add(e.Id)) { Console.WriteLine($"{e.Id} listed twice (older data): check its versions"); continue; }
        var who = $"actor {e.Actor?.Id}" + (e.Impersonator is { } s ? $", support {s.Id}" : "")
            + (e.Executor is { JobId: not "" } x ? $", job {x.JobId} #{x.Attempt}" : "");
        var parent = e.Context.ParentEventId is { Length: > 0 } p ? $" (caused by {p})" : "";
        var changes = string.Join("; ", e.Changes.Select(c => $"{c.Field}: {Show(c.Before, c.BeforeKind)} -> {Show(c.After, c.AfterKind)}"));
        Console.WriteLine($"{e.Timestamp:O} {e.Id} {e.Action} {e.Outcome} [{who}]{parent} {changes}");
    }
}

EventDetail? detail = await reader.GetEventAsync("evt_0400_published");
Console.WriteLine(detail is null ? "Not found, or outside this key's scope."
    : $"parents {string.Join(",", detail.Parents.Select(p => p.Id))}, children {detail.ChildCount}, operation {detail.OperationSize}");
```

```text
2026-11-16T09:00:00.0000000+00:00 evt_0100_created article.created success [actor usr_writer] title: (not set) -> "Spring guide"; status: (not set) -> "DRAFT"; wordCount: (not set) -> 1200
2026-11-17T10:15:00.0000000+00:00 evt_0200_retitled article.updated success [actor usr_editor] title: "Spring guide" -> "Spring guide 2027"; wordCount: 1200 -> 1350
…
2026-11-21T16:45:00.0000000+00:00 evt_0600_values article.updated success [actor usr_editor] price: 10 -> 12; priceLabel: "10" -> "12"; subtitle: "" -> "null"; note: null -> (not set); tags: ["travel"] -> ["travel","summer"]; embedKey: (value hidden) -> (value hidden)
…
parents evt_0300_schedule, children 1, operation 4
```

## 2. The window

**Rule.** Without `from`, a search, facet or export reads only the 24 hours before `to` (and without `to`, up to the
server clock). The `range` in the answer is the window that was read. A history is complete only for that window.

The fixture's last edit was two days before this run, so a search without bounds finds nothing, and says why:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100' | jq -c '{events: (.data | length), total, totalExact, range}'
```

```json
{"events":0,"total":0,"totalExact":true,"range":{"from":"2026-11-25T01:37:34.599Z","to":"2026-11-26T01:37:34.599Z"}}
```

`totalExact: true` here means "exactly 0 in that day", not "this record has no history". Compare `range` with the
window you meant before you treat an answer as complete. The window is half-open (`from` inclusive, `to` exclusive)
and applies to `timestamp`: the event's `occurredAt`, or the time Logbird received it when `occurredAt` was absent or
unusable. In that case the original value is in the event's `payload`, and `attributes["logbird.occurredAt.rejected"]`
holds it when it can be indexed (cut to 256 characters). An export states the same window in the
`X-Logbird-Range-From` and `X-Logbird-Range-To` headers (section 10). Event detail by id has no window.

## 3. Order and ties

**Rule.** Events sort by `timestamp`, then by event `id`, in the direction of `order`. Events in the same millisecond
are ordered by id, not by cause. Read causation from `context.parentEventId`.

In the fixture, the publish job failed in the same millisecond as the scheduling that started it, and its id sorts
first. Read top to bottom, the job seems to fail before the article was scheduled:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' --data-urlencode 'order=asc' \
  --data-urlencode 'from=2026-11-18T14:00:00.000Z' --data-urlencode 'to=2026-11-18T14:00:00.001Z' \
  | jq -r '.data[] | [.timestamp, .id, .action, .outcome, "parentEventId: " + (.context.parentEventId | if . == "" then "(none)" else . end)] | @tsv'
```

```text
2026-11-18T14:00:00.000Z  evt_0300_job_failed  job.failed         failure   parentEventId: evt_0300_schedule
2026-11-18T14:00:00.000Z  evt_0300_schedule    article.scheduled  success   parentEventId: (none)
```

The cursor continues after the last `(timestamp, id)` of the previous page, so over a set of stored events that does
not change, paging returns each stored row once. That is not a snapshot (section 10). Data stored by older releases
can hold one id at two positions; the TypeScript iterator yields it once, and the script and the .NET recipe above
report it. To show cause before effect, reorder events that share a timestamp by their `parentEventId` (the console
does this within each page, section 13).

## 4. Who did it

**Rule.** Every event can name four parties. Keep them apart when you show a history, and identify them by id:
names are display text and can repeat.

| Field | Meaning |
| --- | --- |
| `actor` (`type`, `id`, `name`, `email`) | Whose account or authority the action used: who is responsible. |
| `impersonator` (`id`, `name`) | The person at the keyboard during a support session, acting as the actor. Null when the event has no impersonator id. |
| `executor` (`type`, `id`, `name`, `jobId`, `attempt`) | What performed the action: the API, a worker, a scheduler. `jobId` and `attempt` identify a background job and which try this was. |
| `tenant` (`id`, `name`) | Whose account it happened in. |

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0400_published" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  | jq -c '.event | {actor, impersonator, executor, tenant, email: .attributes["impersonator.email"]}'
```

```json
{"actor":{"type":"user","id":"usr_writer","name":"Sami Writer","email":"sami.writer@example.invalid"},
 "impersonator":{"id":"usr_support","name":"Rita Support"},
 "executor":{"type":"worker","id":"cms-worker","name":"CMS worker","jobId":"job_41","attempt":2},
 "tenant":{"id":"biz_atlas","name":"Atlas Media"},
 "email":"rita.support@example.invalid"}
```

Read it as "Rita Support, signed in as Sami Writer, scheduled it; the worker published it on the job's second
attempt".
- An impersonator's email is not a field: ingest keeps it as the attribute `impersonator.email`.
- An impersonator sent with a name but no id shows as `impersonator: null`; `impersonator.name:` still finds the event
  (section 8).
- `jobId` and `attempt` are sent independently: an empty `jobId` and `attempt` 0 mean that value was not sent.

Under the `actor_email` mask (section 12), the actor's email and the impersonator's email read as stable pseudonyms,
and `context.ip` and `context.userAgent` read as empty under the `ip` and `user_agent` masks. Here
`$LOGBIRD_MASKED_KEY` is a key scoped to `biz_atlas` with all three masks:

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0400_published" -H "Authorization: Bearer $LOGBIRD_MASKED_KEY" \
  | jq -c '.event | {actor, impersonator, email: .attributes["impersonator.email"], ip: .context.ip, userAgent: .context.userAgent}'
```

```json
{"actor":{"type":"user","id":"usr_writer","name":"Sami Writer","email":"masked:4d1a9ea51d099a88dca322e7"},
 "impersonator":{"id":"usr_support","name":"Rita Support"},
 "email":"masked:6987a4e4b47d12f4463cf3e4","ip":"","userAgent":""}
```

An actor or impersonator name that carries an address (contains `@`, equals the email, or is very long) also reads
as a pseudonym under that mask. Ids and other names stay readable, so a masked reader can still tell who did what.

## 5. What changed

**Rule.** `changes` lists the changed fields the producer sent with the event, with `before` and `after` as text.
`beforeKind` and `afterKind` say what the text was: `absent` (that side was not sent), `null`, `string`, `number`,
`boolean` or `json` (an object or array). Read the kind before you read the text.

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0600_values" -H "Authorization: Bearer $LOGBIRD_READ_KEY" | jq -c '.event.changes[]'
```

```json
{"field":"price","before":"10","after":"12","beforeKind":"number","afterKind":"number"}
{"field":"priceLabel","before":"10","after":"12","beforeKind":"string","afterKind":"string"}
{"field":"subtitle","before":"","after":"null","beforeKind":"string","afterKind":"string"}
{"field":"note","before":"null","after":"","beforeKind":"null","afterKind":"absent"}
{"field":"tags","before":"[\"travel\"]","after":"[\"travel\",\"summer\"]","beforeKind":"json","afterKind":"json"}
{"field":"embedKey","before":"[redacted]","after":"[redacted]","beforeKind":"string","afterKind":"string"}
```

- `price` went from the number 10 to 12; `priceLabel` from the text "10" to "12". The text alone is the same.
- `subtitle` went from an empty string to the text "null"; `note` from `null` to not set.
- `absent` means the producer sent no value for that side; it reads as empty text, like an empty string. Logbird
  [recommends](concepts.md#change-values) omitting the side that does not exist, so with producers that follow it,
  an absent `before` marks a created value (`title` in `article.created`) and an absent `after` a removed one (`title`
  in `article.deleted`). Logbird cannot check that a producer followed it.
- A redacted value is the text `[redacted]` with kind `string`: the field changed, and the producer hid the value. The
  SDKs write this marker by default when they redact. Logbird stores it as sent and cannot tell it from someone who
  typed `[redacted]`.
- Events stored before Logbird recorded kinds have no `beforeKind` or `afterKind`. Their text cannot tell absent from
  an empty string, or `null` from the text "null". For those, read the original document.

### Which record a change belongs to

`changes` belongs to the event, not to one of its targets. A record's history
lists the events that named the record; when an event names several records (a refund that targets a payment and a
booking), its `changes` carry no record of their own. Apply a change to a record only when your event schema says
which record it describes (one record per event, or field names that say so).

### The original document

With an unmasked key, the detail route returns `payload`: the stored event document with
its original JSON value types (not the HTTP request's formatting or batch wrapper).

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0600_values" -H "Authorization: Bearer $LOGBIRD_READ_KEY" | jq -c '.payload.changes[0:4]'
```

```json
[{"field":"price","before":10,"after":12},{"field":"priceLabel","before":"10","after":"12"},{"field":"subtitle","before":"","after":"null"},{"field":"note","before":null}]
```

Under any mask, `payload` is null.

### Continuity

For one field of one record, each successful event's `before` should equal the previous one's `after`
(same text and kind), once you have attributed changes to the record and ordered ties by cause. Where it does not, an
event is outside your window or scope, was cut (section 9), or the producer did not send that change. Logbird does not
check this for you.

## 6. Cause and effect

**Rule.** The detail route (`GET /v1/events/{id}`) gives an event's ancestors, its number of children and the size of
its operation. Search lists the children (`parent:`), the whole operation (`operation:`), and a job and its retries
(`job:` and `attempt:`). Keep the tenant condition on each of these, and follow every page.

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0400_published" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  | jq -c '{parentEventId: .event.context.parentEventId, parents: [.parents[].id], childCount, operationSize}'
```

```json
{"parentEventId":"evt_0300_schedule","parents":["evt_0300_schedule"],"childCount":1,"operationSize":4}
```

- `parents` are the nearest ancestors through `context.parentEventId`, furthest first, at most 100. The walk also stops
  at a parent that is not stored or is outside your scope, and at a cycle, so the first entry is not always the root:
  report an ancestor you could not reach rather than treat the first entry as the start.
- `childCount` and `operationSize` count across all stored history in your scope, whatever window you search.
- Detail has no `q`: with a project read key, `parents`, `childCount` and `operationSize` can include another tenant's
  events. For one customer's history, read detail with that tenant's scoped key, or check the tenant of each event.

List the children with `parent:` and the tenant, over a window that covers them (a child can be dated up to a day
after now). Page through them like the record history (with the script, `Q='parent:evt_0300_schedule tenant:biz_atlas'`).

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=parent:evt_0300_schedule tenant:biz_atlas' --data-urlencode 'order=asc' \
  --data-urlencode 'from=2026-11-16T00:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -r '.data[] | [.timestamp, .id, .action, .outcome, .executor.attempt] | @tsv'
```

```text
2026-11-18T14:00:00.000Z  evt_0300_job_failed  job.failed         failure  1
2026-11-19T08:00:05.000Z  evt_0400_published   article.published  success  2
```

With the same call, `q=operation:op_publish_100 tenant:biz_atlas` returns the whole operation (the scheduling, the
failed attempt, the publication and the job's completion, 4 events), `q=job:job_41 tenant:biz_atlas` the job's three
events, and `q=job:job_41 attempt:>1 tenant:biz_atlas` only its retries (2 events). Quote and escape ids as in
section 1.

## 7. Outcomes: refused, failed and partial attempts

**Rule.** `outcome` is what the producer reported. Logbird recommends `success`, `failure` (tried and failed), `denied`
(refused before trying), `partial` and `unknown`, accepts other text, and stores `success` when none was sent. Keep
every outcome in the history; apply as changes only what the producer reports as done.

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas outcome:(failure OR denied)' --data-urlencode 'order=asc' \
  --data-urlencode 'from=2026-11-16T00:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -r '.data[] | [.timestamp, .id, .outcome, .description] | @tsv'
```

```text
2026-11-18T14:00:00.000Z  evt_0300_job_failed  failure  Publish job failed: upstream timeout
2026-11-20T11:30:00.000Z  evt_0500_denied      denied   Refused: missing permission article:update
```

Logbird does not check `changes` against `outcome`. Here neither event carries `changes`. If a failed, denied, partial,
unknown or custom outcome carries some, read them as what was attempted, and mark the state as uncertain unless your
producer says which of them took effect. `outcome:success` selects the events to build state from, but a success label
is only as accurate as the producer that sent it.

## 8. Searching by what changed

**Rule.** `changes.field`, `changes.before` and `changes.after` search the `changes` list. Each matches any element of
the list, and the three are matched independently of each other. Any other `changes.*` key is refused.

When did `status` change? Add `changes.field:status` to the record's query (with the same window as above):

```text
q=record:article:art_100 tenant:biz_atlas changes.field:status
2026-11-16T09:00:00.000Z  evt_0100_created    article.created
2026-11-18T14:00:00.000Z  evt_0300_schedule   article.scheduled
2026-11-19T08:00:05.000Z  evt_0400_published  article.published
```

`changes.after:PUBLISHED` finds events where some change ended with the value `PUBLISHED`, and `changes.before:DRAFT`
events where some change started from `DRAFT`. A value matches its stored text exactly: a number is stored as
JavaScript's shortest spelling when that keeps its exact decimal value (`12.50` as `12.5`), and otherwise as the
digits sent (`12345678901234567890`), so search the stored text, not a number your language rounded. See the
[query language](query-language.md#change-values-and-the-impersonator-name) for every kind.

### Field and value are matched independently

`changes.field:status changes.after:PUBLISHED` means "some change is to
`status`, and some change ends at `PUBLISHED`", not necessarily the same change. In the fixture, the retitling changed
`title` and `wordCount`, and only `wordCount` became 1350, yet this matches it:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas changes.field:title changes.after:1350' \
  --data-urlencode 'from=2026-11-16T00:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -c '{total, data: [.data[] | {id, changes: [.changes[] | {field, after}]}]}'
```

```json
{"total":1,"data":[{"id":"evt_0200_retitled","changes":[{"field":"title","after":"Spring guide 2027"},{"field":"wordCount","after":"1350"}]}]}
```

Use these fields to find candidates, then read each match's `changes` to see which field took which value.

### Unknown keys are refused, not empty

A misspelled or invented `changes` key answers 422 instead of a silent 0:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 changes.to:PUBLISHED' \
  --data-urlencode 'from=2026-11-16T00:00:00.000Z' | jq -c '.error | {code, reason: .details.reason}'
```

```json
{"code":"invalid_query","reason":"unknown_field"}
```

Other unknown keys are attribute lookups and can match nothing without an error: `metadata.chanel:x` is a search for
an attribute that may not exist. Check field names against the [field catalog](query-language.md#field-catalog).
`impersonator.name:"Rita Support"` searches the impersonator's display name.

## 9. Limits and cuts

**Rule.** One event indexes at most 64 targets and 256 changes, and a change field name of at most 256 UTF-16 code
units (after trimming). Past these, the event is still stored whole, but search sees only the indexed part, and the
event says so. Every limit is listed, with what happens past it, in [Limits](limits.md).

The fixture's bulk edit tagged 70 articles in one event. Ingest answered with a warning:

```json
{"accepted":12,"rejected":[],"warnings":[{"index":9,"code":"targets_truncated","sent":70,"indexed":64,"limit":64,
  "reason":"70 targets sent, 64 indexed (at most 64 per event, in the order sent; …). The stored payload keeps them all."}]}
```

The stored event carries the count in a reserved attribute. The 70th target's history does not find the event, and the
64th does:

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0800_bulk" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  | jq -c '{targets: (.event.targets | length), payloadTargets: (.payload.targets | length), cut: .event.attributes["logbird.truncated.targets"]}'
```

```json
{"targets":64,"payloadTargets":70,"cut":"70"}
```

```text
q=record:article:art_bulk_069  →  total 0
q=record:article:art_bulk_063  →  total 1
```

- An event that names your record past its 64th target is not in that record's history, and no search or export by
  that record's selector finds it: `jsonl-evidence` with the same `q` misses it too. To find such events, search a
  wider set with an unmasked key (the tenant, the operation, or `attr.logbird.truncated.targets:*` over the window)
  and read each event's `payload.targets`. A key scoped to one record, or a masked key, cannot: report its history as
  complete only for events that indexed the record.
- Events stored by releases before these counts existed carry no count, or a value a producer wrote: for old data,
  read the originals of every candidate event.
- Indexed ids and types are trimmed and capped (256 code units for an id, 64 for a type), and a numeric id too long to
  index exactly is left out of the index. When your ids can be that long, check the original target in `payload`:
  two long ids that share their first 256 code units index as the same record.
- `attr.logbird.truncated.changes:*` and `attr.logbird.truncated.changeFields:*` find events whose changes or change
  field names were cut. The rest is in the event detail's `payload`, or the `jsonl-evidence` export.
- Producers avoid all of this by splitting a bulk operation into several events with one `context.operationId`.

## 10. Completeness over time

**Rule.** A paging pass is not a snapshot. An event stored during the pass, dated behind your position, is not on the
later pages. Look for late arrivals with `receivedAt`, which narrows the gap but cannot prove it closed, or rebuild
from one export, which reads with a fixed clock.

In the fixture, a pass read the first 7 events (up to 2026-11-20T11:30). Then an event dated 2026-11-20T09:00 arrived.
The rest of the pass returned only the two events after its position:

```json
{"page2":["evt_0600_values","evt_0800_bulk"],"nextCursor":null}
```

### Incremental reads

Keep the history you hold (here `seen.tsv`, the script's output with `receivedAt` in column 5).
To look for late arrivals, run the same complete pass again with `receivedAt:>=` a time well before the latest
`receivedAt` you hold, and keep every event whose id you do not have yet, whatever its receipt time. Receipt times
are not a strict sequence: events share a millisecond, and an event recovered after a storage failure keeps its
original receipt time. Each run reads the horizon and a new `to` again, so it also covers events dated before your
first `from` or after your first `to`. Add the new events to what you hold only after the pass completed.

```bash
set -euo pipefail # a failed pass stops here, before anything is added to seen.tsv
# The latest receipt time in the history you already hold, minus a generous overlap (here ten minutes; GNU date).
LAST=$(cut -f5 seen.tsv | sort | tail -1)
SINCE=$(date -u -d "$LAST - 10 minutes" +%Y-%m-%dT%H:%M:%S.000Z)
# The same complete pass, with a fresh horizon and window, over what arrived since then.
Q="record:article:art_100 tenant:biz_atlas receivedAt:>=$SINCE" OUT=recent.tsv bash read-history.sh
# Keep every event whose id you do not already have, whenever it was received.
awk -F'\t' 'NR == FNR { seen[$2]; next } !($2 in seen)' seen.tsv recent.tsv | tee new.tsv | cut -f1-5
# Only now that the pass completed: add the new events to what you hold.
cat new.tsv >>seen.tsv
```

In the fixture, a second event dated 2026-11-19 arrived after `seen.tsv` was written:

```text
Complete for {"from":"2026-11-16T09:00:00.000Z","to":"2026-11-28T01:38:20.000Z"}: 11 events.
2026-11-19T12:00:00.000Z  evt_1100_late_summary  article.updated  success  2026-11-26T01:38:00.462Z
```

Use absolute times in `q`: a relative time (`receivedAt:>now-1h`) is read against each request's clock. Report a
history kept this way as complete up to your last pass, as far as receipt times allow.

### One-shot reconstructions

An export reads with one fixed clock: it holds every matching event whose stored receipt
time is at or before the moment the export started, in `timestamp`, then `id` order. This keeps the file only if it is
the export you asked for:

```bash
set -euo pipefail
FROM=2026-11-16T09:00:00.000Z TO=2026-11-28T00:00:00.000Z
# -f: an HTTP error writes no file. A transfer cut part way makes curl exit non-zero.
curl -sSf -D headers.txt -G "$LOGBIRD_URL/v1/export" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'format=jsonl' --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' \
  --data-urlencode "from=$FROM" --data-urlencode "to=$TO" -o history.jsonl.part
# Keep the file only if it is the export you asked for, over the window you asked for.
tr -d '\r' <headers.txt | grep -qix 'content-type: application/x-ndjson'
tr -d '\r' <headers.txt | grep -qix "x-logbird-range-from: $FROM"
tr -d '\r' <headers.txt | grep -qix "x-logbird-range-to: $TO"
mv history.jsonl.part history.jsonl
wc -l <history.jsonl
```

```text
11
```

If any step fails, `history.jsonl` is not written: discard `history.jsonl.part` and export again. A line count alone
never proves a file complete. See [event exports](exports.md) for the formats (`csv`, `jsonl`, and `jsonl-evidence`
with the original documents) and the exact membership rule.

### Retries never appear twice

An exact retry of an event (same string id, same content) is accepted without storing
it again. The fixture's creation event was sent twice, and the history holds it once.

## 11. Sets of records

**Rule.** The same rules apply to any set: a tenant (`tenant:biz_atlas`), an actor (`actor:usr_editor`), an operation
(`operation:op_publish_100`), a support person (`impersonator:usr_support`), a set of actions (`action:article.*`) or
just a time range. Combine terms with spaces (AND), `OR` and parentheses.

Facets count the values of one field, optionally split by a second, for the same `q` and window. They answer "who did
what, and how often" at a glance:

```sh
curl -s -G "$LOGBIRD_URL/v1/facets" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' --data-urlencode 'field=actor' --data-urlencode 'by=action' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -c '.range, {otherCount}, (.values[] | {value, label, count, actions: [.groups[] | "\(.value) \(.count)"], groupsOtherCount})'
```

```json
{"from":"2026-11-16T09:00:00.000Z","to":"2026-11-28T00:00:00.000Z"}
{"otherCount":0}
{"value":"usr_editor","label":"Noor Editor","count":5,"actions":["article.updated 4","article.bulk_tagged 1"],"groupsOtherCount":0}
{"value":"usr_writer","label":"Sami Writer","count":5,"actions":["article.created 1","article.published 1","article.scheduled 1","job.completed 1","job.failed 1"],"groupsOtherCount":0}
{"value":"usr_viewer","label":"Lee Viewer","count":1,"actions":["article.updated 1"],"groupsOtherCount":0}
```

Facets show top values only: `otherCount` counts what is past the first level (`limit`, default 10, at most 100), and
each value's `groupsOtherCount` what is past its second level (`byLimit`, default 5, at most 20). When either is not 0,
the list is incomplete: use search for the full set. `field=changes.field` counts indexed change entries, so a field
changed twice in one event counts twice, and attempted changes count too.

## 12. Scoped and masked access

A **tenant-scoped key** (or a viewer token minted for a tenant) reads only that tenant, and nothing in `q` can widen
it. Everything above still applies, with these differences:

- `record:article:art_100` alone returns only the scope's events: with a key scoped to `biz_atlas`, 11 events, none
  from `biz_cedar`.
- `GET /v1/project` gives the oldest event in the scope, not in the project.
- An event outside the scope answers 404 in detail, exactly like an id that was never stored. The parent walk stops at
  the first parent outside the scope, and `childCount` and `operationSize` count in-scope events only.
- Facets, exports and totals count in-scope events only.
- A scope can also be narrowed to one record (`target`) or to action prefixes.

A **masked scope** (`ip`, `user_agent`, `actor_email`) sees the same tenant, record and actions as its scope, and
changes what each event shows:

- `ip` and `user_agent` empty `context.ip` and `context.userAgent`.
- `actor_email` shows the actor's email, the impersonator's email and any address-carrying actor or impersonator name
  as `masked:<24 hex>` pseudonyms, stable within the project. Masked attribute paths match keys in any ASCII letter
  case (`impersonator.Email` is masked like `impersonator.email`).
- Any mask sets the detail's `payload` to null and refuses the `jsonl-evidence` export (422 `masked_export`). A masked
  reader therefore relies on `beforeKind` and `afterKind` for value types (section 5), and cannot read the parts of a
  cut event that were not indexed (section 9).
- Filters and facets on a masked field are refused (422 `invalid_query`, reason `not_allowed`), for example
  `actor.email:sami.writer@example.invalid`.
- Under `actor_email`, a filter reads an address-carrying name as empty, so name and free-text searches can match
  other events than an unmasked key's. For data stored by older releases, an id whose earliest stored versions differ
  answers 404 in detail, and the parent walk stops there.

See [scoped read access](scoped-read-access.md) for the full rules.

## 13. The same thing in the console

- **Record page** (Records, then the record): **History** lists every event for this record, newest first, when no
  time range is set; with a range chosen above it, only that range ("Clear time range" returns to all of it). When the
  record id appears in more than one tenant, it says so and offers a tenant choice. Each row shows its changes, with
  "set to" for a created value, "removed (was …)" for a removed one, and **+N more** when there are more.
- **Field history:** click a field name in a row to keep only the events that changed that field (a `changes.field:`
  filter, shown under **Field history**). Remove it with its ×.
- **Who did it:** the switch above the history shows everything, only what was not done by support, or only what
  support did.
- **Order:** within each loaded page, the console lists a same-millisecond child before its parent. In live mode, new
  arrivals are added at the top as they arrive, so a late event dated in the past can appear above newer events.
- **Event drawer** (click a row): **Who** names the actor (marked "whose account" when support acted), the executor
  and the support person ("at the keyboard"); **Targets** and **Changes** show "indexed of sent" counts when the event
  was cut (for example "Targets · 64 of 70"); the **Changes** table shows each before and after with its kind ("not
  set", `null`, quoted text, "value redacted"); **Causation** shows the parent chain and "This event caused N events";
  **Context** shows the operation, parent, request and when it was received; **Raw payload** shows the original
  document. **Copy as curl** copies the read-key call for this event's detail.
- **Operation page** (from an event's operation): every event of the operation as a causation tree, with an attempt
  label on retries (attempt 2 and later).
- The actor and tenant pages show the same history for a person or a customer.

## Before you call a history complete

- [ ] The window I asked for is the window the server applied (`range`), and every later page was sent with the first
      page's `range`.
- [ ] I followed `nextCursor` until it was null, and every page answered 200.
- [ ] `from` is at or before `oldestEventAt`, read from `GET /v1/project` just before this read, and `to` is more than
      a day after now.
- [ ] The selector is `record:<type>:<id>`, built by the SDK or escaped, with `tenant:<id>` (or a tenant-scoped key)
      if ids can repeat across tenants, and `env:` if environments share ids.
- [ ] I did not read `total` or `totalExact` as "the whole history": they cover the window only.
- [ ] No id appears twice, or I resolved it.
- [ ] Same-millisecond events are ordered by `parentEventId`, not by their position.
- [ ] Actor, impersonator, executor (with `jobId` and `attempt`) and tenant are shown apart, by id.
- [ ] Values are read with `beforeKind` and `afterKind`; events without kinds are checked against `payload`.
- [ ] `[redacted]` is shown as "changed, value hidden", not as a value.
- [ ] Changes are applied to the record only where my event schema says they describe it.
- [ ] Only changes the producer reports as done are applied; other outcomes stay in the history.
- [ ] Searches by value were confirmed by reading each match's `changes` (field and value match independently).
- [ ] Events cut past the 64th target were looked for outside the record selector, or the history says it covers
      indexed events only.
- [ ] Late arrivals were looked for with `receivedAt:>=` and an overlap (best effort), or the history comes from one
      checked export.
- [ ] For each field, every `before` equals the previous `after`, or the gap is explained.
- [ ] An empty stretch before `oldestEventAt` is reported as "not stored", not as "nothing happened".
