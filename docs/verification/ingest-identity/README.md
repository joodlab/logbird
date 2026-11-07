# Immutable ingest verification, 2026-11-07

## Round 3

Source: `97b03c2dd710f4fa805c525c57fc7b8395e2aa94`. The final follow-up adjusts only
test clocks and evidence. Sol's next review identified a separate read-fence gap;
Round 4 will record its runtime verification separately.

- [Logical shared migration counts](round3-migrations.json) include the actual
  before/immediate-after snapshots, UTC lease correction and final seventh-phase
  coverage. Missing raw tuples went 53 to 0 during 007 and remained 0 to 0 in the
  final coverage pass. Extra orphan namespaces are labelled, not counted as raw
  event rows. Writer errors observed in the recorded query-log window: none.
- [Online proof](round3-online-proof.json) records normal operation, interruption
  after every durable phase, both pre-attach late-writer timings and the real 159 /
  two partial-MV-failure regressions. The coordinator explicitly approved the
  disposable `logbird_qa_062`; it was dropped SYNC and absence was verified.
- The native fault tests ran in that approved database before drop. The committed
  opt-in migration wrapper ports the executed scratch harness and is skipped by
  default; it requires an explicitly pre-created, owned database and does not
  create/drop a database itself.
- Current [reference captures](../../../marketing/captures/2026-11-07-ingest-identity-round3)
  cover desktop and 390px light/dark, with a short video. No browser errors or
  horizontal overflow; bundled Chromium, one isolated context, no personal profile.
  The before captures remain in the dated round-2 set below.
- [Docs cleanup](round3-docs-cleanup.json): the fictional project and workspace
  stream have zero rows in events, event_ids, events_by_minute, entities and
  attribute_keys, and zero receipts; user/org and private queue were removed.
  All browser/app/server processes stopped and both stack/quiet locks released.

Final serial test output and the six-assertion network HTTP/SDK proof are recorded
with the final evidence update, rather than treating earlier test counts as proof
of a later runtime revision. The >=10M / 1M-receipt measurements remain unmeasured,
coordinator-scheduled merge gates; no capacity conclusion follows from these tests.

## Round 2 historical evidence

Runtime source: `eea756ebdb508533f067a27466e830576c82d3e9`. Later follow-ups strengthen the concurrency test, raise only the two mutation-heavy scenario budgets, update the benchmark caller, correct its lock-ownership comment and add this evidence. These changes do not alter the serving implementation.

## Listening HTTP proof

The branch server used real shared Postgres, ClickHouse and Dragonfly services, an isolated fictional project, and a private worker queue prefix. [Recorded assertions](http-proof.json) cover reordered-key exact retries, numeric actor conflicts, healthy siblings committed before a pending 503, recovery when an ambiguous write never arrives with the original receipt timestamp, individual unsafe-id rejection, and the SDK against actual HTTP. All six assertions passed. Afterwards all five ClickHouse tables and the project's Postgres receipts contained zero rows.

## Reference capture

[Capture manifest](../../../marketing/captures/2026-11-07-ingest-identity/capture.json) records eight screenshots: before/after, desktop 1440x900 and phone 390x844, light and dark. The before reference uses the two app source files from `3a1541f`; the files were restored immediately after capture. The after reference uses the runtime source above. One isolated Chromium context recorded [the reference walkthrough](../../../marketing/captures/2026-11-07-ingest-identity/reference.webm). There were no page errors or horizontal overflow. Only fictional fixture data appears. The docs project, workspace and user were deleted; its private retention queue was removed after stopping the worker. Ports 4600/4601 and both stack/quiet slots were released.

| View | Before | After |
| --- | --- | --- |
| Desktop light | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/before-desktop-light.png) | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/after-desktop-light.png) |
| Desktop dark | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/before-desktop-dark.png) | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/after-desktop-dark.png) |
| Phone light | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/before-phone-light.png) | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/after-phone-light.png) |
| Phone dark | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/before-phone-dark.png) | [PNG](../../../marketing/captures/2026-11-07-ingest-identity/after-phone-dark.png) |

## Service and migration safety

The additive migrations were applied after notifying the coordinator. The materialized view preceded the index backfill; its clamped receipt-time TTL matches events. The ClickHouse runner records the full filename. Master still had migrations 001 through 005 at the final fetch, leaving 006 available. Exact rollback is in [the design](../../ingest-identity.md).

[Migration snapshots](migration-counts.json) retain the before/after physical counters with an explicit label; no logical count was captured before migration. The post-migration logical snapshot was 320772 event rows, 320726 distinct `(project_id,event_id)` pairs, 322802 distinct index pairs and zero missing event identities. Extra index namespaces came from old purge code. The reported 1060624 physical active-part rows in the earlier snapshot were not the logical event count. Counts-first orphan cleanup removed 81 absent namespaces and skipped 42 with surviving raw evidence. No customer project was reset or deleted.

## Resource evidence and limits

[Resources](resources.json) reports per-command process-tree RSS, machine memory and disk. The successful docs capture's browser peaked at 1.201 GiB; the stack at 2.302 GiB. The stack guard stopped its whole tree after capture/cleanup when machine free memory crossed the normal 6 GiB floor. Serial test attempts that crossed the special 3 GiB floor are resource aborts, never passing test verdicts. The earlier completed build peaked at 1.396 GiB. The resource records distinguish these runs.

The >=10M history / 1M receipt benchmark is intentionally unmeasured here. Run `scripts/benchmark-ingest-identity.ts` only in the coordinator's scheduled heavy+stack window, passing the approved fictional load project and this PR's final full SHA as EXPECTED_HEAD. It refuses a dirty or different checkout. Review scores and scale measurements remain coordinator merge gates.

Round 3 scope trim: the historical orphan cleanup above was a one-off shared-dev operation. Its CLI has been removed; future orphan cleanup belongs to the coordinator. The benchmark is now separately maintained by PR #79 on master.
