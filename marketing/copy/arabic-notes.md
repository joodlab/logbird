---
title: Arabic and bilingual notes
description: Reference Arabic strings for a future localization of the English-only Logbird site.
path: (not a page)
---

# Arabic and bilingual notes

The product and the site are **English-only for now**. No Arabic appears anywhere in the UI, on social cards or in the
README: no bilingual lockup and no Arabic tagline beside the English one. Arabic will ship later as a real localization
with Paraglide JS (inlang) and a language switcher (`docs/brand.md` §8). Keep these notes as the reference until then.

## The fixed strings

| String | Use |
| --- | --- |
| **لوغبيرد** | The name in Arabic. Always this spelling. لوجبيرد is a misspelling to redirect, never a second spelling. |
| **تتبّع كل خطوة.** | The tagline, for "Retrace every step." Keep the shadda on تتبّع and the final full stop. |
| **Logbird · لوغبيرد** | The bilingual name, with a middle dot between the two. |

<!-- source: docs/brand.md §1, §2, §6 -->

## Today

- **Wordmark:** the English lockup (`apps/app/public/brand/logbird-wordmark-light.svg` / `-dark.svg`) everywhere: the
  header, the footer, the About page and the social cards. The bilingual and Arabic wordmark files stay in
  `public/brand/` for later, but nothing renders them.
- **Hero tagline:** "Retrace every step." only.

## How to set it, once Arabic ships

- Wrap Arabic in `lang="ar" dir="rtl"` (for example `<span lang="ar" dir="rtl">تتبّع كل خطوة.</span>`), so screen
  readers and line breaking work.
- Font: IBM Plex Sans Arabic, weight 500 or 600. Latin stays Geist. <!-- source: docs/brand.md §5 -->
- Don't machine-translate other copy. When an Arabic site is planned, write it natively in the same voice: plain,
  precise, short sentences.
- In an Arabic-first layout, لوغبيرد comes first, then the separator, then "logbird", with the mark on the right
  (`docs/brand.md` §3).
