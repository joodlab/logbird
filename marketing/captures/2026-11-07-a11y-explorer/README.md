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
