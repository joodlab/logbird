import type { Cta } from './site';

/**
 * How scoped read access is enforced, in one place: the landing page shows `scope` with a link to /security § Scoped
 * reads, which shows all three sentences, and the customer-facing audit logs page shows them too, so none can drift.
 * Sources: docs/scoped-read-access.md (§ The scope, § Browser use (CORS)), docs/security.md § Two enforcement layers,
 * CHANGELOG.md 0.2.0 ("Restricted query user"). Brief: marketing/copy/security.md § scoped-reads.
 */
export const scopedReadLimits = {
  scope: 'One customer account per scope, matched on the id Logbird stored.',
  layers:
    "Logbird's query builders always apply the scope. ClickHouse checks the customer account as well once the restricted query user has its tenant row policy: the Compose and Coolify stacks install it on upgrade, and a source installation runs `create-query-user` once.",
  origins: 'A web page on another origin can read with a token only if that origin is listed on the key.',
  /** The landing page's link to the full text. */
  enforced: { label: 'How it is enforced', to: '/security', hash: 'scoped-reads' } satisfies Cta,
} as const;

/** All three sentences, in order, for pages that show the whole limit. */
export const scopedReadLimitText = [scopedReadLimits.scope, scopedReadLimits.layers, scopedReadLimits.origins].join(' ');
