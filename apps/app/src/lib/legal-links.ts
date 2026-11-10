/**
 * Where the sign-in screen links the operator's terms and privacy policy.
 *
 * - `LOGBIRD_TERMS_URL` / `LOGBIRD_PRIVACY_URL`: an absolute https/http URL or a path on this origin (`/legal/terms`).
 * - Otherwise, when the console forwards a marketing site (`LOGBIRD_SITE_URL`, as on Logbird Cloud), the site's own
 *   `/legal/terms` and `/legal/privacy` on this origin.
 * - Otherwise no link: a self-hosted install has its own operator and terms, so the console invents none.
 *
 * Anything that isn't an http(s) URL or a same-origin path (`javascript:`, `//host`, relative paths) is ignored.
 */
export interface LegalLinks {
  terms?: string;
  privacy?: string;
}

function safeHref(value: string | undefined): string | undefined {
  const href = value?.trim();
  if (!href) return;
  if (href.startsWith('/') && !href.startsWith('//') && !href.includes('\\')) return href;
  const url = URL.canParse(href) ? new URL(href) : undefined;
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? url.href : undefined;
}

export function legalLinksFrom(env: Record<string, string | undefined>): LegalLinks {
  const forwardsSite = Boolean(env.LOGBIRD_SITE_URL?.trim());
  return {
    terms: safeHref(env.LOGBIRD_TERMS_URL) ?? (forwardsSite ? '/legal/terms' : undefined),
    privacy: safeHref(env.LOGBIRD_PRIVACY_URL) ?? (forwardsSite ? '/legal/privacy' : undefined),
  };
}
