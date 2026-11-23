import { describe, expect, it } from 'vitest';
import { collectAssetUrls, compareAssets, manifestIconUrls } from './live-assets';

const base = 'http://127.0.0.1:4750';
const publicOrigin = 'https://site.example.test';

describe('live asset check', () => {
  it('collects every asset reference whatever the quoting: img, srcset, poster, icons, cards and JSON-LD', () => {
    const html = `<html><head>
      <link rel="icon" href="/brand/logbird-favicon.svg?v=aaaaaaaaaa"><link rel='manifest' href='/site.webmanifest?v=bbbbbbbbbb'>
      <meta property="og:image" content="https://site.example.test/og/home.png?v=cccccccc">
      <script type = 'application/ld+json'>{"publisher":{"logo":"https://site.example.test/brand/logbird-wordmark-light.svg?v=dddddddddd"}}</script>
      </head><body>
      <img src='/media/stale-light-640.webp?v=eeeeeeeeee'>
      <picture><source srcset="/media/a-light-640.avif?v=1111111111 640w, /media/a-light-1024.avif?v=1111111111 1024w"></picture>
      <video src=/media/clip.webm?v=2222222222 poster="/media/clip-poster.webp?v=3333333333&amp;x=1"></video>
      <a href="/product">not an asset</a></body></html>`;
    const { urls, problems } = collectAssetUrls(html, base, publicOrigin);
    expect([...urls].sort()).toEqual([
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
    expect(problems).toEqual([]);
    expect(manifestIconUrls('{"icons":[{"src":"/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}', `${base}/site.webmanifest`, publicOrigin)).toEqual({
      urls: ['/brand/logbird-favicon.svg?v=aaaaaaaaaa'],
      problems: [],
    });
  });

  it('resolves relative references against the page, and reports one that lands outside the asset directories', () => {
    const { urls, problems } = collectAssetUrls('<img src="media/a-light-640.webp?v=1111111111">', `${base}/product/`, publicOrigin);
    expect([...urls]).toEqual([]);
    expect(problems).toEqual([
      {
        path: '/product/media/a-light-640.webp?v=1111111111',
        problem: "resolves outside the site's asset directories (media/a-light-640.webp?v=1111111111)",
      },
    ]);
  });

  it('reports a manifest icon on another host', () => {
    const manifest = '{"icons":[{"src":"https://missing.invalid/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}';
    expect(manifestIconUrls(manifest, `${base}/site.webmanifest`, publicOrigin).problems).toEqual([
      { path: '/brand/logbird-favicon.svg?v=aaaaaaaaaa', problem: "manifest icon on https://missing.invalid, not the site's origin" },
    ]);
  });

  it('reports an asset URL on another host', () => {
    const html = '<meta property="og:image" content="https://elsewhere.example/og/home.png?v=cccccccc">';
    expect(collectAssetUrls(html, base, publicOrigin).problems).toEqual([
      { path: '/og/home.png?v=cccccccc', problem: "on https://elsewhere.example, not the site's origin" },
    ]);
  });

  it('fails a stale file, an unversioned URL and an HTML fallback under an image URL; passes a fresh one', async () => {
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname.includes('fallback') || (url.pathname.includes('half') && url.searchParams.has('cb'))) {
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      }
      const uncached = url.searchParams.has('cb');
      const body = url.pathname.includes('stale') && !uncached ? 'old bytes' : 'new bytes';
      return new Response(body, { headers: { 'content-type': url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/webp' } });
    }) as typeof fetch;
    const problems = await compareAssets(
      [
        '/media/stale-light-640.webp?v=eeeeeeeeee',
        '/media/fresh-light-640.webp?v=ffffffffff',
        '/media/fallback-light-640.webp?v=0000000000',
        '/brand/logo.svg',
        '/media/half-light-640.webp?v=4444444444',
        '/media/capture.wepb?v=5555555555',
      ],
      base,
      fetcher,
    );
    expect(problems.map((problem) => `${problem.path} ${problem.problem}`).sort()).toEqual([
      '/brand/logo.svg unversioned URL to a fixed-name file',
      '/media/capture.wepb?v=5555555555 not a known media, card, brand or manifest file type',
      '/media/fallback-light-640.webp?v=0000000000 served as text/html (as written)',
      '/media/fallback-light-640.webp?v=0000000000 served as text/html (uncached)',
      '/media/half-light-640.webp?v=4444444444 served as text/html (uncached)',
      '/media/half-light-640.webp?v=4444444444 stale: 9 bytes as written vs 15 bytes uncached',
      '/media/stale-light-640.webp?v=eeeeeeeeee stale: 9 bytes as written vs 9 bytes uncached',
    ]);
  });
});
