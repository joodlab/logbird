---
title: Arabic and bilingual notes
description: Where the Arabic name and tagline appear on the English-only Logbird site, and how to set them.
path: (not a page)
---

# Arabic and bilingual notes

The site is **English-only for now**. Arabic appears in a few brand moments only; no page is translated.

## The fixed strings

| String | Use |
| --- | --- |
| **لوغبيرد** | The name in Arabic. Always this spelling. لوجبيرد is a misspelling to redirect, never a second spelling. |
| **تتبّع كل خطوة.** | The tagline, next to "Retrace every step." Keep the shadda on تتبّع and the final full stop. |
| **Logbird · لوغبيرد** | The bilingual name, with a middle dot between the two. |

<!-- source: docs/brand.md §1, §2, §6 -->

## Where bilingual is right

- **Wordmark:** the bilingual lockup (`apps/app/public/brand/logbird-wordmark-bilingual-light.svg` / `-dark.svg`) in
  the footer, the About page and the social card. The header uses the Latin wordmark.
- **Hero tagline:** "Retrace every step." as the H1, with تتبّع كل خطوة. as a smaller line beside or below it.
- **Social card:** already bilingual (`apps/app/public/brand/logbird-og.png`).
- **Nowhere else.** Body copy, navigation, buttons, forms and legal pages stay in English until there's a real
  Arabic site.

## How to set it

- Wrap Arabic in `lang="ar" dir="rtl"` (for example `<span lang="ar" dir="rtl">تتبّع كل خطوة.</span>`), so screen
  readers and line breaking work.
- Font: IBM Plex Sans Arabic, weight 500 or 600. Latin stays Geist. <!-- source: docs/brand.md §5 -->
- Don't machine-translate other copy. When an Arabic site is planned, write it natively in the same voice: plain,
  precise, short sentences.
- In an Arabic-first layout, لوغبيرد comes first, then the separator, then "logbird", with the mark on the right
  (`docs/brand.md` §3). It doesn't apply to this English site.
