import { elements, parsePage } from './page-dom';

/**
 * The fixed-name files a page references (/media/, /og/, /brand/, the web manifest), for check-live.ts: read from the
 * parsed HTML (any attribute quoting), every srcset entry, social-card meta tags and JSON-LD image references. Each is
 * returned as path + query on the checked origin.
 */
const ASSET = /^\/(?:media|og|brand)\/|^\/site\.webmanifest(?:\?|$)/;

export function collectAssetUrls(html: string, base: string) {
  const urls = new Set<string>();
  const add = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    const url = new URL(value, base);
    if (ASSET.test(url.pathname)) urls.add(`${url.pathname}${url.search}`);
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
  // JSON-LD bodies (the parser keeps no script children): any string that names an asset.
  for (const [, json] of html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const [, value] of (json ?? '').matchAll(/"((?:https?:\/\/[^"/]+)?\/(?:media|og|brand)\/[^"]+)"/g)) add(value ?? '');
  }
  return urls;
}

/** The icon URLs a web app manifest names. */
export function manifestIconUrls(manifest: string, base: string) {
  const parsed = JSON.parse(manifest) as { icons?: { src: string }[] };
  return (parsed.icons ?? []).map((icon) => {
    const url = new URL(icon.src, base);
    return `${url.pathname}${url.search}`;
  });
}

export interface AssetProblem {
  path: string;
  problem: string;
}

/**
 * Fetches each URL as written and with a random extra query no cache has seen. Different bytes mean a cache is serving
 * an old file under a URL whose page now describes a new one. An unversioned URL is reported too.
 */
export async function compareAssets(paths: Iterable<string>, base: string, fetcher: typeof fetch = fetch) {
  const problems: AssetProblem[] = [];
  const bytesAt = async (path: string) => {
    const response = await fetcher(new URL(path, base));
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  for (const path of [...paths].sort()) {
    if (!/[?&]v=[0-9a-f]{8,}/.test(path)) problems.push({ path, problem: 'unversioned URL to a fixed-name file' });
    const plain = await bytesAt(path);
    const fresh = await bytesAt(`${path}${path.includes('?') ? '&' : '?'}cb=${crypto.randomUUID()}`);
    if (plain.status !== 200 || fresh.status !== 200) {
      problems.push({ path, problem: `answered ${plain.status} as written and ${fresh.status} uncached` });
    } else if (!plain.bytes.equals(fresh.bytes)) {
      problems.push({ path, problem: `stale: ${plain.bytes.length} bytes as written vs ${fresh.bytes.length} bytes uncached` });
    }
  }
  return problems;
}
