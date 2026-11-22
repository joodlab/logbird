import { APP_URL, GITHUB_PUBLIC } from '../env';
import { SELF_HOST_VERSION } from '../lib/selfhost';

/**
 * The publication state that every content module reads. Modules are functions of this state, so tests can render each
 * variant, and a value that comes from config or data is never written as a literal.
 *
 * Content modules (apps/web/src/content/) hold the site's words: headings, bodies, lists, table rows, calls to action
 * and metadata. Route files and marketing components hold layout only; content-modules.test.ts fails on a prose
 * literal in a file that has moved. marketing/copy/*.md is the brief: messaging, sources and owner notes.
 */
export interface SiteState {
  /** The source is on GitHub (WEB_GITHUB_PUBLIC). */
  repoPublic: boolean;
  /** WEB_APP_URL is set: the hosted console takes sign-ins, and sign-ups stay limited to invited teams. */
  cloudOpen: boolean;
  /** The console's sign-in page. Always `/login`, never the console root: a signed-out `/` is the marketing home. */
  signInUrl?: string;
  /** The newest published release, from the release list; undefined before the first one. */
  selfHostVersion?: string;
}

export const SITE: SiteState = {
  repoPublic: GITHUB_PUBLIC,
  cloudOpen: Boolean(APP_URL),
  signInUrl: APP_URL ? `${APP_URL}/login` : undefined,
  selfHostVersion: SELF_HOST_VERSION,
};

/** Words that differ with the repository's visibility. Both variants are required, so a missing one fails tsc. */
export type ByRepo<T> = Record<'public' | 'private', T>;
/** Words that differ with Logbird Cloud's state. Both variants are required. */
export type ByCloud<T> = Record<'open' | 'closed', T>;

export const byRepo = <T>(site: SiteState, words: ByRepo<T>): T => (site.repoPublic ? words.public : words.private);
export const byCloud = <T>(site: SiteState, words: ByCloud<T>): T => (site.cloudOpen ? words.open : words.closed);

/** A call to action: its label and where it leads. */
export interface Cta {
  label: string;
  to: string;
  search?: Record<string, string>;
}

/** Text with the copy's inline marks, `code`, **bold** and *emphasis*, rendered by components/marketing/rich.tsx. */
export type Marked = string;

/** A title and the text that follows it. */
export interface Item {
  title: Marked;
  body: Marked;
}
