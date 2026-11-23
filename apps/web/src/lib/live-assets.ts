import { elements, parsePage } from './page-dom';

/**
 * The fixed-name files a page references (/media/, /og/, /brand/, the web manifest), for check-live.ts: read from the
 * parsed HTML (any attribute quoting), every srcset entry, social-card meta tags and JSON-LD image references. Each is
 * returned as path + query on the checked origin.
 */
const ASSET = /^\/(?:media|og|brand)\/|^\/site\.webmanifest(?:\?|$)/;

/** A reference that names a fixed-name file kind; it must resolve to the site's own directory for that kind. */
const ASSET_LIKE = /\/(?:media|og|brand)\/|site\.webmanifest/;

/**
 * `pageUrl` is the page's own (final) URL, against which relative references resolve as in a browser. `allowedOrigins`
 * are the checked origin and the public one: a page or manifest that redirected elsewhere does not widen them, so an asset
 * that resolves to another host fails instead of being fetched on the checked host under the same path.
 * is the origin the build names in absolute URLs.
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
      if (ASSET_LIKE.test(url.pathname))
        problems.push({ path: `${url.pathname}${url.search}`, problem: `resolves outside the site's asset directories (${value})` });
      return;
    }
    const path = `${url.pathname}${url.search}`;
    // An absolute URL on another host would point visitors somewhere this check never fetched.
    if (!origins.has(url.origin)) problems.push({ path, problem: `on ${url.origin}, not the site's origin` });
    urls.add(path);
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
      problems.push({ path: '(JSON-LD)', problem: 'a JSON-LD block does not parse' });
    }
  }
  return { urls, problems };
}

/** The icon URLs a web app manifest names, resolved against the manifest's URL; an icon on another host is a problem. */
export function manifestIconUrls(manifest: string, manifestUrl: string, allowedOrigins: string[] = [manifestUrl]) {
  const parsed = JSON.parse(manifest) as { icons?: { src: string }[] };
  const origins = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const urls: string[] = [];
  const problems: AssetProblem[] = [];
  for (const icon of parsed.icons ?? []) {
    const url = new URL(icon.src, manifestUrl);
    const path = `${url.pathname}${url.search}`;
    if (!origins.has(url.origin)) problems.push({ path, problem: `manifest icon on ${url.origin}, not the site's origin` });
    urls.push(path);
  }
  return { urls, problems };
}

export interface AssetProblem {
  path: string;
  problem: string;
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
 * Fetches each URL as written and with a random extra query no cache has seen. Different bytes mean a cache is serving
 * an old file under a URL whose page now describes a new one. An unversioned URL, or a file served with the wrong
 * content type (such as an HTML fallback page under an image URL), is reported too.
 */
export async function compareAssets(paths: Iterable<string>, base: string, fetcher: typeof fetch = fetch) {
  const problems: AssetProblem[] = [];
  const bytesAt = async (path: string) => {
    const response = await fetcher(new URL(path, base));
    // Media types are case-insensitive (RFC 9110): compare them in lower case.
    return {
      status: response.status,
      type: (response.headers.get('content-type') ?? '').toLowerCase(),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
  for (const path of [...paths].sort()) {
    if (!/[?&]v=[0-9a-f]{8,}/.test(path)) problems.push({ path, problem: 'unversioned URL to a fixed-name file' });
    const plain = await bytesAt(path);
    const fresh = await bytesAt(`${path}${path.includes('?') ? '&' : '?'}cb=${crypto.randomUUID()}`);
    const expected = TYPES.find(([extension]) => extension.test(path.replace(/\?.*$/, '')))?.[1];
    if (!expected) {
      problems.push({ path, problem: 'not a known media, card, brand or manifest file type' });
    } else {
      for (const [label, response] of [
        ['as written', plain],
        ['uncached', fresh],
      ] as const) {
        if (!expected.test(response.type)) problems.push({ path, problem: `served as ${response.type || 'no content type'} (${label})` });
      }
    }
    if (plain.status !== 200 || fresh.status !== 200) {
      problems.push({ path, problem: `answered ${plain.status} as written and ${fresh.status} uncached` });
    } else if (!plain.bytes.equals(fresh.bytes)) {
      problems.push({ path, problem: `stale: ${plain.bytes.length} bytes as written vs ${fresh.bytes.length} bytes uncached` });
    }
  }
  return problems;
}
