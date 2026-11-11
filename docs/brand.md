# Logbird brand

Use these name, voice and visual guidelines consistently across Logbird materials.

**Language:** the product (console, docs, emails) and the marketing site are **English-only for now**. Don't show Arabic
next to the English copy, in the UI, on social cards or in the README. The Arabic name, tagline and assets below stay
documented as the reference for a future Arabic localization (see [§8](#8-localization)).

## 1. The name

**Logbird · لوغبيرد**: the bird that carries every event home.

It was chosen because it passes the test that killed every earlier candidate: **a person who hears it once can spell it,
whether they speak Arabic or English.**

- It is made of two words both groups already know.
- It has no letters that trip up either language: no p/v, no q/kh, no ch/th/ph, no silent letters.
- It says what the product is (log) and gives it a friendly character (bird), in the spirit of Posthog and Supabase.

### Arabic spelling

When Arabic ships, use **لوغبيرد** everywhere. It follows the standard Arabic rendering of "g" as غ. Some Egyptian and Saudi readers write
"g" as ج (لوجبيرد); treat that as a misspelling to redirect, not as a second official spelling.

## 2. Positioning and voice

> **Retrace every step.**
>
> Logbird is the open-source audit log for your product. Send who-did-what events over HTTP or the SDK, search them in
> seconds, and run it on your own servers or ours.

- **For:** product engineers who owe their customers an audit trail, and the operators who must keep it.
- **Instead of:** building one on Postgres, or renting a closed one (WorkOS Audit Logs, Pangea) where the data never
  leaves the vendor.
- **Because:** it is MIT-licensed, self-hosts with `docker compose up`, stores events in ClickHouse, and says plainly
  what it guarantees: at-least-once delivery, and retention deletes are permanent.

### Voice

Write like an operator talking to a colleague on call.

- **Plain and precise.** "Retention permanently deletes expired events," not "smart data lifecycle".
- **Give the guarantee and the limit together.** "Delivery is at least once; counts may include duplicates."
- **Use short sentences and real verbs.** Avoid "seamless", "blazing", "AI-powered" and exclamation marks.
- **Show the command.** A curl line beats a paragraph.
- **Casing:** `logbird` in lower case in code, the CLI and the wordmark; "Logbird" in prose; لوغبيرد in Arabic copy, once
  it exists.

## 3. Logo

**The mark** is a small bird perched on a log line. The line is drawn as two entries, and the newest one is indigo: the
event the bird just brought in.

- It is drawn on the 32 px grid, reads from 16 px, and follows light and dark themes.
- Unlike the Twitter/X bird, it is perched, not flying, and it sits on a line.

**The wordmarks:**

- Latin: Geist SemiBold, tracking −2.5 %.
- Arabic (reserved for the localization): IBM Plex Sans Arabic SemiBold.
- Both are outlined to paths, so they render the same everywhere. Both fonts are SIL OFL, which allows logos built from
  their outlines.

The files are in `apps/app/public/brand/`:

| File | Use |
| --- | --- |
| `logbird-mark.svg` / `logbird-mark-dark.svg` | Dark tile for light backgrounds / light tile for dark backgrounds |
| `logbird-favicon.svg` | Follows `prefers-color-scheme` |
| `logbird-apple-touch-icon.png` | 180 px home-screen icon |
| `logbird-wordmark-light.svg` / `-dark.svg` | Mark and "logbird" |
| `logbird-wordmark-bilingual-light.svg` / `-dark.svg` | Mark, "logbird" and لوغبيرد (reserved; not rendered today) |
| `logbird-wordmark-text.svg` | "logbird" in `currentColor` |
| `logbird-wordmark-arabic-text.svg` | لوغبيرد in `currentColor` (reserved; not rendered today) |
| `logbird-og.png` | 1200×630 social card |

![Wordmark](../apps/app/public/brand/logbird-wordmark-light.svg)

**Rules:**

- Keep clear space of half the mark's height on every side.
- The minimum size is 16 px for the mark and 80 px wide for the Latin lockup.
- Don't recolour the newest-entry segment anything but brand indigo.
- Don't add gradients or shadows, flip the bird, or set the wordmark in another font.
- Once Arabic ships, in Arabic-first layouts put لوغبيرد first, then the separator, then "logbird", with the mark on the right.

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
- **Arabic (reserved for the localization):** IBM Plex Sans Arabic, at weights 500 and 600.

## 6. Social card, favicon and app icon

The social card shows the English wordmark, the line "Retrace every step.", the descriptor, a stack of log rows with
the newest one highlighted, and the domain. The marketing site renders its per-page cards with `apps/web/scripts/og.ts`.

![Logbird social card](../apps/app/public/brand/logbird-og.png)

## 7. README hero

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/app/public/brand/logbird-wordmark-dark.svg">
    <img alt="Logbird" src="apps/app/public/brand/logbird-wordmark-light.svg" height="56">
  </picture>
</p>
<p align="center"><b>Retrace every step.</b><br>Open-source audit logs you can self-host. Send who-did-what events, search them in seconds.</p>
<p align="center"><a href="#quickstart">Quickstart</a> · <a href="docs/self-hosting.md">Self-hosting</a> · <a href="docs/concepts.md">Docs</a></p>
```

## 8. Localization

Arabic will come later as a real localization, not as Arabic lines beside the English copy. When it ships, use
Paraglide JS (inlang) for the messages and add a language switcher; the compiled output (`**/src/paraglide`) is already
in `.gitignore`. Until then, the reference copy is:

- Name: **لوغبيرد** (see [§1](#1-the-name)).
- Tagline: **تتبّع كل خطوة.** for "Retrace every step." Keep the shadda on تتبّع and the final full stop.
- Assets: the bilingual and Arabic wordmarks in `apps/app/public/brand/` (see [§3](#3-logo)), and IBM Plex Sans Arabic.
