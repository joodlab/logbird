/**
 * Public changelog and blog entries. Maintainers add an entry when the change or post is published,
 * following marketing/README.md. The page that lists it becomes `ready` with its first entry (site-map.ts).
 *
 * Rules for every entry (marketing/copy/changelog.md § how-we-write): one change in the user's words, the limit stated
 * with the change, real captures only (a media-manifest id), no performance numbers without a linked measurement, no
 * design-partner name, fictional data only.
 */

export interface BuildLogEntry {
  /** ISO date the work shipped, e.g. `2026-11-07`. */
  date: string;
  title: string;
  /** One or two sentences; inline `code`, **bold** and *emphasis* render (Rich). */
  summary: string;
  /** A media-manifest screenshot id, shown beside the entry. */
  media?: string;
}

export interface Release {
  version: string;
  date: string;
  /** Upgrade steps first, as CHANGELOG.md lists them. */
  upgrade?: string[];
  added?: string[];
  fixed?: string[];
  changed?: string[];
  security?: string[];
}

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO publication date. */
  published: string;
  modified?: string;
  author: string;
  /** Paragraphs; inline `code`, **bold** and *emphasis* render (Rich). */
  body: string[];
}

export const buildLog: BuildLogEntry[] = [];
export const releases: Release[] = [];
export const posts: Post[] = [];

/** "7 November 2026", fixed to UTC so the prerendered date never depends on the build machine. */
export const publicationDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const postPath = (post: Pick<Post, 'slug'>) => `/blog/${post.slug}`;
export const findPost = (slug: string) => posts.find((post) => post.slug === slug);
export const newestFirst = <T extends { date?: string; published?: string }>(items: T[]) =>
  [...items].sort((a, b) => (b.date ?? b.published ?? '').localeCompare(a.date ?? a.published ?? ''));
