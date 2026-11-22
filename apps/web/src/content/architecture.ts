/**
 * Architecture at a glance, the README's mermaid diagram as accessible HTML (components/marketing/steps.tsx), shown on
 * /self-hosting. Source: README.md § Architecture; docs/SPEC.md §2 and §4.
 */
export const architecture = {
  flow: [
    { name: 'Your product', role: 'SDK or HTTP, ingest key' },
    { name: 'Logbird API', role: 'Validates each event; its 202 lists the ones stored' },
    { name: 'ClickHouse', role: 'Events, rollups, entity pages' },
    { name: 'Console and read API', role: 'Your team, and your own backend' },
  ],
  /** Each detail continues its name, so it starts with its own separator. */
  stores: [
    { name: 'Postgres', role: ' · workspaces, projects, members, hashed keys' },
    { name: 'Retention worker', role: ' · deletes expired events every hour, on Redis or Dragonfly' },
  ],
  caption:
    'Your product sends events to the Logbird API, which writes them to ClickHouse. The console and the read API read from ClickHouse. Postgres stores workspaces, projects and hashed keys. A retention worker deletes expired events every hour.',
};
