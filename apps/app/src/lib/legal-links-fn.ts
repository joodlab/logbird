import { createServerFn } from '@tanstack/react-start';
import { legalLinksFrom } from './legal-links';

/**
 * The console renders in the browser (start.ts), so its runtime settings reach the page through this server function:
 * the console server reads its own environment, the same way server/proxy.ts reads LOGBIRD_SITE_URL.
 */
export const getLegalLinks = createServerFn({ method: 'GET' }).handler(() => legalLinksFrom(process.env));
