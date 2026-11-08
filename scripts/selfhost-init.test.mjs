// node --test scripts/selfhost-init.test.mjs (also part of `pnpm test`)
// selfhost-init.sh warns about the old, unverified Docker Hub image namespace and never rewrites that setting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'logbird-selfhost-init-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const script = fileURLToPath(new URL('./selfhost-init.sh', import.meta.url)).replaceAll('\\', '/');
const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || '<local-path>Program Files', 'Git/bin/sh.exe') : '/bin/sh';

// All four secrets are already populated, so the script's secret-fill loop never rewrites the file: the legacy check
// reads the CRLF line endings exactly as written, and the file must come back byte-for-byte unchanged.
const secrets = ['BETTER_AUTH_SECRET', 'POSTGRES_PASSWORD', 'CLICKHOUSE_PASSWORD', 'CLICKHOUSE_QUERY_PASSWORD']
  .map((key) => `${key}=fixture-${key.toLowerCase()}-kept`)
  .join('\r\n');

function init(registryLine) {
  const envFile = join(scratch, `env-${Math.random().toString(16).slice(2)}`);
  const original = `${registryLine}\r\n${secrets}\r\n`;
  writeFileSync(envFile, original);
  const result = spawnSync(shell, [script, envFile.replaceAll('\\', '/')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(envFile, 'utf8'), original, 'file unchanged, CRLF included');
  return /old unverified Docker Hub namespace/.test(result.stderr);
}

const legacy = [
  'LOGBIRD_IMAGE_REGISTRY=logbird',
  'LOGBIRD_IMAGE_REGISTRY="logbird"',
  "LOGBIRD_IMAGE_REGISTRY='logbird'   # quoted with a comment",
  'LOGBIRD_IMAGE_REGISTRY= logbird ',
  'LOGBIRD_IMAGE_REGISTRY=logbird # old default',
  'LOGBIRD_IMAGE_REGISTRY=docker.io/logbird',
  'LOGBIRD_IMAGE_REGISTRY=Docker.IO/logbird/',
  'LOGBIRD_IMAGE_REGISTRY=index.docker.io/logbird',
];
const current = [
  'LOGBIRD_IMAGE_REGISTRY=',
  'LOGBIRD_IMAGE_REGISTRY=ghcr.io/joodlab',
  'LOGBIRD_IMAGE_REGISTRY=logbird-mirror',
  'LOGBIRD_IMAGE_REGISTRY=registry.example.test/logbird',
  'LOGBIRD_IMAGE_REGISTRY=docker.io/logbirdx',
  '# LOGBIRD_IMAGE_REGISTRY=logbird',
];

for (const line of legacy)
  test(`warns on a CRLF file without rewriting it: ${line}`, () => {
    assert.equal(init(line), true);
  });

for (const line of current)
  test(`stays quiet: ${line || '(empty)'}`, () => {
    assert.equal(init(line), false);
  });

test('the check itself handles CRLF (not only the secret-fill rewrite)', () => {
  // This fixture is never rewritten, so the check reads `logbird\r`. On Linux (/bin/sh + awk/BusyBox awk) the awk's own
  // `\r` strip is what makes it match: without it this test fails there (verified 2026-11-08 in an Alpine container).
  // Git Bash's gawk on Windows already drops CR in text mode, so on Windows this asserts the end-to-end behaviour.
  assert.equal(init('LOGBIRD_IMAGE_REGISTRY=logbird'), true);
  assert.ok(secrets.includes('\r\n'));
});
