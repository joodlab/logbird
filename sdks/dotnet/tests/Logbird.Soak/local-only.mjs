// Refuses (exit 1) unless every service URL the fixture script and the server would use points at this machine.
// Run it in the same environment as the fixture commands, for example:
//   pnpm exec dotenv -o -e .env -- node sdks/dotnet/tests/Logbird.Soak/local-only.mjs && pnpm exec dotenv -o -e .env -- ...
// It prints only host names, never credentials.
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const failures = [];
for (const name of ['DATABASE_URL', 'CLICKHOUSE_URL', 'REDIS_URL']) {
  const value = process.env[name];
  if (!value) {
    failures.push(`${name} is not set`);
    continue;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    failures.push(`${name} is not a URL`);
    continue;
  }

  // An empty host lets a driver fall back to its own environment (PGHOST); the Postgres driver also takes host and
  // hostaddr from the query string, overriding the URL's host. Every one of them must be this machine.
  const hosts = [url.hostname];
  for (const key of ['host', 'hostaddr']) {
    for (const entry of url.searchParams.getAll(key)) hosts.push(...entry.split(','));
  }

  for (const host of hosts) {
    if (!loopback.has(host.trim())) failures.push(`${name} points at ${host.trim() || 'an empty host'}, not this machine`);
  }
}

if (failures.length) {
  console.error(`refusing: ${failures.join('; ')}`);
  process.exit(1);
}

console.log('local-only: DATABASE_URL, CLICKHOUSE_URL and REDIS_URL all point at this machine');
