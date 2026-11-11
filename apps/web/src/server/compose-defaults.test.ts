import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * `NAME: ${NAME:-default}` entries of a Compose file, keyed by name (only those whose prefix matches). A name set twice
 * (say by two services) must default the same way both times, or the parity check below could pass on one of them.
 */
function composeDefaults(file: string, prefix: string) {
  const text = readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8');
  const pairs = [...text.matchAll(/^\s+(\w+): \$\{(\w+):-([^}]*)\}\s*$/gm)].filter(([, name, source]) => name === source && name?.startsWith(prefix));
  const defaults: Record<string, string> = {};
  for (const [, name = '', , fallback = ''] of pairs) {
    if (name in defaults && defaults[name] !== fallback) {
      throw new Error(`${file} defaults ${name} to both "${defaults[name]}" and "${fallback}"`);
    }
    defaults[name] = fallback;
  }
  return defaults;
}

it('the hosted site defaults SMTP like the console, never to the Mailpit port', () => {
  const site = composeDefaults('docker-compose.site.yml', 'SMTP_');
  // An operator who leaves SMTP_PORT empty (the console's Compose allows it) must not get env.ts's local-dev 1025.
  expect(site.SMTP_PORT).toBe('587');
  for (const consoleFile of ['docker-compose.yml', 'docker-compose.coolify.yml']) {
    expect(site, consoleFile).toEqual(composeDefaults(consoleFile, 'SMTP_'));
  }
});
