# Read a record's whole history back

This guide shows how to rebuild a complete change history from Logbird with a read key: when each action happened,
who did it, what changed each time, and what caused what. Follow it top to bottom. Each section states a rule and
shows the call that applies it. The checklist at the end lists what to confirm before you call a history complete.

Every call below was run against a local Logbird server with a fictional fixture: an article `art_100` ("Spring
guide") in tenant `biz_atlas`, edited by a writer, an editor and a support agent, published by a background job that
failed once. Sections 1 to 9 show the fixture before a late event arrives in section 10. The outputs are trimmed with
[`jq`](https://jqlang.org/). Your ids, times and counts will differ.

You need the server's public origin and a read key (`lb_read_…`). Keep read keys on servers: a project read key reads
the whole project.

```sh
export LOGBIRD_URL=https://audit.example.com
export LOGBIRD_READ_KEY=lb_read_...
```

The TypeScript recipes use `@logbird/sdk/read` and the .NET recipes use `LogbirdReadClient` from the `Logbird` package.

## 1. One record's history

**Rule.** Select the record with `record:<type>:<id>`, add `tenant:<id>` when the same id can exist in more than one
tenant, give an explicit `from` (and `to`), read oldest first, and follow `nextCursor` with the first page's `range`
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

Add `tenant:biz_atlas` to read one customer's record. A tenant-scoped key adds that condition for you (section 12).

**Where to start.** `GET /v1/project` tells you how far back your key can read: the project's retention policy, and
`oldestEventAt`, the timestamp of the oldest event your key can find through search (within its scope), or null.

```sh
curl -s "$LOGBIRD_URL/v1/project" -H "Authorization: Bearer $LOGBIRD_READ_KEY"
```

```json
{"retentionDays":90,"oldestEventAt":"2026-11-16T09:00:00.000Z"}
```

Use `oldestEventAt` as `from`. Use a `to` at least a day after now: an event can be dated up to one day after Logbird
received it, and without `to` the window ends at the server clock. `oldestEventAt` describes what is stored now.
Nothing older is stored for your key, but an empty history before it does not prove that nothing happened: retention
deletes, for good, events dated more than `retentionDays` before each run (hourly, and right after the window is
shortened), and raising `retentionDays` brings nothing back.

**The first page.** `order=asc` reads oldest first (the default is newest first). A page holds at most 200 events
(`limit`, default 50).

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  --data-urlencode 'order=asc' --data-urlencode 'limit=4' \
  | jq -c '{total, totalExact, range, nextCursor: (.nextCursor | .[0:16] + "…"), data: [.data[] | {timestamp, id, action}]}'
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
  bound: the count stops at 10001, or did not finish in time. The rows are still all there: page to the end.
- `range` is the window the server applied. Send it back as `from` and `to` on every later page: a cursor carries no
  window, so a page sent without bounds would get a new default window.

**Every page.** This loop reads the whole history, oldest first (GNU `date`; on macOS use `date -u -v+2d`):

```sh
Q='record:article:art_100 tenant:biz_atlas'
FROM=$(curl -s "$LOGBIRD_URL/v1/project" -H "Authorization: Bearer $LOGBIRD_READ_KEY" | jq -r .oldestEventAt)
TO=$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%S.000Z)
CURSOR=''
while :; do
  # -f: a status other than 2xx fails the request, and the loop stops and says so.
  PAGE=$(curl -sf -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
    --data-urlencode "q=$Q" --data-urlencode "from=$FROM" --data-urlencode "to=$TO" \
    --data-urlencode 'order=asc' --data-urlencode 'limit=200' ${CURSOR:+--data-urlencode "cursor=$CURSOR"}) \
    || { echo 'A page failed: this history is incomplete. Retry from the last cursor.' >&2; break; }
  # The first page's range is the window every later page uses.
  FROM=$(jq -r .range.from <<<"$PAGE"); TO=$(jq -r .range.to <<<"$PAGE")
  jq -r '.data[] | [.timestamp, .id, .action, .outcome] | @tsv' <<<"$PAGE"
  CURSOR=$(jq -r '.nextCursor // empty' <<<"$PAGE")
  [ -z "$CURSOR" ] && break
done
```

```text
2026-11-16T09:00:00.000Z  evt_0100_created        article.created      success
2026-11-17T10:15:00.000Z  evt_0200_retitled       article.updated      success
2026-11-18T14:00:00.000Z  evt_0300_job_failed     job.failed           failure
2026-11-18T14:00:00.000Z  evt_0300_schedule       article.scheduled    success
2026-11-19T08:00:05.000Z  evt_0400_published      article.published    success
2026-11-19T08:00:05.120Z  evt_0410_job_completed  job.completed        success
2026-11-20T11:30:00.000Z  evt_0500_denied         article.updated      denied
2026-11-21T16:45:00.000Z  evt_0600_values         article.updated      success
2026-11-23T12:00:00.000Z  evt_0800_bulk           article.bulk_tagged  success
```

A failed page (a 429 rate limit, a 503 during maintenance) ends the loop with an incomplete history and a message:
retry that page with the same cursor and window, never skip it.

**TypeScript.** `readHistoryHorizon` gives the horizon and `iterateAuditTrail` reads every page. The iterator sends the
first page's window with every later page, checks that each page reports it and that every event lies in it, and fails
the pass (`read_window_unverified` or `read_invalid_response`) rather than return a short or repeated history.

```ts
import { type AuditEvent, iterateAuditTrail, readAuditEvent, readHistoryHorizon } from '@logbird/sdk/read';

const reader = { endpoint: process.env.LOGBIRD_URL ?? '', readKey: process.env.LOGBIRD_READ_KEY ?? '' };

// A value as its kind says: absent, null, quoted text, or the number, boolean or JSON as written.
type Change = AuditEvent['changes'][number];
const show = (text: string, kind: Change['beforeKind']) =>
  kind === 'absent' ? '(not set)' : kind === 'string' ? JSON.stringify(text) : kind === undefined ? `${text} (kind unknown)` : text;

const horizon = await readHistoryHorizon(reader);
if (horizon.oldestEventAt) {
  const trail = {
    target: { type: 'article', id: 'art_100' },
    tenant: 'biz_atlas',
    range: { from: horizon.oldestEventAt, to: new Date(Date.now() + 2 * 86_400_000) },
    order: 'asc' as const,
  };
  for await (const event of iterateAuditTrail(reader, trail)) {
    const who = event.impersonator ? `${event.impersonator.name} as ${event.actor?.name}` : event.actor?.name;
    const what = event.changes.map((c) => `${c.field}: ${show(c.before, c.beforeKind)} → ${show(c.after, c.afterKind)}`);
    console.log(event.timestamp, event.action, event.outcome, who, what.join('; '));
  }
}

const detail = await readAuditEvent(reader, 'evt_0400_published'); // null for an unknown or out-of-scope id
console.log(detail?.parents.map((parent) => parent.id), detail?.childCount, detail?.operationSize);
```

```text
2026-11-16T09:00:00.000Z article.created success Sami Writer title: (not set) → "Spring guide"; status: (not set) → "DRAFT"; wordCount: (not set) → 1200
2026-11-17T10:15:00.000Z article.updated success Noor Editor title: "Spring guide" → "Spring guide 2027"; wordCount: 1200 → 1350
2026-11-18T14:00:00.000Z job.failed failure Rita Support as Sami Writer
2026-11-18T14:00:00.000Z article.scheduled success Rita Support as Sami Writer status: "DRAFT" → "SCHEDULED"; scheduledAt: null → "2026-11-19T08:00:00.000Z"
2026-11-19T08:00:05.000Z article.published success Rita Support as Sami Writer status: "SCHEDULED" → "PUBLISHED"; publishedAt: (not set) → "2026-11-19T08:00:05.000Z"
…
[ 'evt_0300_schedule' ] 1 4
```

**.NET.**

```csharp
using System.Globalization;
using Logbird;

using var reader = new LogbirdReadClient(new LogbirdReadOptions
{
    Endpoint = new Uri(Environment.GetEnvironmentVariable("LOGBIRD_URL")!),
    ReadKey = Environment.GetEnvironmentVariable("LOGBIRD_READ_KEY"),
});

HistoryHorizon horizon = await reader.GetHistoryHorizonAsync();
if (horizon.OldestEventAt is { } oldest)
{
    var trail = EventSearch.ForTrail(
        targetType: "article",
        targetId: "art_100",
        tenantId: "biz_atlas",
        from: DateTimeOffset.Parse(oldest, CultureInfo.InvariantCulture),
        to: DateTimeOffset.UtcNow.AddDays(2)) with { Order = SortOrder.Ascending };
    await foreach (var e in reader.SearchAllAsync(trail))
    {
        var who = e.Impersonator is { } support ? $"{support.Name} as {e.Actor?.Name}" : e.Actor?.Name;
        var what = string.Join("; ", e.Changes.Select(c => $"{c.Field}: {(c.BeforeKind == "absent" ? "(not set)" : c.Before)} -> {(c.AfterKind == "absent" ? "(not set)" : c.After)}"));
        Console.WriteLine($"{e.Timestamp:O} {e.Action} {e.Outcome} {who} {what}");
    }
}

EventDetail? detail = await reader.GetEventAsync("evt_0400_published"); // null when it does not exist
Console.WriteLine($"parents {string.Join(",", detail!.Parents.Select(p => p.Id))}, children {detail.ChildCount}, operation {detail.OperationSize}");
```

```text
2026-11-16T09:00:00.0000000+00:00 article.created success Sami Writer title: (not set) -> Spring guide; status: (not set) -> DRAFT; wordCount: (not set) -> 1200
2026-11-17T10:15:00.0000000+00:00 article.updated success Noor Editor title: Spring guide -> Spring guide 2027; wordCount: 1200 -> 1350
…
parents evt_0300_schedule, children 1, operation 4
```

Give `SearchAllAsync` both `From` and `To`: it sends the search you pass on every page, so a missing bound would be
resolved again for each page.

## 2. The window

**Rule.** Without `from`, a search, facet or export reads only the 24 hours before `to` (and without `to`, up to the
server clock). The `range` in the answer is the window that was read. A history is complete only for that window.

The fixture's last edit was two days before this run, so a search without bounds finds nothing, and says why:

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100' | jq -c '{events: (.data | length), total, totalExact, range}'
```

```json
{"events":0,"total":0,"totalExact":true,"range":{"from":"2026-11-25T00:52:27.729Z","to":"2026-11-26T00:52:27.729Z"}}
```

`totalExact: true` here means "exactly 0 in that day", not "this record has no history". Compare `range` with the
window you meant before you treat an answer as complete. The window is half-open (`from` inclusive, `to` exclusive)
and applies to `timestamp`: the event's `occurredAt`, or the time Logbird received it when `occurredAt` was absent or
unusable (then `attributes["logbird.occurredAt.rejected"]` holds the value that was sent). An export states the same
window in the `X-Logbird-Range-From` and `X-Logbird-Range-To` headers (section 10). Event detail by id has no window.

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

The order is stable: paging never repeats or skips an event, in either direction. To show cause before effect, reorder
events that share a timestamp by their `parentEventId` (the console does this within each page, section 13).

## 4. Who did it

**Rule.** Every event can name four parties. Keep them apart when you show a history.

| Field | Meaning |
| --- | --- |
| `actor` (`type`, `id`, `name`, `email`) | Whose account or authority the action used: who is responsible. |
| `impersonator` (`id`, `name`) | The person at the keyboard during a support session, acting as the actor. Null otherwise. |
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
attempt". An impersonator's email is not a field: ingest keeps it as the attribute `impersonator.email`. An executor
that is not a job has an empty `jobId` and `attempt` 0.

Under the `actor_email` mask (section 12), the actor's email and the impersonator's email read as stable pseudonyms,
and `context.ip` and `context.userAgent` read as empty under the `ip` and `user_agent` masks. Here
`$LOGBIRD_MASKED_KEY` is a key scoped to `biz_atlas` with all three masks:

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0400_published" -H "Authorization: Bearer $LOGBIRD_MASKED_KEY" \
  | jq -c '.event | {actor, impersonator, email: .attributes["impersonator.email"], ip: .context.ip, userAgent: .context.userAgent}'
```

```json
{"actor":{"type":"user","id":"usr_writer","name":"Sami Writer","email":"masked:e4c0a34a97711837a5e7f9bc"},
 "impersonator":{"id":"usr_support","name":"Rita Support"},
 "email":"masked:9f251f9488ecc440aad80555","ip":"","userAgent":""}
```

An actor or impersonator name that carries an address (contains `@`, equals the email, or is very long) also reads
as a pseudonym under that mask. Ids and other names stay readable, so a masked reader can still tell who did what.

## 5. What changed

**Rule.** `changes` lists each changed field with `before` and `after` as text. `beforeKind` and `afterKind` say what
the text was: `absent` (that side was not sent), `null`, `string`, `number`, `boolean` or `json` (an object or array).
Read the kind before you read the text.

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
- `subtitle` went from an empty string to the text "null"; `note` from `null` to not set (the field was removed).
- `beforeKind: "absent"` means the value was created (`title` in `article.created`). `afterKind: "absent"` means it
  was removed (`title` in `article.deleted`). An absent side reads as empty text, like an empty string.
- A redacted value is the text `[redacted]` with kind `string`: the field changed, and the producer hid the value. The
  SDKs write this marker by default when they redact. Logbird stores it as sent and cannot tell it from someone who
  typed `[redacted]`.
- Events stored before Logbird recorded kinds have no `beforeKind` or `afterKind`. Their text cannot tell absent from
  an empty string, or `null` from the text "null". For those, read the original document.

**The original document.** With an unmasked key, the detail route returns `payload`, the event exactly as Logbird
received it, with every value in its JSON type:

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0600_values" -H "Authorization: Bearer $LOGBIRD_READ_KEY" | jq -c '.payload.changes[0:4]'
```

```json
[{"field":"price","before":10,"after":12},{"field":"priceLabel","before":"10","after":"12"},{"field":"subtitle","before":"","after":"null"},{"field":"note","before":null}]
```

Under any mask, `payload` is null.

**Continuity.** For one field of one record, each event's `before` should equal the previous event's `after` (same text
and kind). Where it does not, an event is outside your window or scope, was cut (section 9), or the producer did not
send that change. Logbird does not check this for you.

## 6. Cause and effect

**Rule.** The detail route (`GET /v1/events/{id}`) gives an event's ancestors, its number of children and the size of
its operation. Search lists the children (`parent:`), the whole operation (`operation:`), and a job and its retries
(`job:` and `attempt:`).

```sh
curl -s "$LOGBIRD_URL/v1/events/evt_0400_published" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  | jq -c '{parentEventId: .event.context.parentEventId, parents: [.parents[].id], childCount, operationSize}'
```

```json
{"parentEventId":"evt_0300_schedule","parents":["evt_0300_schedule"],"childCount":1,"operationSize":4}
```

- `parents` are the nearest ancestors through `context.parentEventId`, furthest first, at most 100. The walk also stops
  at a parent that is not stored or is outside your scope, so the first entry is not always the root.
- `childCount` and `operationSize` count across all stored history in your scope, whatever window you search.

List the children with `parent:`, over a window that covers them (a child can be dated up to a day after now):

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=parent:evt_0300_schedule' --data-urlencode 'order=asc' \
  --data-urlencode 'from=2026-11-16T00:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' \
  | jq -r '.data[] | [.timestamp, .id, .action, .outcome, .executor.attempt] | @tsv'
```

```text
2026-11-18T14:00:00.000Z  evt_0300_job_failed  job.failed         failure  1
2026-11-19T08:00:05.000Z  evt_0400_published   article.published  success  2
```

With the same call, `q=operation:op_publish_100` returns the whole operation (the scheduling, the failed attempt, the
publication and the job's completion, 4 events), `q=job:job_41` the job's three events, and
`q=job:job_41 attempt:>1` only its retries (2 events). Quote an id that contains a space or query punctuation
(`parent:"evt 1"`), as the [query language](query-language.md) describes.

## 7. Refused and failed attempts

**Rule.** `outcome` is `success`, `failure` (tried and failed) or `denied` (refused before trying). A failed or refused
attempt is part of the history, but it is not a change.

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

Logbird stores what the producer sent and does not check `changes` against `outcome`. Here neither event carries
`changes`. If a failed or denied event does carry some, read them as what was attempted, not what was applied. To
build the record's state from its changes, use only `outcome:success` events.

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
events where some change started from `DRAFT`. Values match their stored text exactly (a number as its shortest
spelling, `true`, `null`, JSON text for objects and arrays); see the
[query language](query-language.md#change-values-and-the-impersonator-name) for each kind.

**Field and value are matched independently.** `changes.field:status changes.after:PUBLISHED` means "some change is to
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

**Unknown keys are refused, not empty.** A misspelled or invented `changes` key answers 422 instead of a silent 0:

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

**Rule.** One event indexes at most 64 targets and 256 changes, and a change field name of at most 256 characters.
Past these, the event is still stored whole, but search sees only the indexed part, and the event says so. Every limit
is listed, with what happens past it, in [Limits](limits.md).

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

- Find cut events with `attr.logbird.truncated.targets:*`, `attr.logbird.truncated.changes:*` or
  `attr.logbird.truncated.changeFields:*`.
- The rest is in the original document: `payload` in the event detail, or the `jsonl-evidence` export. A masked reader
  sees the counts but has no payload, so it cannot read the rest.
- A record's history can therefore miss events that named it past the 64th target. Producers avoid this by splitting a
  bulk operation into several events with one `context.operationId`.

## 10. Completeness over time

**Rule.** A paging pass is not a snapshot. An event stored during the pass, dated behind your position, is not on the
later pages. Catch late arrivals with `receivedAt`, or use an export for a one-shot reconstruction.

In the fixture, a pass read the first 7 events (up to 2026-11-20T11:30). Then an event dated 2026-11-20T09:00 arrived.
The rest of the pass returned only the two events after its position:

```json
{"page2":["evt_0600_values","evt_0800_bulk"],"nextCursor":null}
```

**Incremental reads.** Keep the latest `receivedAt` you have seen. Later, search the same record and window with
`receivedAt:>=` a time well before it, and drop the ids you already have. Receipt times are not a strict sequence
(events share a millisecond, and an event recovered after a storage failure keeps its original receipt time), so an
overlap narrows the gap but cannot prove it closed. Keep `from` early enough to cover when a late event can have
occurred: the window still filters on `timestamp`.

```sh
curl -s -G "$LOGBIRD_URL/v1/events" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'q=record:article:art_100 tenant:biz_atlas receivedAt:>=2026-11-26T00:42:04.128Z' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' --data-urlencode 'order=asc' \
  | jq -c '{total, late: [.data[] | select(.receivedAt > "2026-11-26T00:52:04.128Z") | {id, timestamp, receivedAt}]}'
```

```json
{"total":10,"late":[{"id":"evt_1000_late_slug","timestamp":"2026-11-20T09:00:00.000Z","receivedAt":"2026-11-26T00:54:22.444Z"}]}
```

Here the ten-minute overlap re-read the nine events already seen (they had arrived together), plus the late one. Use
absolute times in `q`: a relative time (`receivedAt:>now-1h`) is read against each request's clock.

**One-shot reconstructions.** An export reads with one fixed clock: it holds every matching event Logbird received
before the export started, in `timestamp`, then `id` order, and none received after.

```sh
curl -s -D headers.txt -G "$LOGBIRD_URL/v1/export" -H "Authorization: Bearer $LOGBIRD_READ_KEY" \
  --data-urlencode 'format=jsonl' --data-urlencode 'q=record:article:art_100 tenant:biz_atlas' \
  --data-urlencode 'from=2026-11-16T09:00:00.000Z' --data-urlencode 'to=2026-11-28T00:00:00.000Z' -o history.jsonl
grep -i '^x-logbird-range' headers.txt; wc -l < history.jsonl
```

```text
x-logbird-range-from: 2026-11-16T09:00:00.000Z
x-logbird-range-to: 2026-11-28T00:00:00.000Z
10
```

A complete download ends normally. A transport error means the file is incomplete: discard it and export again. See
[event exports](exports.md) for the formats (`csv`, `jsonl`, and `jsonl-evidence` with the original documents).

**Retries never appear twice.** An exact retry of an event (same id, same content) is accepted without storing it
again. The fixture's creation event was sent twice, and the history above holds it once.

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
  | jq -c '.range, (.values[] | {label, count, actions: [.groups[] | "\(.value) \(.count)"]})'
```

```json
{"from":"2026-11-16T09:00:00.000Z","to":"2026-11-28T00:00:00.000Z"}
{"label":"Sami Writer","count":5,"actions":["article.created 1","article.published 1","article.scheduled 1","job.completed 1","job.failed 1"]}
{"label":"Noor Editor","count":4,"actions":["article.updated 3","article.bulk_tagged 1"]}
{"label":"Lee Viewer","count":1,"actions":["article.updated 1"]}
```

`field=changes.field` counts how often each field changed. Facets show the top values only (`limit`, default 10, at
most 100), and `otherCount` counts the rest: use search for a complete list.

## 12. Scoped and masked access

A **tenant-scoped key** (or a viewer token minted for a tenant) reads only that tenant, and nothing in `q` can widen
it. Everything above still applies, with these differences:

- `record:article:art_100` alone returns only the scope's events: with a key scoped to `biz_atlas`, 10 events, none
  from `biz_cedar`.
- `GET /v1/project` gives the oldest event in the scope, not in the project.
- An event outside the scope answers 404 in detail, exactly like an id that was never stored. The parent walk stops at
  the first parent outside the scope, and `childCount` and `operationSize` count in-scope events only.
- Facets, exports and totals count in-scope events only.
- A scope can also be narrowed to one record (`target`) or to action prefixes.

A **masked scope** (`ip`, `user_agent`, `actor_email`) changes what each event shows, not which events it sees:

- `ip` and `user_agent` empty `context.ip` and `context.userAgent`.
- `actor_email` shows the actor's email, the impersonator's email and any address-carrying actor or impersonator name
  as `masked:<24 hex>` pseudonyms, stable within the project.
- Any mask sets the detail's `payload` to null and refuses the `jsonl-evidence` export (422 `masked_export`). A masked
  reader therefore relies on `beforeKind` and `afterKind` for value types (section 5), and cannot read the parts of a
  cut event that were not indexed (section 9).
- Filters and facets on a masked field are refused (422 `invalid_query`, reason `not_allowed`), for example
  `actor.email:sami.writer@example.invalid`.

See [scoped read access](scoped-read-access.md) for the full rules.

## 13. The same thing in the console

- **Record page** (Records, then the record): **History** lists every event for this record, newest first. When the
  record id appears in more than one tenant, it says so and offers a tenant choice. Each row shows its changes, with
  "set to" for a created value, "removed (was …)" for a removed one, and **+N more** when there are more.
- **Field history:** click a field name in a row to keep only the events that changed that field (a `changes.field:`
  filter, shown under **Field history**). Remove it with its ×.
- **Who did it:** the switch above the history shows everything, only what was not done by support, or only what
  support did.
- **Ties:** within each loaded page, the console lists a same-millisecond child before its parent in the newest-first
  list.
- **Event drawer** (click a row): **Who** names the actor (marked "whose account" when support acted), the executor
  and the support person ("at the keyboard"); **Targets** and **Changes** say "64 of 70" when the event was cut; the **Changes** table shows each
  before and after with its kind ("not set", `null`, quoted text, "value redacted"); **Causation** shows the parent
  chain and "This event caused N events"; **Context** shows the operation, parent, request and when it was received;
  **Raw payload** shows the original document. **Copy as curl** copies the read-key call for this event's detail.
- **Operation page** (from an event's operation): every event of the operation as a causation tree with attempt
  numbers.
- The actor and tenant pages show the same history for a person or a customer.

## Before you call a history complete

- [ ] The selector is `record:<type>:<id>`, with `tenant:<id>` if ids can repeat across tenants (or a tenant-scoped key).
- [ ] `from` is at or before `oldestEventAt` from `GET /v1/project`, and `to` is at least a day after now.
- [ ] Every page's `range` equals the window you meant, and every later page was sent with the first page's `range`.
- [ ] You followed `nextCursor` until it was null, and every page answered 200.
- [ ] You did not read `total` or `totalExact` as "the whole history": they cover the window only.
- [ ] Same-millisecond events are ordered by `parentEventId`, not by their position.
- [ ] Actor, impersonator, executor (with `jobId` and `attempt`) and tenant are shown apart.
- [ ] Values are read with `beforeKind` and `afterKind`; events without kinds are checked against `payload`.
- [ ] `[redacted]` is shown as "changed, value hidden", not as a value.
- [ ] Failed and denied events are kept in the history but not applied as changes.
- [ ] Searches by value were confirmed by reading each match's `changes` (field and value match independently).
- [ ] Events with `logbird.truncated.*` attributes were read from their `payload` (or the evidence export).
- [ ] Late arrivals were picked up with `receivedAt:>=` and an overlap, or the history comes from one export.
- [ ] For each field, every `before` equals the previous `after`, or the gap is explained.
- [ ] An empty stretch before `oldestEventAt` is reported as "not stored", not as "nothing happened".
