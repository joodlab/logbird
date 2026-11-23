import { MEDIA_VERSIONS } from './media-versions';

/**
 * A media URL with its content version (`?v=`), the only way the site writes one. /media/* is cached for a day with a
 * week of stale-while-revalidate, and the CDN keys its cache on the full URL, so a file replaced under the same name
 * gets a new URL and every visitor gets the new bytes at once. `key` names the source (src/lib/media-versions.ts).
 */
export function mediaUrl(file: string, key: string) {
  const version = MEDIA_VERSIONS[key];
  if (!version) {
    throw new Error(`No media version for ${key}: run pnpm media:versions`);
  }
  return `/media/${file}?v=${version}`;
}
