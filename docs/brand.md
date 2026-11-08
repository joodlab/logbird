# Logbird brand

Status: **decided.** On 2026-11-06 the owner chose **Logbird** for the product, the brand and the trademark filings.

The code rename ships as a re-runnable codemod in its own PR, and that PR merges last. Domains and handles still need to be bought or claimed by the owner (section 8).

## 1. The name

**Logbird · لوغبيرد**: the bird that carries every event home.

It was chosen because it passes the test that killed every earlier candidate: **a person who hears it once can spell it,
whether they speak Arabic or English.**

- It is made of two words both groups already know.
- It has no letters that trip up either language: no p/v, no q/kh, no ch/th/ph, no silent letters.
- It says what the product is (log) and gives it a friendly character (bird), in the spirit of Posthog and Supabase.

### Arabic spelling

Use **لوغبيرد** everywhere. It follows the standard Arabic rendering of "g" as غ. Some Egyptian and Saudi readers write
"g" as ج (لوجبيرد); treat that as a misspelling to redirect, not as a second official spelling.

### Availability

Checked live on 2026-11-06.

| Asset | Status | Price (Porkbun, first year / renewal) |
| --- | --- | --- |
| logbird.dev | **free** | $8.75 / $12.87 |
| logbird.io | **free** | $28.12 / $51.80 |
| logbird.sh | free | $31.20 / $46.65 |
| logbird.so | free | about $57.50 at Dynadot |
| logbird.app | taken | — |
| logbird.com | taken since 2004 (Network Solutions), no site; approach the holder later | — |
| npm scope `@logbird` | **claimed 2026-11-06** (org `logbird`, plus company org `joodlab`) | — |
| npm package `logbird` | **free** | — |
| GitHub org `logbird` | taken by a personal account | — |
| GitHub | repo stays under the joodlab org: `joodlab/logbird` (renamed 2026-11-06) | — |
| Bluesky / YouTube `logbird` | taken | — |
| Bluesky / YouTube `logbirdhq` | free | — |

### Known namesakes, for counsel

- **Logbird**: an iOS personal aviation logbook app for pilots (App Store). It's a different market, but it is Class 9
  software.
- **LogBird**: an open-source Swift console-logging library (`javiermanzo/LogBird`, first release December 2024). It's
  small, but it is a developer logging tool.
- **"Retraced"** (`retracedhq/retraced`) is a direct competitor. That is why "Retrase" was rejected; the idea lives on
  in the tagline instead.

## 2. Positioning and voice

> **Retrace every step.** · **تتبّع كل خطوة.**
>
> Logbird is the open-source audit log for your product. Send who-did-what events over HTTP or the SDK, search them in
> seconds, and run it on your own servers or ours.

- **For:** product engineers who owe their customers an audit trail, and the operators who must keep it.
- **Instead of:** building one on Postgres, or renting a closed one (WorkOS Audit Logs, Pangea) where the data never
  leaves the vendor.
- **Because:** it is MIT-licensed, self-hosts with `docker compose up`, stores events in ClickHouse, and says plainly
  what it guarantees: at-least-once delivery, and retention deletes are permanent.

### Voice

Write like an operator talking to a colleague on call, in English and in Arabic.

- **Plain and precise.** "Retention permanently deletes expired events," not "smart data lifecycle".
- **Give the guarantee and the limit together.** "Delivery is at least once; counts may include duplicates."
- **Use short sentences and real verbs.** Avoid "seamless", "blazing", "AI-powered" and exclamation marks.
- **Show the command.** A curl line beats a paragraph.
- **Casing:** `logbird` in lower case in code, the CLI and the wordmark; "Logbird" in prose; لوغبيرد in Arabic.

## 3. Logo

**The mark** is a small bird perched on a log line. The line is drawn as two entries, and the newest one is indigo: the
event the bird just brought in.

- It is drawn on the 32 px grid, reads from 16 px, and follows light and dark themes.
- Unlike the Twitter/X bird, it is perched, not flying, and it sits on a line.

**The wordmarks:**

- Latin: Geist SemiBold, tracking −2.5 %.
- Arabic: IBM Plex Sans Arabic SemiBold.
- Both are outlined to paths, so they render the same everywhere. Both fonts are SIL OFL, which allows logos built from
  their outlines.

The files are in `apps/app/public/brand/`:

| File | Use |
| --- | --- |
| `logbird-mark.svg` / `logbird-mark-dark.svg` | Dark tile for light backgrounds / light tile for dark backgrounds |
| `logbird-favicon.svg` | Follows `prefers-color-scheme` |
| `logbird-apple-touch-icon.png` | 180 px home-screen icon |
| `logbird-wordmark-light.svg` / `-dark.svg` | Mark and "logbird" |
| `logbird-wordmark-bilingual-light.svg` / `-dark.svg` | Mark, "logbird" and لوغبيرد |
| `logbird-wordmark-text.svg` | "logbird" in `currentColor` |
| `logbird-wordmark-arabic-text.svg` | لوغبيرد in `currentColor` |
| `logbird-og.png` | 1200×630 social card |

![Wordmarks](../marketing/captures/2026-11-06-logbird/wordmarks.png)

**Rules:**

- Keep clear space of half the mark's height on every side.
- The minimum size is 16 px for the mark and 80 px wide for the Latin lockup.
- Don't recolour the newest-entry segment anything but brand indigo.
- Don't add gradients or shadows, flip the bird, or set the wordmark in another font.
- In Arabic-first layouts, put لوغبيرد first, then the separator, then "logbird", with the mark on the right.

## 4. Colour tokens

The brand reuses the console theme in `packages/ui/src/styles/globals.css`, so the product and the brand never drift
apart.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--brand` | `#4f46e5` | `#818cf8` | Indigo: the newest entry. Accents, links, focus ring, chart-1. |
| `--foreground` | `#171717` | `#ededed` | Ink: mark tile, wordmark, primary buttons |
| `--background` | `#fafafa` | `#0b0b0c` | Paper and night |
| `--muted-foreground` | `#6b6b6b` | `#a0a0a0` | Secondary copy |
| `--border` | `#e6e6e6` | `#242426` | Hairlines |
| `--chart-2` | `#0891b2` | `#22d3ee` | Secondary accent (sparingly) |

## 5. Typography

- **Latin:** Geist for the UI and headings; Geist Mono for code, event names and log rows. Both ship in the console.
- **Arabic:** IBM Plex Sans Arabic, at weights 500 and 600.

## 6. Social card, favicon and app icon

The social card shows the bilingual lockup, the line "Retrace every step." with تتبّع كل خطوة., the descriptor, a stack
of log rows with the newest one highlighted, and the domain.

![Logbird social card](../apps/app/public/brand/logbird-og.png)

## 7. README hero

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/app/public/brand/logbird-wordmark-bilingual-dark.svg">
    <img alt="Logbird · لوغبيرد" src="apps/app/public/brand/logbird-wordmark-bilingual-light.svg" height="56">
  </picture>
</p>
<p align="center"><b>Retrace every step.</b> · <b dir="rtl">تتبّع كل خطوة.</b><br>Open-source audit logs you can self-host. Send who-did-what events, search them in seconds.</p>
<p align="center"><a href="#quickstart">Quickstart</a> · <a href="docs/self-hosting.md">Self-hosting</a> · <a href="docs/concepts.md">Docs</a></p>
```

## 8. Trademark brief for counsel

**Marks to clear and file:**

1. LOGBIRD as a word mark.
2. لوغبيرد as an Arabic word mark.
3. The bird mark as a figurative mark (`logbird-mark.svg`).

**Goods and services:**

- **Class 9:** downloadable software for recording, storing and searching audit logs and activity records.
- **Class 42:** SaaS and PaaS for audit logging, activity history, and security and compliance record-keeping; hosting
  of such software.

**Jurisdictions:**

- Where we sell and build: Saudi Arabia (SAIP), the UAE and the other GCC states, Egypt, Tunisia.
- Where developers are: the USPTO, EUIPO and UK IPO.
- The WIPO Madrid route for coverage.

**Questions:**

1. Does the iOS aviation logbook app "Logbird" (Class 9) block us, given the different goods?
2. Does the open-source Swift library "LogBird" create common-law rights in developer logging tools?
3. "Log" is descriptive for our goods. Is the compound LOGBIRD distinctive enough as a whole?
4. Is the figurative bird clear of the Twitter/X bird and other bird marks in Classes 9 and 42?

## 9. Launch checklist (owner)

**Buy on the same day:**

- logbird.dev and logbird.io; optionally logbird.sh.
- ~~Claim the npm org `logbird`~~ **Done 2026-11-06:** npm orgs `logbird` (product packages, `@logbird/*`) and
  `joodlab` (company umbrella), both owned by the `lord007tn` account on the free public plan.
- Claim `logbirdhq` on Bluesky, YouTube and X. The X handle is unverified because X can't be checked without signing
  in.
- GitHub stays under the **joodlab** org (owner decision, 2026-11-06); no separate Logbird org. The repo was renamed
  `joodlab/trailmark` → **`joodlab/logbird`** on 2026-11-06. GitHub redirects the old URL.

**Order of changes:**

1. Merge the open PRs first.
2. Re-run the rename codemod on the latest master, then merge the rename PR last. It renames everything, including
   database, queue and key-prefix names.
3. At that same moment, with no dev servers running, run the namespace migration on the shared local services.

**Email:**

- Configure Postmark with a verified sending domain and a sender address for your deployment.
- After logbird.dev is bought and DKIM-verified in Postmark, switch `MAIL_FROM` to an address such as
  `hello@logbird.dev`.

**Filing:** get counsel's clearance (section 8) before filing.

## 10. Kept on purpose

The rename keeps persisted and provisioned identifiers under the old name: database and queue names, the ClickHouse
query user, API key prefixes and cookie names. Existing data, sessions and the shared local services keep working. The
rename PR lists them in the docs.

## Appendix: how we got here (2026-11-05 → 06)

Every round was checked live: registry RDAP and WHOIS, npm, the GitHub API, handles, and web or trademark searches.

| Round | Names | Outcome |
| --- | --- | --- |
| 0 | Trailmark | Conflicts with Trail of Bits' security tool Trailmark. The npm scope, GitHub org, .com and .dev are taken. |
| 1 | Etchlog, Deedmark, Stelelog, Chiselmark, … | The owner wanted a name that works in Arabic and English. |
| 2 | Sijla, Sijillat, Tadween, … | Felt made-up, too literal, wrong sound |
| 3 | Silsila, Rihla, Athar, Daymark, Astrolabe | Not chosen ([board](../marketing/captures/2026-11-06-logbird/round3-board.png)) |
| 4 | Ribat, Henna, Kasbah | Not easy to spell for both groups ([board](../marketing/captures/2026-11-06-logbird/round4-board.png)) |
| 5 | Sandmark, Daymark, Starlog | Not chosen |
| 6 | **Logbird**, Owlbase, Lawha | **Logbird chosen** ([board](../marketing/captures/2026-11-06-logbird/round6-board.png)). OwlTrail, BirdTrail and OwlTrace were compared; Retrase was rejected next to the competitor Retraced. |

Earlier mockups remain in `marketing/captures/2026-11-05-brand-shortlist/`.
