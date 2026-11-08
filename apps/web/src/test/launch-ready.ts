/**
 * Test fixture: the legal pages as they'll be at launch, with counsel-reviewed text and `ready: true`. While they're
 * placeholders the release gate keeps the whole site noindex (release.ts), so tests that exercise an indexable site
 * mark them ready first. Everything that reads `ready` does so when called (release gate, publishedPages(), sitemap,
 * llms.txt, page heads), so the flip has the same effect as the launch edit. It imports site-map dynamically, so it
 * patches the same module instance as the test's own imports, including after vi.resetModules(). Returns an undo for
 * afterAll/afterEach.
 */
export async function legalPagesReady(): Promise<() => void> {
  const { getPage } = await import('../lib/site-map');
  const { LEGAL_PAGES } = await import('../lib/release');
  const pages = LEGAL_PAGES.map((path) => getPage(path));
  const before = pages.map((page) => page.ready);
  for (const page of pages) {
    page.ready = true;
  }
  return () => {
    pages.forEach((page, index) => {
      page.ready = before[index] ?? false;
    });
  };
}

/** A fictional released configuration, passed explicitly so tests don't depend on the machine's environment. */
export const RELEASED_ENV = {
  WEB_SITE_URL: 'https://site.example.test',
  WEB_SECURITY_EMAIL: 'security@example.test',
  WEB_CONTACT_EMAIL: 'hello@example.test',
} as const;
