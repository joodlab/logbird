/**
 * The form's stored values, in the order the form lists them. Dependency-free on purpose: the form imports them into
 * the browser, and lib/waitlist-schema.ts (which builds the Zod schema the server validates with) imports them too, so
 * Zod stays out of the page's chunk. The labels live in content/waitlist-form.ts.
 */
export const INTERESTS = ['cloud', 'self-host', 'updates', 'correction', 'other', 'privacy'] as const;
/** Optional qualifying answers. */
export const VOLUMES = ['unsure', 'under-100k', '100k-1m', '1m-10m', 'over-10m'] as const;
export const NEEDS = ['customer-audit-log', 'compliance', 'investigations', 'self-host-support', 'other'] as const;
