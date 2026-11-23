/** Words of the not-found page (components/not-found.tsx, /404 and every unknown path). Brief: marketing/copy/404.md. */
export const notFoundPage = {
  /** The document title; the page also sets noindex. */
  documentTitle: 'Page not found · Logbird',
  eyebrow: '404',
  title: 'No event at this address.',
  lead: 'We searched and found nothing. The page may have moved, or the link may be wrong.',
  /** The decorative search line (aria-hidden): query → result. */
  search: { query: 'path:"/this-page"', arrow: '→', result: '0 events' },
  actions: { home: 'Go to the home page', product: 'Product tour', developers: 'Developers' },
} as const;
