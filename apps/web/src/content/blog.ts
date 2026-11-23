import { isReady } from '../lib/site-map';

/**
 * Words of /blog. Brief: marketing/copy/blog.md. Posts come from lib/publications.ts, added only once the owner publishes
 * them; a post's own frame is content/blog-post.ts (kept apart so the post route doesn't share this module).
 */
export const blog = {
  hero: {
    eyebrow: 'Blog',
    title: 'Notes from building Logbird.',
    lead: `Longer posts on how Logbird works and why: the decisions, the guarantees, and the limits.${isReady('/changelog') ? ' For day-by-day progress, see the changelog.' : ''}`,
    changelog: 'Changelog and build log',
  },
  /** The list's heading, for screen readers. */
  postsTitle: 'Posts',
  empty: 'No posts yet. The first one is on its way.',
} as const;
