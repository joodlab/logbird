import { ASSET_VERSIONS } from './asset-versions';

/**
 * URLs for files the site serves under fixed names, each with its content version (`?v=`): the only way the site writes
 * one. /media/* is cached for a day with a week of stale-while-revalidate, and the CDN keys its cache on the full URL, so
 * a file replaced under the same name gets a new URL and every visitor gets the new bytes at once. Versions:
 * src/lib/asset-versions.ts (`pnpm assets:versions`).
 */
function versioned(path: string, key: string) {
  const version = ASSET_VERSIONS[key];
  if (!version) {
    throw new Error(`No asset version for ${key}: run pnpm assets:versions`);
  }
  return `${path}?v=${version}`;
}

/** A file in /media; `key` names its source (`<id>/<theme>`, `<clip>.webm`, `<clip>-poster`). */
export const mediaUrl = (file: string, key: string) => versioned(`/media/${file}`, key);
/** A clip's video and poster (components/clip.tsx). */
export const clipUrls = (id: string) => ({ video: mediaUrl(`${id}.webm`, `${id}.webm`), poster: mediaUrl(`${id}-poster.webp`, `${id}-poster`) });
/** A capture's file at one width and format; `id` names the variant (`<id>` or `<id>-phone`), versioned per theme. */
export const screenshotUrl = (id: string, theme: 'light' | 'dark', width: number | undefined, format: string) =>
  mediaUrl(`${id}-${theme}-${width}.${format}`, `${id}/${theme}`);
/** A capture variant's `srcset`: one versioned file per width (components/screenshot.tsx). */
export const screenshotSrcSet = (id: string, theme: 'light' | 'dark', format: string, widths: number[]) =>
  widths.map((width) => `${screenshotUrl(id, theme, width, format)} ${width}w`).join(', ');
/** The id of a capture's phone variant. */
export const phoneVariantId = (id: string) => `${id}-phone`;
/** A file in /brand. */
export const brandUrl = (file: string) => versioned(`/brand/${file}`, `brand/${file}`);
/** The web app manifest, whose icon URLs are versioned too. */
export const manifestUrl = () => versioned('/site.webmanifest', 'site.webmanifest');
