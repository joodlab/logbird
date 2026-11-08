// node --test scripts/selfhost-init.test.mjs
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
const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/sh.exe') : '/bin/sh';

function init(registryLine) {
  const envFile = join(scratch, `env-${Math.random().toString(16).slice(2)}`);
  writeFileSync(envFile, `${registryLine}\r\nBETTER_AUTH_SECRET=fixture-secret-kept\n`);
  const result = spawnSync(shell, [script, envFile.replaceAll('\\', '/')], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  return { warned: /old unverified Docker Hub namespace/.test(result.stderr), content: readFileSync(envFile, 'utf8') };
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
  test(`warns without rewriting: ${line}`, () => {
    const { warned, content } = init(line);
    assert.ok(warned);
    assert.ok(content.includes(line), 'registry line preserved');
    assert.ok(content.includes('BETTER_AUTH_SECRET=fixture-secret-kept'), 'existing secret preserved');
  });

for (const line of current)
  test(`stays quiet: ${line || '(empty)'}`, () => {
    assert.equal(init(line).warned, false);
  });
