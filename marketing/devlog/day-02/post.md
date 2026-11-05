# Day 2 (draft) — built 2026-11-05

**Post (X / LinkedIn)**

> Day 2. Building an open-source audit log for your product, in public.
>
> Trailmark now checks your integration for you: send one event and the setup page lights up 1.8 s later, then tells
> you which fields your events are missing and links straight to them.
>
> <link>

**Clip:** [`onboarding.webm`](../../captures/2026-11-05-walkthrough/onboarding.webm) — new account → ingest key →
real `curl` → the event appears live.

**Replies (one still each)**
1. "Search like you already know how: `attempt:>2`, `[a TO b]`, `/regex/`, `field:(a OR b)` — with suggestions as you
   type." — [`qb-03-advanced-query.png`](../../captures/2026-11-05-walkthrough/query-bar/qb-03-advanced-query.png)
2. "Or write a SQL WHERE clause. It's parsed by ClickHouse, checked against an allowlist, and run as a read-only user
   that can only see your project." — [`qb-11-sql-rejected.png`](../../captures/2026-11-05-walkthrough/query-bar/qb-11-sql-rejected.png)
3. "Invite your team; the invite email works even before they have an account." —
   [`41-mailpit-invitation.png`](../../captures/2026-11-05-walkthrough/41-mailpit-invitation.png)
4. "The sidebar tells you how far setup is, and disappears once you're done." —
   [`25-overview-checklist.png`](../../captures/2026-11-05-walkthrough/25-overview-checklist.png)

**Alt text (clip):** A terminal sends one curl request; in the browser, Trailmark's setup page shows "It works — your
first event just arrived" with the event's actor, tenant and record.
