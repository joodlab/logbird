import { elements, parsePage } from './page-dom';

/**
 * The fixed-name files a page references (/media/, /og/, /brand/, the web manifest), for check-live.ts: read from the
 * parsed HTML (any attribute quoting), every srcset entry, social-card meta tags and JSON-LD image references. Each is
 * kept as the exact absolute URL a visitor's browser requests, origin included, so the check fetches what visitors get.
 */
const ASSET = /^\/(?:media|og|brand)\/|^\/site\.webmanifest$/;

/** A reference that names a fixed-name file kind; it must resolve to the site's own directory for that kind. */
const ASSET_LIKE = /\/(?:media|og|brand)\/|site\.webmanifest/;

export interface AssetProblem {
  path: string;
  problem: string;
}

/**
 * `pageUrl` is the page's own (final) URL, against which relative references resolve as in a browser. `allowedOrigins`
 * are the checked origin and the public one: a page or manifest that redirected elsewhere does not widen them, so an
 * asset that resolves to another host fails.
 */
export function collectAssetUrls(html: string, pageUrl: string, allowedOrigins: string[] = [pageUrl]) {
  const urls = new Set<string>();
  const problems: AssetProblem[] = [];
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const url = new URL(value, pageUrl);
    if (!ASSET.test(url.pathname)) {
      if (ASSET_LIKE.test(url.pathname)) problems.push({ path: url.href, problem: `resolves outside the site's asset directories (${value})` });
      return;
    }
    if (!origins.has(url.origin)) problems.push({ path: url.href, problem: `on ${url.origin}, not the site's origin` });
    urls.add(url.href);
  };
  for (const element of elements(parsePage(html))) {
    const { attrs } = element;
    for (const name of ['src', 'poster', 'href', 'content']) {
      if (attrs[name]) add(attrs[name]);
    }
    for (const name of ['srcset', 'imagesrcset']) {
      for (const entry of (attrs[name] ?? '').split(',')) add(entry.trim().split(/\s+/)[0] ?? '');
    }
  }
  // JSON-LD bodies (the parser keeps no script children): every string in the decoded JSON that names an asset.
  for (const [, attributes = '', body = ''] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']?\s*application\/ld\+json\s*["']?/i.test(attributes)) continue;
    const walk = (node: unknown): void => {
      if (typeof node === 'string') add(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    try {
      walk(JSON.parse(body));
    } catch {
      problems.push({ path: pageUrl, problem: 'a JSON-LD block does not parse' });
    }
  }
  return { urls, problems };
}

/**
 * The icon URLs a web app manifest names, as absolute URLs resolved against the manifest's URL; an icon on another host,
 * or a manifest that does not parse, is a problem.
 */
export function manifestIconUrls(manifest: string, manifestUrl: string, allowedOrigins: string[] = [manifestUrl]) {
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const urls: string[] = [];
  const problems: AssetProblem[] = [];
  let parsed: { icons?: { src: string }[] };
  try {
    parsed = JSON.parse(manifest) as { icons?: { src: string }[] };
  } catch {
    return { urls, problems: [{ path: manifestUrl, problem: 'the web manifest does not parse' }] };
  }
  for (const icon of parsed.icons ?? []) {
    const url = new URL(icon.src, manifestUrl);
    if (!origins.has(url.origin)) problems.push({ path: url.href, problem: `manifest icon on ${url.origin}, not the site's origin` });
    urls.push(url.href);
  }
  return { urls, problems };
}

/** The content type each kind of file must be served with; a fallback HTML page under an image URL fails. */
const TYPES: [RegExp, RegExp][] = [
  [/\.avif$/, /^image\/avif/],
  [/\.webp$/, /^image\/webp/],
  [/\.png$/, /^image\/png/],
  [/\.svg$/, /^image\/svg\+xml/],
  [/\.webm$/, /^video\/webm/],
  [/\.webmanifest$/, /^application\/(manifest\+)?json/],
];

/**
 * Fetches each exact URL as written and with a random extra query no cache has seen. Different bytes mean a cache is
 * serving an old file under a URL whose page now describes a new one. Redirects are not followed: a fixed-name file must
 * answer itself, since a redirect could drop both queries and compare two cached copies. An unversioned URL, a file
 * with the wrong content type (such as an HTML fallback under an image URL) and a failed fetch are reported too.
 */
export async function compareAssets(urls: Iterable<string>, fetcher: typeof fetch = fetch) {
  const problems: AssetProblem[] = [];
  const fetchOnce = async (url: string) => {
    const response = await fetcher(url, { redirect: 'manual' });
    // Media types are case-insensitive (RFC 9110): compare them in lower case.
    return {
      status: response.status,
      location: response.headers.get('location'),
      type: (response.headers.get('content-type') ?? '').toLowerCase(),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
  for (const url of [...urls].sort()) {
    try {
      const parsed = new URL(url);
      if (!/^[0-9a-f]{8,}$/.test(parsed.searchParams.get('v') ?? '')) problems.push({ path: url, problem: 'unversioned URL to a fixed-name file' });
      const uncached = new URL(url);
      uncached.searchParams.set('cb', crypto.randomUUID());
      const plain = await fetchOnce(url);
      const fresh = await fetchOnce(uncached.href);
      for (const [label, response] of [
        ['as written', plain],
        ['uncached', fresh],
      ] as const) {
        if (response.status >= 300 && response.status < 400) {
          problems.push({ path: url, problem: `redirects (${response.status} to ${response.location ?? 'nowhere'}, ${label})` });
        }
      }
      const expected = TYPES.find(([extension]) => extension.test(parsed.pathname))?.[1];
      if (!expected) {
        problems.push({ path: url, problem: 'not a known media, card, brand or manifest file type' });
      } else {
        for (const [label, response] of [
          ['as written', plain],
          ['uncached', fresh],
        ] as const) {
          if (!expected.test(response.type)) problems.push({ path: url, problem: `served as ${response.type || 'no content type'} (${label})` });
        }
      }
      if (plain.status !== 200 || fresh.status !== 200) {
        problems.push({ path: url, problem: `answered ${plain.status} as written and ${fresh.status} uncached` });
      } else if (!plain.bytes.equals(fresh.bytes)) {
        problems.push({ path: url, problem: `stale: ${plain.bytes.length} bytes as written vs ${fresh.bytes.length} bytes uncached` });
      }
    } catch (error) {
      problems.push({ path: url, problem: `fetch failed: ${(error as Error).message}` });
    }
  }
  return problems;
}
