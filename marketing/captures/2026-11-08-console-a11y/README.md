# Console a11y proof — forced colors (#85) and the phone backlog (#64), 2026-11-08

Produced by `apps/app/scripts/console-a11y-proof.mjs` with Playwright's bundled Chromium (fresh contexts only) against the real
local stack (app :4600, server :4601, worker), one run per mode:

- **before**: `origin/master` (8ba30e0) sources checked out into the same working tree, same stack.
- **after**: branch `fix/console-a11y-phone`.

Fixtures are fictional: a fresh onboarding user per mode (`qa-fix-a11y-phone-<mode>-*@example.test`, workspaces
"QA Fix a11y phone before/after", project "QA Phone App"), and one shell user (`qa-fix-a11y-phone-shell-*@example.test`, workspace
"QA Fix a11y phone", project "QA Phone Shell", 60 fixture events, one pending invitation to `qa-fix-a11y-phone-invitee@example.test`)
created by the before run and reused by the after run, so the crops show the same data. OTP codes came from Mailpit. Every QA project
was deleted at the end (HTTP 204); their API keys, visible in the first-event screenshots, were deleted with them (cascade).
Two later fixtures, both deleted the same way: `qa-fix-a11y-phone-axe-*@example.test` / "QA Fix a11y phone axe" / project
"QA Phone Axe" (the first re-check of Settings → Retention after the `current` label fix, not committed as a log), and
`qa-fix-a11y-phone-review-*@example.test` / "QA Fix a11y phone review" / project "QA Phone Review" (the review follow-up
below). The fixtures' Playwright session files live outside the repo and `.qa-a11y-shell.json` is gitignored.

Results: `before-proof.txt` / `after-proof.txt` (one line per check; `BUG` in the before run documents the defect) and the matching
`.json` (checks, axe violations, crop hashes).

## Videos

| File | What |
|---|---|
| `before-keyboard-phone-390-dark.webm` / `after-keyboard-phone-390-dark.webm` | 390×844, dark, keyboard only: login with a blur error then Enter, onboarding stepper, retention radios, first-event focus, snippet tabs, sidebar sheet + one Escape |
| `before-forced-colors-keyboard-desktop.webm` / `after-forced-colors-keyboard-desktop.webm` | 1440×900, keyboard: Settings → Keys button focus and Create key radios, Members dropdown, Explorer toolbar, Columns menu, event sheet Next/Previous, command palette, switching forced colors on and off |

## Screenshots

| Topic | Files (`before-*` and `after-*`) |
|---|---|
| #85 forced colors, focused Button | `forced-colors-button-focus-{desktop,phone}.png`, `forced-colors-explorer-toolbar-{desktop,phone}.png`, `forced-colors-event-sheet-next-{desktop,phone}.png` |
| #85 forced colors, menus / palette | `forced-colors-settings-menu-{desktop,phone}.png`, `forced-colors-columns-menu-desktop.png`, `forced-colors-palette-{desktop,phone}.png` |
| #85 no change outside forced colors | `crop-*-{desktop,phone}-{light,dark}.png` (Button focus ring, Members menu, Columns menu (desktop only: the phone toolbar has no Columns button), event-sheet Next, palette): 18 crops, the after run compares sha256 with the before crops: 18/18 identical |
| PHONE-07 login | `before-login-stale-error-phone-dark.png` (valid address, stale error, nothing sent); after: first Enter reaches `/login/verify` (video) |
| PHONE-08 radios and tabs | `onboarding-retention-focus-phone-dark.png`, `create-key-dialog-radio-focus-{desktop,phone}-{light,dark}.png`, `settings-retention-focus-{desktop,phone}-{light,dark}.png`, `snippet-tabs-focus-phone-dark.png` |
| PHONE-09 sidebar sheet | `sidebar-sheet-after-tabs-phone-dark.png`, `sidebar-sheet-after-one-escape-phone-dark.png` |
| PHONE-12 stepper | `onboarding-profile-phone-dark.png`, `onboarding-workspace-phone-dark.png` (the aria trees are in the proof logs) |
| PHONE-13 first event | `first-event-phone-dark.png` (focus on the heading, key name wraps) |

The `*-settings-retention-focus-*` shots and `after-proof.json` predate the `current` label fix (it lost `opacity-70`, which failed AA
contrast on master and in the first after run). `after-settings-retention-desktop-{light,dark}.png` come from an uncommitted re-check;
the committed result for that screen is the review follow-up below.

## axe (wcag2a/aa, wcag21a/aa, wcag22aa)

| Screen | Before | After |
|---|---|---|
| first-event phone-dark | scrollable-region-focusable(1) (snippet `pre`) | 0 (the snippet is a focusable tabpanel) |
| create-key dialog desktop light/dark | 0 / 0 | 0 / 0 |
| settings-retention desktop light/dark | color-contrast(1) / color-contrast(1) (`current` label) | 0 / 0 in `after-review-proof.json` (`after-proof.json` still shows the pre-fix color-contrast(1)) |
| members desktop light/dark | color-contrast(1) / 0 | color-contrast(1) / 0 (the same pre-existing `#base-ui-…` node on master; not touched by this PR) |
| explorer desktop light/dark | 0 / 0 | 0 / 0 |
| event-sheet desktop light/dark | 0 / 0 | 0 / 0 |

No new violations.

## Review follow-up (PR #108)

`apps/app/scripts/console-a11y-review-proof.mjs` against the same real stack, after the review fixes (fixture "QA Phone Review",
deleted). Log: `after-review-proof.txt` / `.json`.

- axe Settings → Retention desktop light / dark: **0 / 0** (`after-review-settings-retention-desktop-{light,dark}.png`).
- Stepper aria: `Step 1 of 4: You, completed`, `Step 2 of 4: Workspace, completed`, `Step 3 of 4: Project`, `Step 4 of 4: First event`.
- Key kind radios: `Ingest — Can only send events…`, `Read — Can only search and read events…`.
- Clicking a retention shortcut card sets the value and does not focus the hidden card.
- Forced colors: the focused retention chip radio (now FilterChip's classes) paints `solid 2px`
  (`after-review-forced-colors-retention-chip-desktop.png`).
