import { GITHUB_PUBLIC } from '../env';
import { buildLog, postPath, posts, releases } from './publications';

export interface SitePage {
  path: string;
  title: string;
  description: string;
  section: 'product' | 'developers' | 'company' | 'legal' | 'compare' | 'resources';
  priority: number;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  ogSlug: string;
  inNav?: boolean;
  inFooter?: boolean;
  /** Shorter label for the footer, when the title is long. */
  footerTitle?: string;
  /**
   * Designed and approved for publishing. Pages that aren't ready render a placeholder, are `noindex`, and are left out
   * of the nav, footer, sitemap and llms.txt. Each page PR flips its own flag.
   */
  ready: boolean;
}
export const siteMap: SitePage[] = [
  {
    path: '/',
    title: 'Home',
    description: 'Open-source audit logs you can self-host.',
    section: 'product',
    priority: 1,
    changefreq: 'daily',
    ready: true,
    ogSlug: 'home',
    inNav: false,
    inFooter: false,
  },
  {
    path: '/product',
    title: 'Product',
    description:
      'Search every event, follow actors, tenants, workers and records, open operation trees, and keep data for exactly as long as you choose.',
    section: 'product',
    priority: 0.9,
    changefreq: 'weekly',
    ready: true,
    ogSlug: 'product',
    inNav: true,
    inFooter: true,
    footerTitle: 'Product tour',
  },
  {
    path: '/developers',
    title: 'Developers',
    description:
      'Send audit events from TypeScript, Hono, TanStack Start, Vue, Nuxt or any HTTP client. Envelope guide, workers, delivery semantics and limits.',
    section: 'developers',
    priority: 0.9,
    changefreq: 'weekly',
    ready: true,
    ogSlug: 'developers',
    inNav: true,
    inFooter: true,
    footerTitle: 'Developer guide',
  },
  {
    path: '/self-hosting',
    title: 'Self-host',
    description: 'Run Logbird on your own server with Docker Compose or Coolify. Bring your own Postgres, ClickHouse and Redis, add TLS, back it up.',
    section: 'developers',
    priority: 0.9,
    changefreq: 'weekly',
    ready: true,
    ogSlug: 'self-hosting',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/cloud',
    title: 'Cloud',
    description: "Logbird Cloud will run the same open-source codebase for you. It isn't open yet. Join the waitlist. Pricing isn't set yet.",
    section: 'product',
    priority: 0.9,
    changefreq: 'weekly',
    ready: true,
    ogSlug: 'cloud',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/open-source',
    title: 'Open source',
    description: `The Logbird product is MIT-licensed: API, console, worker, SDK and integrations, in one repository${GITHUB_PUBLIC ? ' on GitHub' : ' that opens publicly soon'}.`,
    section: 'developers',
    priority: 0.8,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'open-source',
    inNav: true,
    inFooter: true,
  },
  {
    path: '/security',
    title: 'Security',
    description:
      "How Logbird isolates projects, stores keys, guards SQL, deletes expired data and records its own management actions, and what we don't claim yet.",
    section: 'company',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'security',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare',
    title: 'Compare',
    description:
      'Fair, sourced comparisons of Logbird with Retraced, WorkOS Audit Logs, Pangea Secure Audit Log and Bemi, including when to choose them.',
    section: 'compare',
    priority: 0.8,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare',
    inNav: true,
    inFooter: true,
    footerTitle: 'All comparisons',
  },
  {
    path: '/compare/retraced',
    title: 'Retraced',
    description: 'Retraced is an Apache-2.0 audit log service with an embeddable React viewer. How it compares with Logbird, sourced and dated.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-retraced',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/workos-audit-logs',
    title: 'WorkOS Audit Logs',
    description:
      'WorkOS Audit Logs is a hosted audit log API with an Admin Portal viewer and SIEM log streams. How it compares with Logbird, sourced.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-workos-audit-logs',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/pangea',
    title: 'Pangea',
    description:
      'Pangea Secure Audit Log, now part of CrowdStrike, is a hosted, tamperproof audit log. How it compares with Logbird, sourced and dated.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-pangea',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/compare/bemi',
    title: 'Bemi',
    description:
      'Bemi captures every Postgres row change automatically. Logbird records the actions your app reports. Different tools, sometimes used together.',
    section: 'compare',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'compare-bemi',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/changelog',
    title: 'Changelog',
    description: 'What changed in Logbird, release by release, plus the build log of what we shipped each day, with real captures.',
    section: 'resources',
    priority: 0.6,
    changefreq: 'weekly',
    // Ready with the first release or the first approved build-log entry (publications.ts).
    ready: releases.length > 0 || buildLog.length > 0,
    ogSlug: 'changelog',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/blog',
    title: 'Blog',
    description: 'Notes on building an open-source audit log: design decisions, guarantees and limits, written by the people building Logbird.',
    section: 'resources',
    priority: 0.6,
    changefreq: 'weekly',
    // Ready with the first published post (publications.ts).
    ready: posts.length > 0,
    ogSlug: 'blog',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/blog/$slug',
    title: 'Blog post',
    description: 'A post from the Logbird blog.',
    section: 'resources',
    priority: 0.3,
    changefreq: 'monthly',
    ready: false,
    ogSlug: 'blog-draft',
    inNav: false,
    inFooter: false,
  },
  {
    path: '/about',
    title: 'About',
    description: 'Logbird is an open-source audit log for teams who owe their customers a trail of who did what.',
    section: 'company',
    priority: 0.6,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'about',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/contact',
    title: 'Contact',
    description: 'Join the Logbird Cloud waitlist or send us a question. We store your email only to contact you about Logbird. No trackers.',
    section: 'company',
    priority: 0.7,
    changefreq: 'monthly',
    ready: true,
    ogSlug: 'contact',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/legal/privacy',
    title: 'Privacy',
    description: 'How the Logbird website handles your data. Placeholder until counsel-reviewed text replaces it before launch.',
    section: 'legal',
    priority: 0.3,
    changefreq: 'yearly',
    // Placeholder copy: ready only once counsel-reviewed text replaces it.
    ready: false,
    ogSlug: 'privacy',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/legal/terms',
    title: 'Terms',
    description: 'Terms of use for the Logbird website. Placeholder until counsel-reviewed text replaces it before launch.',
    section: 'legal',
    priority: 0.3,
    changefreq: 'yearly',
    // Placeholder copy: ready only once counsel-reviewed text replaces it.
    ready: false,
    ogSlug: 'terms',
    inNav: false,
    inFooter: true,
  },
  {
    path: '/404',
    title: 'Page not found',
    description: 'The requested page could not be found.',
    section: 'resources',
    priority: 0,
    changefreq: 'yearly',
    ready: false,
    ogSlug: '404',
  },
];
export const staticPages = siteMap.filter((page) => !page.path.includes('$') && page.path !== '/404');
/** Pages that are linked from the nav/footer and listed in the sitemap and llms.txt. */
export const publishedPages = staticPages.filter((page) => page.ready);
/** Every static page plus each published post. */
export const prerenderPaths = [...staticPages.map((page) => page.path), ...posts.map(postPath)];
/** True for designed pages; use it to skip wrappers whose only content is a link to an unready page. */
export const isReady = (path: string) => siteMap.some((page) => page.path === path && page.ready);
export function getPage(path: string): SitePage {
  const page = siteMap.find((entry) => entry.path === path);
  if (!page) {
    throw new Error(`Missing site manifest entry: ${path}`);
  }
  return page;
}
