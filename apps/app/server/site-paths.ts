/** Marketing routes are opt-in at the proxy; API/reference decisions always run first. */
export const siteSegments = [
  '/product',
  '/cloud',
  '/self-hosting',
  '/open-source',
  '/developers',
  '/security',
  '/compare',
  '/blog',
  '/changelog',
  '/about',
  '/contact',
  '/legal',
] as const;
export const siteFiles = ['/robots.txt', '/sitemap.xml', '/llms.txt', '/site.webmanifest', '/404.html'] as const;
export const sitePrefixes = ['/site-assets/', '/site-api/', '/media/', '/og/'] as const;
export const siteMethods = ['GET', 'HEAD'] as const;
export const siteApiMethods = [...siteMethods, 'POST'] as const;
export const sessionCookieNames = ['logbird.session_token', '__Secure-logbird.session_token'] as const;
/** Explicit dev routes bypass Nitro's asset-extension heuristic. */
export const siteRoutePatterns = [
  ...siteSegments.flatMap((segment) => [segment, `${segment}/**`]),
  ...siteFiles,
  ...sitePrefixes.map((prefix) => `${prefix}**`),
] as const;

export function siteDecision({ pathname, method, cookie }: { pathname: string; method: string; cookie?: string | null }): 'site' | 'console' {
  // Decode only for ambiguity checks. Matching below always uses the raw, case-sensitive path.
  if (/%(?:2f|5c)/i.test(pathname) || pathname.includes('\\') || pathname.includes('//')) return 'console';
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return 'console';
  }
  if (decoded.split('/').some((segment) => segment === '.' || segment === '..')) return 'console';
  const allowed = pathname.startsWith('/site-api/') ? siteApiMethods : siteMethods;
  if (!(allowed as readonly string[]).includes(method.toUpperCase())) return 'console';
  if (pathname === '/') {
    const signedIn = (cookie ?? '').split(';').some((entry) => {
      const separator = entry.indexOf('=');
      return (
        separator >= 0 &&
        (sessionCookieNames as readonly string[]).includes(entry.slice(0, separator).trim()) &&
        entry.slice(separator + 1).trim().length > 0
      );
    });
    return signedIn ? 'console' : 'site';
  }
  return siteSegments.some((segment) => pathname === segment || pathname.startsWith(`${segment}/`)) ||
    (siteFiles as readonly string[]).includes(pathname) ||
    sitePrefixes.some((prefix) => pathname.startsWith(prefix))
    ? 'site'
    : 'console';
}
