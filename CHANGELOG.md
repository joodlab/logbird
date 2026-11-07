# Changelog

## Unreleased

- Rename the current product to Logbird; include an explicit namespace migration for existing installations.
- Pin self-host base images by multi-platform digest; document native backup/restore, uninstall and manual release acceptance.
- Fix packaged retention's missing rollup SQL by embedding it at build time. Verify deletes before rebuilding, fail with `LOGBIRD_DELETE_INCOMPLETE` if restored rows remain, and log safe `retention.run_failed` error codes. After upgrading, inspect failed retention receipts and worker logs: the first successful run after a failed receipt rebuilds that project's rollups and can be expensive.

## SDK and Hono 0.2.0 - Unreleased

- Resolve host identity lazily per audit call; isolate resolver failures.
- Audit returns the event id; drain pending resolutions before shutdown/edge flush.
- Add JSON carriers and structural worker jobAudit with causation and attempts.
- Add disabled clients, defaults, fail-closed beforeSend and deep-copy redact.
- No API contract change (SDK-only).

## 0.1.0 - Unreleased

Initial release, seeded from merged PRs #1-20.

- docs: research HyperDX ClickHouse storage and search ([#1](https://github.com/joodlab/logbird/pull/1))
- feat(data): implement ClickHouse data plane, SDK and synthetic seed ([#2](https://github.com/joodlab/logbird/pull/2))
- feat(platform): add auth, management API and retention foundation ([#3](https://github.com/joodlab/logbird/pull/3))
- feat(seed): realistic fictional hospitality and Ledger activity ([#4](https://github.com/joodlab/logbird/pull/4))
- feat(server): complete event APIs, workspace activity and retention ([#5](https://github.com/joodlab/logbird/pull/5))
- feat(ui,app): Logbird console — design system and every SPEC §8 journey ([#6](https://github.com/joodlab/logbird/pull/6))
- fix(backend): close console integration gaps ([#7](https://github.com/joodlab/logbird/pull/7))
- feat(app): real-server-only console, #7 UI wiring, full real-data QA + polish ([#8](https://github.com/joodlab/logbird/pull/8))
- fix: final polish — activity-ordered directories, field:* presence, round chart buckets, names, one time zone, demo:clean ([#9](https://github.com/joodlab/logbird/pull/9))
- fix(ui): long entity names overflow party cards; recorded walkthrough ([#10](https://github.com/joodlab/logbird/pull/10))
- feat(contracts): setup status, query language v2 + SQL mode, suggest, sample data ([#11](https://github.com/joodlab/logbird/pull/11))
- feat(server): implement setup status and sample data ([#12](https://github.com/joodlab/logbird/pull/12))
- feat(openapi): spike Forge and hey-api client generation ([#13](https://github.com/joodlab/logbird/pull/13))
- feat(app): inset dashboard shell + explained directory pages (Workers → Executors) ([#14](https://github.com/joodlab/logbird/pull/14))
- feat(search): add query v2, guarded SQL mode and suggestions ([#15](https://github.com/joodlab/logbird/pull/15))
- feat(app): explorer query bar v2 — Query/SQL modes, highlighting, autocomplete, inline errors ([#16](https://github.com/joodlab/logbird/pull/16))
- fix(clickhouse): point SQL-mode errors at the offending token ([#17](https://github.com/joodlab/logbird/pull/17))
- feat(app): setup checklist, Setup page, resumable onboarding and teammate invitations ([#18](https://github.com/joodlab/logbird/pull/18))
- feat(clickhouse): enforce SQL project isolation with row policies ([#19](https://github.com/joodlab/logbird/pull/19))
- feat(contracts): invite links + setup completedAt ([#20](https://github.com/joodlab/logbird/pull/20))
