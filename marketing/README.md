# Marketing: the Trailmark build log

Every screenshot and video we capture while building Trailmark lives here, so the build can be told later as a devlog
(X, LinkedIn, YouTube Shorts, the website) without re-shooting anything. Same layout as the Hearthroad marketing folder.

**Nothing here is posted by an agent.** The owner publishes. Agents capture media, draft posts, and mark a post as
published in [`calendar.md`](calendar.md) only after the owner says it is live.

## What's where

| Path | What it holds |
|---|---|
| `captures/<yyyy-mm-dd>-<topic>/` | Raw media from a PR or a QA run: PNG stills and webm clips, named by step (`01-overview.png`). Every UI PR adds its own folder; PR bodies embed from here. |
| `devlog/day-NN/` | One post: `post.md` (text, alt text, which stills/clips it uses, links). Reuses media from `captures/` by relative link instead of copying it. |
| [`calendar.md`](calendar.md) | What is drafted, what is posted (with links), what is next. |
| [`tools/`](tools/) | How the media is captured (the recorded walkthrough and capture scripts). |

Media (`png`, `jpg`, `jpeg`, `webp`, `gif`, `mp4`, `webm`) is stored with **Git LFS** (see the root `.gitattributes`).
Run `git lfs install` once after cloning.

## Capture rules

- Capture from the **real app against real services**, never mocks: `OUT_DIR=marketing/captures/<date>-<topic> node apps/app/scripts/walkthrough.mjs`
  (sections: `STEPS=tour,query-bar,onboarding,setup,invite`; `BASE_URL` for another port).
- 1440×900 desktop, plus dark mode and 390 px phone for anything layout-related.
- Never capture secrets: API keys in snippets must belong to throwaway projects that are deleted after the run.
- Name files by step number and what they show; keep a folder small and curated (≤ ~20 stills, short clips).
- Videos are webm (Playwright). Convert to mp4 for socials when posting.

## Devlog format (drafts)

- **Line 1:** `Day N.` + one series line: "Building an open-source audit log for your product, in public."
- **Line 2:** the one change, in a user's words ("You can now search your audit log with SQL — safely.").
- **Then** 2–4 sentences on what the clip shows, a number where possible (events, ms, tests), and the link.
- One idea per image; extra changes go in replies, one still each.
