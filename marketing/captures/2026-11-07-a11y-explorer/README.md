# a11y proof — explorer, event sheet, Settings, keys dialog (2026-11-07)

axe-core 4.10.3 injected into Playwright Chromium (tags wcag2a/aa, wcag21a/aa, wcag22aa, best-practice) against the real local
stack (app :4600, server :4601, worker). Explorer, event sheet and overview use the read-only demo workspace; Settings and the keys dialog use a
fictional fixture (`qa-fix-a11y-1@example.test`, workspace "QA Fix a11y", project deleted afterwards). "Before" is origin/master's code
for the same files on the same stack. Event sheet and dialog scans are scoped to the dialog. The `region` best-practice rule
(content outside landmarks: 15 nodes on desktop, the same before and after) is omitted from the table because it is out of scope here.

Before, the keyboard could not reach a row (`tabStopsFromQueryToRow: not reached in 40`), so the "before" sheet was opened with a mouse
click. A clicked row takes focus by itself, which is why `afterSheetEscape` already looks right in that column. The keyboard path
(j + Enter) left focus on BODY in the auditor's run.

Full JSON: `axe-report-before.json`, `axe-report-after.json`. Video narration: `keyboard-video-log.txt`.

This first table is the **round-1** scan. Rounds 3 and 4 changed the explorer (an sr-only `<h1>`) and focus classes, so the
current result per screen is in [Current axe state](#current-axe-state-round-4) below; `page-has-heading-one` is gone there.

| Screen | Before (axe violations, nodes) | After (round 1) |
|---|---|---|
| explorer desktop-light | aria-allowed-role(1), aria-required-children(1), color-contrast(3), page-has-heading-one(1) | aria-allowed-role(1), page-has-heading-one(1) |
| event-sheet desktop-light | color-contrast(1), definition-list(2), target-size(4) | 0 |
| settings-keys desktop-light | color-contrast(5) | 0 |
| create-key-dialog desktop-light | 0 | 0 |
| overview desktop-light | color-contrast(3) | 0 |
| explorer desktop-dark | aria-allowed-role(1), aria-required-children(1), color-contrast(3), page-has-heading-one(1) | aria-allowed-role(1), page-has-heading-one(1) |
| event-sheet desktop-dark | definition-list(2), target-size(4) | 0 |
| settings-keys desktop-dark | color-contrast(3) | 0 |
| create-key-dialog desktop-dark | 0 | 0 |
| overview desktop-dark | color-contrast(3) | 0 |
| explorer phone-light | aria-allowed-role(1), aria-required-children(22), page-has-heading-one(1) | aria-allowed-role(1), page-has-heading-one(1) |
| event-sheet phone-light | color-contrast(1), definition-list(2) | 0 |
| settings-keys phone-light | color-contrast(2) | 0 |
| create-key-dialog phone-light | 0 | 0 |
| overview phone-light | 0 | 0 |
| explorer phone-dark | aria-allowed-role(1), aria-required-children(22), page-has-heading-one(1) | aria-allowed-role(1), page-has-heading-one(1) |
| event-sheet phone-dark | definition-list(2) | 0 |
| settings-keys phone-dark | 0 | 0 |
| create-key-dialog phone-dark | 0 | 0 |
| overview phone-dark | 0 | 0 |


| Check | Before | After |
|---|---|---|
| afterSheetEscape desktop-light | div[role=row][data-index=2] "Nov 4, 22:35 success booking.modified Hourly CRM b" | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hotels's crm:sync:bookings job pro |
| keyDialogInitialFocus desktop-light | input "" | input "" |
| afterKeyDialogEscape desktop-light | BODY | button "Create key" |
| confirmInitialFocus desktop-light | button "Revoke key" | button "Cancel" |
| afterConfirmEscape desktop-light | BODY | button "Revoke" |
| settingsActiveTabVisible desktop-light | fully visible (tab 265–338 in nav 265–1407) | fully visible (tab 752–859 in nav 265–1407) |
| tabStopsFromQueryToRow | not reached in 40 | 9 |
| afterSheetEscape desktop-dark | div[role=row][data-index=2] "Nov 4, 22:35 success booking.modified Hourly CRM b" | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hotels's crm:sync:bookings job pro |
| keyDialogInitialFocus desktop-dark | input "" | input "" |
| afterKeyDialogEscape desktop-dark | BODY | button "Create key" |
| confirmInitialFocus desktop-dark | button "Revoke key" | button "Cancel" |
| afterConfirmEscape desktop-dark | BODY | button "Revoke" |
| settingsActiveTabVisible desktop-dark | fully visible (tab 265–338 in nav 265–1407) | fully visible (tab 752–859 in nav 265–1407) |
| afterSheetEscape phone-light | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hot" | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hotels's crm:sync:bookings job pro |
| keyDialogInitialFocus phone-light | input "" | input "" |
| afterKeyDialogEscape phone-light | BODY | button "Create key" |
| confirmInitialFocus phone-light | button "Revoke key" | button "Cancel" |
| afterConfirmEscape phone-light | BODY | button "Revoke" |
| settingsActiveTabVisible phone-light | fully visible (tab 16–89 in nav 16–374) | fully visible (tab 267–374 in nav 16–374) |
| afterSheetEscape phone-dark | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hot" | div[role=row][data-index=2] "Hourly CRM bookings scheduler - Rimal Crescent Hotels's crm:sync:bookings job pro |
| keyDialogInitialFocus phone-dark | input "" | input "" |
| afterKeyDialogEscape phone-dark | BODY | button "Create key" |
| confirmInitialFocus phone-dark | button "Revoke key" | button "Cancel" |
| afterConfirmEscape phone-dark | BODY | button "Revoke" |
| settingsActiveTabVisible phone-dark | fully visible (tab 16–89 in nav 16–374) | fully visible (tab 267–374 in nav 16–374) |
| queryTab | Tab 1: query="outcome:failure OR " focus=textarea[role=combobox] "Query"<br>Tab 2: query="outcome:failure OR action:" focus=textarea[role=combobox] "Query"<br>Tab 3: query="outcome:failure OR action:guest.updated " focus=textarea[role=combobox] "Query" | Tab 1: query="outcome:failure " focus=button "Clear query"<br>Tab 2: query="outcome:failure " focus=button "Query syntax help"<br>Tab 3: query="outcome:failure " focus=span[role=switch] "" |
| queryArrowRightAccepts | outcome:failure OR action:guest.updated act | outcome:failure action: |
| rangePresetFocusRing | Last hour outline=none box-shadow=none | Last hour outline=none box-shadow=rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0,  |


## Round 2 (review follow-up) — rerunnable proof

`apps/app/scripts/a11y-grid-proof.mjs` (committed this time) drives one Playwright Chromium against the real local stack with a
fictional fixture (`qa-fix-a11y-r2-*@example.test`, workspace "QA Fix a11y r2", project deleted at the end) and axe-core 4.10.3.
Output: `round2-proof.txt` (narration) and `round2-proof.json` (all checks and axe results). All 21 checks passed:

- **Explorer live tail:** keyboard into the grid (10 presses from the query), ↓ ×50 to row 50, then 150 live events arrive in two
  batches. Focus stays on the same event and the same DOM node, which is now index 200 and still the only tab stop. Its row stays at y = 856 on
  screen (scrollTop +5400 px = 150 rows: no jump). ↓ continues from that event (index 201), `k` goes back, and Enter → Escape
  returns focus to it.
- **Workspace Activity:** Tab reaches the grid, then ↓ ×3 moves the roving tab stop to row 3. Shift+Tab out and Tab back return to row 3, and the
  event sheet's Escape returns to row 3. The focused row survives scrolling the list to the bottom.
- **Query bar:** Tab / Shift+Tab out of and back into `outcome:failure OR ` leave the draft unchanged.
- **Settings at 390 px:** General → Danger zone → General keeps the active tab fully visible in LTR and under `dir=rtl`, where
  scrollLeft is −236 and the fade is drawn from the right.
- **axe:** explorer `aria-allowed-role(1)`, `page-has-heading-one(1)` (both pre-existing, see the PR); event sheet, Workspace
  Activity (light and dark), its event sheet, and Settings: 0.

No visuals changed in round 2, so the screenshots and video above still apply. Rounds 3 and 4 below did change visuals (forced
colors and the `CopyValue` ring).

### Code syntax tokens (`--syntax-comment`, `--syntax-punct`)

Measured against every code surface (`muted`, and `muted/40` over card, background and popover):

| Token | Before | After |
|---|---|---|
| comment, light | #8a8a8a — 3.14–3.34:1 | #6b6b6b — 4.85–5.15:1 |
| punct, light | #737373 — 4.31–4.58:1 | #666666 — 5.22–5.55:1 |
| comment, dark | #6b6b6b — 3.19–3.51:1 | #8f8f8f — 5.26–5.79:1 |
| punct, dark | #8a8a8a — 4.93–5.42:1 (already AA) | unchanged |

Recomputed in round 4 (WCAG relative luminance, `muted/40` composited and rounded to 8-bit). The round-2 maxima in this table
were too high; the minima were right and every value passes AA.

Shots (docs page code block, demo workspace, read-only): `before-/after-syntax-comment-code-desktop-{light,dark}.png`. The "before"
renders the old token values in the same running app through an injected style; the computed comment colour was checked in each.

## Rounds 3 and 4 — rerunnable proof

The same script, extended each round. Round 3 (`round3-proof.*`, head `d25291a`, fixture "QA Fix a11y r3") ran 29/29 checks.
Round 4 (`round4-proof.txt` / `round4-proof.json`, fixture `qa-fix-a11y-r4-*@example.test`, workspace "QA Fix a11y r4",
project deleted at the end, no console problems) ran **36/36**: round 3's 29 plus these 7.

- **Forced colors, focus-only outlines.** Tailwind's `outline-hidden` sets `outline: 2px solid transparent` under
  `forced-colors: active`. Round 3 applied it unconditionally, so in High Contrast every row, Settings tab, range preset,
  snippet tab and `CopyValue` was boxed. Round 4 uses `outline-none focus-visible:outline-hidden`, with the inset as
  `focus-visible:forced-colors:-outline-offset-2`. The bare `forced-colors:` form loses to the focus-visible 2px offset on
  specificity. The shadcn sidebar items and chart layers got the same one-class fix.
  - The focused row is `solid 2px` at offset `-2px`, and an unfocused row computes `outline-style: none`.
  - A sweep of every rendered element under forced colors finds **0** outlined elements apart from the focused one, on
    the explorer, the event sheet (its `CopyValue`s) and Settings at 390 px. In Settings, the focused tab is outlined and
    inset.
- **"Filter by…" race.** The filtered response is held back 2 s, so the sheet closes and focus returns to the old row 299
  first. When the results arrive (275 events, neither the old first row nor event 299 among them), focus is on row 0,
  `scrollTop` is 0, no `cursor=` page request is made, row 0 is the only tab stop, and ↓ goes to row 1. A second case
  uses "Filter by operation" from row 199, so the new results still hold the event. Focus stays on that event, now row 0,
  and its row is in view, again with no page request.

### Forced-colors shots

`before-` / `after-forced-colors-row-focus-desktop.png` were retaken in round 4, with the same row focused under
`forcedColors: 'active'`. **After** is the shipped round-4 build: only the focused row is outlined. **Before** is round 2's
shipped state (`328c227`), recreated on the same page. The proof strips the focus-only classes, leaving `outline-none`
(round 2's classes) on the PR's controls. It puts the unconditional `outline-hidden` back on the shadcn sidebar and the
equivalent rule on the chart layers. The focused row then has no visible indicator, and every sidebar item is boxed.
Round 3's shots, which showed every row boxed, are in git history at `d25291a`.

### Current axe state (round 4)

Each row was rescanned in round 4 at head `bcc6ed4` + the chart fix, with axe-core 4.10.3, light and dark, desktop and
390 px. The fixture is a new project rather than the demo workspace, so Overview and Settings → Keys show setup-state
content. Event sheets and dialogs are scoped to the dialog. `region` is omitted, as above.

| Screen | Desktop light | Desktop dark | Phone light | Phone dark |
|---|---|---|---|---|
| explorer | aria-allowed-role(1) | aria-allowed-role(1) | aria-allowed-role(1) | aria-allowed-role(1) |
| event sheet | 0 | 0 | 0 | 0 |
| Workspace Activity | 0 | 0 | — | — |
| Activity event sheet | 0 | — | — | — |
| overview | 0 | 0 | — | — |
| Settings → Keys | 0 | 0 | 0 | — |
| Settings (General) | — | — | 0 | — |

`aria-allowed-role` is the pre-existing `textarea[role=combobox]` in the query bar (see the PR's "Not fixed here"). Not
rescanned since round 1: the create-key dialog (0 / 0 / 0 / 0 then), the revoke confirm, overview at 390 px and Settings → Keys
at 390 px dark. Rounds 2–4 changed only focus classes there.

Round 4 also shortened the query bar's static hint to "Arrows choose a suggestion, Enter or Right arrow inserts it,
Escape closes. Enter runs the query."

## Round 5 — rerunnable proof

Round 5 (`round5-proof.txt` / `round5-proof.json`, fixture `qa-fix-a11y-r5-*@example.test`, workspace "QA Fix a11y r5",
project deleted at the end, no console problems) ran **39/39**: round 4's 36 plus these 3. The 17 axe scans match the
table above row for row. No visuals changed in round 5, so the shots above still apply (the forced-colors pair was not
retaken).

- **"Filter by" a common value (race).** The filter value is the tenant of the newest event (row 0), which half the
  events share. Opened from row 298 under the same 2 s hold, so focus is back on row 298 when the results arrive. The
  old first row is row 0 of the new results too, and event 298 is not on their first page. Before round 5, the table
  read this as "the same list lost rows" and moved to row 99, loading page 2. Now the explorer's `resultKey` changes, and
  focus lands on row 0 (the old first row), `scrollTop` is 0, there is no `cursor=` page request, and row 0 is the only
  tab stop.
- **New query with focus elsewhere, cursor event surviving.** Row 8 of `outcome:failure` is opened and closed. Then the
  query bar is cleared and run. The event is now row 56 of the broader results, but the view stays at the top
  (`scrollTop` 0 → 0), no page request is made, the event is still the only tab stop, and focus stays in the query bar.
  Tabbing back in (via the skip link) lands on that event, scrolled into view.

The happy-dom tests also cover what the browser proof can't easily stage: a key change that keeps the old first row, the
same key with the first row gone (still the same list), focus elsewhere when a new set holds the cursor 280 rows up, and
a capped live tail. Once the tail is capped at 2000, a batch of N also drops its N oldest live rows, so the paged rows
below don't move. The view now anchors on the focused row, or on the top row in view, instead of adding N rows on every
poll.
