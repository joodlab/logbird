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
    const { urls, problems } = collectAssetUrls(html, base, [base, publicOrigin]);
    // Absolute URLs keep their own origin: the check fetches the card and JSON-LD logo from the public origin.
    expect([...urls].sort()).toEqual([
      `${base}/brand/logbird-favicon.svg?v=aaaaaaaaaa`,
      `${base}/media/a-light-1024.avif?v=1111111111`,
      `${base}/media/a-light-640.avif?v=1111111111`,
      `${base}/media/clip-poster.webp?v=3333333333&x=1`,
      `${base}/media/clip.webm?v=2222222222`,
      `${base}/media/stale-light-640.webp?v=eeeeeeeeee`,
      `${base}/site.webmanifest?v=bbbbbbbbbb`,
      `${publicOrigin}/brand/logbird-wordmark-light.svg?v=dddddddddd`,
      `${publicOrigin}/og/home.png?v=cccccccc`,
    ]);
    expect(problems).toEqual([]);
    expect(
      manifestIconUrls('{"icons":[{"src":"/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}', `${base}/site.webmanifest`, [base, publicOrigin]),
    ).toEqual({
      urls: [`${base}/brand/logbird-favicon.svg?v=aaaaaaaaaa`],
      problems: [],
    });
  });

  it('resolves relative references against the page, and reports one that lands outside the asset directories', () => {
    const { urls, problems } = collectAssetUrls('<img src="media/a-light-640.webp?v=1111111111">', `${base}/product/`, [base, publicOrigin]);
    expect([...urls]).toEqual([]);
    expect(problems).toEqual([
      {
        path: `${base}/product/media/a-light-640.webp?v=1111111111`,
        problem: "resolves outside the site's asset directories (media/a-light-640.webp?v=1111111111)",
      },
    ]);
  });

  it('a page or manifest that redirected to another origin does not widen the allowed origins', () => {
    const redirected = 'http://127.0.0.1:9999/about/';
    expect(collectAssetUrls('<img src="/media/a-light-640.webp?v=1111111111">', redirected, [base, publicOrigin]).problems).toEqual([
      { path: 'http://127.0.0.1:9999/media/a-light-640.webp?v=1111111111', problem: "on http://127.0.0.1:9999, not the site's origin" },
    ]);
    const manifest = '{"icons":[{"src":"/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}';
    expect(manifestIconUrls(manifest, 'http://127.0.0.1:9999/site.webmanifest', [base, publicOrigin]).problems).toEqual([
      {
        path: 'http://127.0.0.1:9999/brand/logbird-favicon.svg?v=aaaaaaaaaa',
        problem: "manifest icon on http://127.0.0.1:9999, not the site's origin",
      },
    ]);
  });

  it('reports a manifest icon on another host, and a manifest that does not parse', () => {
    const manifest = '{"icons":[{"src":"https://missing.invalid/brand/logbird-favicon.svg?v=aaaaaaaaaa"}]}';
    expect(manifestIconUrls(manifest, `${base}/site.webmanifest`, [base, publicOrigin]).problems).toEqual([
      {
        path: 'https://missing.invalid/brand/logbird-favicon.svg?v=aaaaaaaaaa',
        problem: "manifest icon on https://missing.invalid, not the site's origin",
      },
    ]);
    expect(manifestIconUrls('<!doctype html>', `${base}/site.webmanifest`, [base, publicOrigin])).toEqual({
      urls: [],
      problems: [{ path: `${base}/site.webmanifest`, problem: 'the web manifest does not parse' }],
    });
  });

  it('reports a manifest that is not an object with an icons list, and icons without a usable src', () => {
    const at = `${base}/site.webmanifest`;
    for (const manifest of ['null', '[]', '"x"', '{}', '{"icons":null}']) {
      expect(manifestIconUrls(manifest, at, [base])).toEqual({ urls: [], problems: [{ path: at, problem: 'the web manifest has no icons list' }] });
    }
    expect(manifestIconUrls('{"icons":[null,{"src":7},{"src":"http://["},{"src":" "},{"src":"/brand/a.png?v=aaaaaaaaaa"}]}', at, [base])).toEqual({
      urls: [`${base}/brand/a.png?v=aaaaaaaaaa`],
      problems: [
        { path: at, problem: 'a manifest icon has no usable src (none)' },
        { path: at, problem: 'a manifest icon has no usable src (7)' },
        { path: at, problem: 'a manifest icon has no usable src ("http://[")' },
        { path: at, problem: 'a manifest icon has no usable src (" ")' },
      ],
    });
  });

  it('hands back the compared bodies, so manifest icons come from the bytes compared; a null rejection is reported', async () => {
    const at = `${base}/site.webmanifest?v=bbbbbbbbbb`;
    const manifest = (src: string) => `{"icons":[{"src":"${src}"}]}`;
    const answer = (respond: (url: URL) => Response | Promise<Response>) =>
      (async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual');
        return respond(new URL(String(input)));
      }) as typeof fetch;
    const json = { 'content-type': 'application/manifest+json' };
    // Stale: the cached copy names the old icon, the fresh one a new icon. Both bodies come back, so both icons are read.
    const bodies = new Map<string, Buffer[]>();
    const stale = answer((url) => new Response(manifest(url.searchParams.has('cb') ? '/brand/new.png' : '/brand/old.png'), { headers: json }));
    expect((await compareAssets([at], stale, bodies)).map((problem) => problem.problem)).toEqual([
      expect.stringMatching(/^stale: \d+ bytes as written vs \d+ bytes uncached$/),
    ]);
    expect((bodies.get(at) ?? []).map((body) => manifestIconUrls(body.toString('utf8'), at, [base]).urls[0])).toEqual([
      `${base}/brand/old.png`,
      `${base}/brand/new.png`,
    ]);
    // A redirect, a refused connection and a body that errors (with an Error or with null) leave no body to read icons
    // from, and each is reported; nothing throws.
    const cases: [string, typeof fetch][] = [
      ['redirect', answer(() => new Response(null, { status: 302, headers: { location: '/empty.webmanifest' } }))],
      ['refused', answer(() => Promise.reject(new Error('connect ECONNREFUSED')))],
      ['body error', answer(() => new Response(new ReadableStream({ pull: (controller) => controller.error(new Error('body reset')) })))],
      ['body null', answer(() => new Response(new ReadableStream({ pull: (controller) => controller.error(null) })))],
      ['rejects null', answer(() => Promise.reject(null))],
    ];
    const reported: Record<string, string[]> = {};
    for (const [label, fetcher] of cases) {
      const caseBodies = new Map<string, Buffer[]>();
      reported[label] = (await compareAssets([at], fetcher, caseBodies)).map((problem) => problem.problem);
      expect(caseBodies.get(at) ?? []).toEqual([]);
    }
    expect(reported).toEqual({
      redirect: [
        'redirects (302 to /empty.webmanifest, as written)',
        'redirects (302 to /empty.webmanifest, uncached)',
        'served as no content type (as written)',
        'served as no content type (uncached)',
        'answered 302 as written and 302 uncached',
      ],
      refused: ['fetch failed: connect ECONNREFUSED'],
      'body error': ['fetch failed: body reset'],
      'body null': ['fetch failed: null'],
      'rejects null': ['fetch failed: null'],
    });
  });

  it('reports an asset reference that is not a URL', () => {
    expect(collectAssetUrls('<img src="http://[/media/a.webp">', base, [base]).problems).toEqual([
      { path: base, problem: 'an asset reference is not a URL (http://[/media/a.webp)' },
    ]);
  });

  it('reports an asset URL on another host', () => {
    const html = '<meta property="og:image" content="https://elsewhere.example/og/home.png?v=cccccccc">';
    expect(collectAssetUrls(html, base, [base, publicOrigin]).problems).toEqual([
      { path: 'https://elsewhere.example/og/home.png?v=cccccccc', problem: "on https://elsewhere.example, not the site's origin" },
    ]);
  });

  it('fails a stale file, an unversioned URL, an HTML fallback, a redirect and a failed fetch; passes a fresh one', async () => {
    const requested: string[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      const url = new URL(String(input));
      requested.push(url.origin);
      if (url.pathname.includes('down')) throw new Error('connect ECONNREFUSED');
      if (url.pathname.includes('moved')) return new Response(null, { status: 301, headers: { location: '/media/moved-light-640.webp' } });
      if (url.pathname.includes('fallback') || (url.pathname.includes('half') && url.searchParams.has('cb'))) {
        return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
      }
      const uncached = url.searchParams.has('cb');
      const body = url.pathname.includes('stale') && !uncached ? 'old bytes' : 'new bytes';
      // Upper case on purpose: media types are case-insensitive.
      return new Response(body, { headers: { 'content-type': url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'Image/WebP' } });
    }) as typeof fetch;
    const problems = await compareAssets(
      [
        `${base}/media/stale-light-640.webp?v=eeeeeeeeee`,
        `${base}/media/fresh-light-640.webp?v=ffffffffff`,
        `${base}/media/fallback-light-640.webp?v=0000000000`,
        `${base}/brand/logo.svg`,
        `${base}/media/half-light-640.webp?v=4444444444`,
        `${base}/media/capture.wepb?v=5555555555`,
        `${base}/media/moved-light-640.webp?v=6666666666`,
        `${base}/media/down-light-640.webp?v=7777777777`,
        `${publicOrigin}/og/home.webp?v=88888888`,
      ],
      fetcher,
    );
    expect(problems.map((problem) => `${problem.path} ${problem.problem}`).sort()).toEqual([
      `${base}/brand/logo.svg unversioned URL to a fixed-name file`,
      `${base}/media/capture.wepb?v=5555555555 not a known media, card, brand or manifest file type`,
      `${base}/media/down-light-640.webp?v=7777777777 fetch failed: connect ECONNREFUSED`,
      `${base}/media/fallback-light-640.webp?v=0000000000 served as text/html (as written)`,
      `${base}/media/fallback-light-640.webp?v=0000000000 served as text/html (uncached)`,
      `${base}/media/half-light-640.webp?v=4444444444 served as text/html (uncached)`,
      `${base}/media/half-light-640.webp?v=4444444444 stale: 9 bytes as written vs 15 bytes uncached`,
      `${base}/media/moved-light-640.webp?v=6666666666 answered 301 as written and 301 uncached`,
      `${base}/media/moved-light-640.webp?v=6666666666 redirects (301 to /media/moved-light-640.webp, as written)`,
      `${base}/media/moved-light-640.webp?v=6666666666 redirects (301 to /media/moved-light-640.webp, uncached)`,
      `${base}/media/moved-light-640.webp?v=6666666666 served as no content type (as written)`,
      `${base}/media/moved-light-640.webp?v=6666666666 served as no content type (uncached)`,
      `${base}/media/stale-light-640.webp?v=eeeeeeeeee stale: 9 bytes as written vs 9 bytes uncached`,
    ]);
    // The card on the public origin was fetched there, not on the checked origin.
    expect(requested).toContain(publicOrigin);
  });
});
