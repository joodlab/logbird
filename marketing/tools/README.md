# Capture tools

See [the media guide](../../docs/media/README.md) for isolated StayDesk fixture preparation, real-app screenshots, the Playwright walkthrough and ffmpeg conversion.

- `apps/app/scripts/capture-media.mjs`: the curated desktop / phone screenshot set; run from the repository root.
- `apps/app/scripts/walkthrough.mjs`: the longer QA walkthrough with optional flow sections. Set `OUT_DIR` to an ignored directory for raw evidence. For the concise README recording use `CAPTURE_VIDEO=1 node apps/app/scripts/capture-media.mjs`.
- Other proof scripts write targeted QA evidence. Keep their unreviewed output outside tracked media and stop every source server / worker after use.
