/** Convert the real Playwright recording; ffmpeg must be on PATH (or set FFMPEG). */
import { execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';

const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
await mkdir('docs/media', { recursive: true });
// Skip browser startup, then play the complete journey at 1.2x (about 12 seconds).
run([
  '-ss',
  process.env.VIDEO_START ?? '5.8',
  '-i',
  '.tmp/media-video/walkthrough.webm',
  '-vf',
  'setpts=PTS/1.2,scale=1200:-2',
  '-an',
  '-c:v',
  'libvpx-vp9',
  '-crf',
  '34',
  '-b:v',
  '0',
  '-map_metadata',
  '-1',
  'docs/media/walkthrough.webm',
]);
run([
  '-i',
  'docs/media/walkthrough.webm',
  '-vf',
  'fps=12,palettegen=max_colors=128:stats_mode=diff',
  '-frames:v',
  '1',
  '.tmp/media-video/palette.png',
]);
run([
  '-i',
  'docs/media/walkthrough.webm',
  '-i',
  '.tmp/media-video/palette.png',
  '-lavfi',
  'fps=12[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-loop',
  '0',
  'docs/media/walkthrough.gif',
]);
if ((await stat('docs/media/walkthrough.gif')).size > 6_000_000)
  throw new Error('README GIF exceeds the 6 MB budget; tune encoding before publication.');
