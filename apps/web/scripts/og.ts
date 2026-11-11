import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { createElement as h } from 'react';
import satori from 'satori';
import { siteConfigFrom } from '../src/env';
import { siteMap } from '../src/lib/site-map';
import { loadPublicEnv } from './public-env';

const require = createRequire(import.meta.url);
// The same resolved origin as the bundle and the discovery files (scripts/public-env.ts).
const { SITE_URL } = siteConfigFrom(loadPublicEnv());
console.log(`og: cards for ${new URL(SITE_URL).host}`);
const font = (pkg: string, file: string) => readFile(resolve(dirname(require.resolve(`${pkg}/package.json`)), 'files', file));
const [regular, semibold, mono, logo] = await Promise.all([
  font('@fontsource/geist', 'geist-latin-400-normal.woff'),
  font('@fontsource/geist', 'geist-latin-600-normal.woff'),
  font('@fontsource/geist-mono', 'geist-mono-latin-400-normal.woff'),
  readFile('public/brand/logbird-wordmark-dark.svg'),
]);
await mkdir('public/og', { recursive: true });
const box = (style: Record<string, unknown>, ...children: Parameters<typeof h>[2][]) =>
  h('div', { style: { display: 'flex', ...style } }, ...children);
for (const page of siteMap) {
  const title = page.ogSlug === 'home' ? 'Retrace every step.' : page.title;
  const description = page.ogSlug === 'home' ? 'Open-source audit logs you can self-host.' : page.description;
  const rows = [1, 0.83, 0.67, 0.5, 0.35].map((opacity, index) =>
    box(
      {
        position: 'absolute',
        right: 64,
        top: 178 + index * 58,
        width: 360,
        height: 44,
        borderRadius: 10,
        border: `1px solid ${index === 0 ? '#818cf8' : '#242426'}`,
        background: index === 0 ? 'rgba(129,140,248,0.12)' : '#141416',
        alignItems: 'center',
        padding: '0 16px',
        gap: 14,
        opacity,
      },
      box({ width: 8, height: 8, borderRadius: 4, background: index === 0 ? '#818cf8' : '#a0a0a0' }),
      index === 0
        ? h('span', { style: { fontFamily: 'Geist Mono', fontSize: 20, color: '#ededed' } }, 'booking.cancelled')
        : box(
            { gap: 16, alignItems: 'center' },
            box({ width: 100, height: 6, borderRadius: 3, background: '#5c5c60' }),
            box({ width: 128, height: 6, borderRadius: 3, background: '#343438' }),
          ),
    ),
  );
  const tree = box(
    { width: 1200, height: 630, background: '#0b0b0c', color: '#ededed', fontFamily: 'Geist', position: 'relative', padding: 64 },
    box({ position: 'absolute', left: 20, top: 20, width: 1160, height: 590, border: '1px solid #242426', borderRadius: 24 }),
    h('img', { src: `data:image/svg+xml;base64,${logo.toString('base64')}`, height: 40, style: { position: 'absolute', left: 64, top: 66 } }),
    box(
      { position: 'absolute', left: 64, top: 192, width: 650, flexDirection: 'column' },
      h('div', { style: { fontSize: 64, fontWeight: 600, letterSpacing: '-0.025em', lineHeight: 1.08, lineClamp: 2, overflow: 'hidden' } }, title),
      h('div', { style: { marginTop: 24, fontSize: 28, color: '#a0a0a0', lineHeight: 1.35, lineClamp: 2, overflow: 'hidden' } }, description),
    ),
    ...rows,
    h(
      'span',
      { style: { position: 'absolute', left: 64, bottom: 52, fontFamily: 'Geist Mono', fontSize: 22, color: '#a0a0a0' } },
      new URL(SITE_URL).host,
    ),
    h('span', { style: { position: 'absolute', right: 64, bottom: 52, fontSize: 22, color: '#a0a0a0' } }, 'Retrace every step.'),
  );
  const svg = await satori(tree, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Geist', data: regular, weight: 400 },
      { name: 'Geist', data: semibold, weight: 600 },
      { name: 'Geist Mono', data: mono, weight: 400 },
    ],
  });
  await writeFile(`public/og/${page.ogSlug}.png`, new Resvg(svg).render().asPng());
}
await mkdir('.tmp', { recursive: true });
await copyFile('public/og/home.png', '.tmp/og-home.png');
console.log(`Rendered ${siteMap.length} OG images.`);
