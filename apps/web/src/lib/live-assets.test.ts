import { describe, expect, it } from 'vitest';
import { collectAssetUrls, compareAssets, manifestIconUrls } from './live-assets';

const base = 'https://site.example.test';

describe('live asset check', () => {
  it('collects every asset reference whatever the quoting: img, srcset, poster, icons, cards and JSON-LD', () => {
    const html = `<html><head>
      <link rel="icon" href="/brand/logbird-favicon.svg?v=aaaaaaaaaa"><link rel='manifest' href='/site.webmanifest?v=bbbbbbbbbb'>
      <meta property="og:image" content="https://site.example.test/og/home.png?v=cccccccc">
      <script type="application/ld+json">{"logo":"https://site.example.test/brand/logbird-wordmark-light.svg?v=dddddddddd"}</script>
      </head><body>
      <img src='/media/stale-light-640.webp?v=eeeeeeeeee'>
      <picture><source srcset="/media/a-light-640.avif?v=1111111111 640w, /media/a-light-1024.avif?v=1111111111 1024w"></picture>
      <video src=/media/clip.webm?v=2222222222 poster="/media/clip-poster.webp?v=3333333333&amp;x=1"></video>
      <a href="/product">not an asset</a></body></html>`;
    expect([...collectAssetUrls(html, base)].sort()).toEqual([
      '/brand/logbird-favicon.svg?v=aaaaaaaaaa',
      '/brand/logbird-wordmark-light.svg?v=dddddddddd',
      '/media/a-light-1024.avif?v=1111111111',
      '/media/a-light-640.avif?v=1111111111',
      '/media/clip-poster.webp?v=3333333333&x=1',
      '/media/clip.webm?v=2222222222',
      '/media/stale-light-640.webp?v=eeeeeeeeee',
      '/og/home.png?v=cccccccc',
      '/site.webmanifest?v=bbbbbbbbbb',
    ]);
    expect(manifestIconUrls('{"icons":[{"src":"/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}', base)).toEqual([
      '/brand/logbird-favicon.svg?v=aaaaaaaaaa',
    ]);
  });

  it('fails a stale file (cached bytes differ from uncached) and an unversioned URL, and passes a fresh one', async () => {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      const uncached = url.searchParams.has('cb');
      const body = url.pathname.includes('stale') && !uncached ? 'old bytes' : 'new bytes';
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const problems = await compareAssets(
      ['/media/stale-light-640.webp?v=eeeeeeeeee', '/media/fresh-light-640.webp?v=ffffffffff', '/brand/logo.svg'],
      base,
      fetcher,
    );
    expect(problems.map((problem) => problem.path).sort()).toEqual(['/brand/logo.svg', '/media/stale-light-640.webp?v=eeeeeeeeee']);
    expect(problems.find((problem) => problem.path.includes('stale'))?.problem).toMatch(/^stale: 9 bytes as written vs 9 bytes uncached$/);
  });
});
