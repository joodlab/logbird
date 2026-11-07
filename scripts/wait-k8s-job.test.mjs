import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Create the sandbox before any subprocess. Never inherit kubeconfig, credentials,
// credential-file locations, shell startup hooks or executable search paths.
const scratch = mkdtempSync(join(tmpdir(), 'logbird-wait-job-'));
const home = join(scratch, 'home');
const bin = join(scratch, 'bin');
const missingBin = join(scratch, 'missing-bin');
for (const directory of [home, bin, missingBin]) mkdirSync(directory);
const kubeconfig = join(scratch, 'empty-kubeconfig');
writeFileSync(kubeconfig, '');
const helper = fileURLToPath(new URL('./wait-k8s-job.sh', import.meta.url));
const shell = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/sh.exe') : '/bin/sh';
const shellPath = (value) => value.replaceAll('\\', '/');
const searchPath = (value) =>
  process.platform === 'win32' ? shellPath(value).replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;

function sandboxEnv(inherited, mode, executableDirectory) {
  // An allowlist removes every cloud/provider variable, including unknown future
  // names. HOME also prevents fallback to on-disk AWS/GCP/Azure/Kubernetes profiles.
  return {
    ...(inherited.SystemRoot ? { SystemRoot: inherited.SystemRoot } : {}),
    ...(inherited.WINDIR ? { WINDIR: inherited.WINDIR } : {}),
    HOME: shellPath(home),
    USERPROFILE: shellPath(home),
    XDG_CONFIG_HOME: shellPath(home),
    KUBECONFIG: shellPath(kubeconfig),
    TMP: shellPath(scratch),
    TEMP: shellPath(scratch),
    PATH: searchPath(executableDirectory),
    QA_JOB_MODE: mode,
  };
}

writeFileSync(
  join(bin, 'kubectl'),
  [
    '#!/bin/sh',
    'set -eu',
    '[ -f "$KUBECONFIG" ] && [ ! -s "$KUBECONFIG" ]',
    '[ "$HOME" = "$USERPROFILE" ] && [ "$HOME" = "$XDG_CONFIG_HOME" ]',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion in the shell stub.
    '[ "${AWS_PROFILE+x}${AWS_ACCESS_KEY_ID+x}${GOOGLE_APPLICATION_CREDENTIALS+x}${AZURE_CONFIG_DIR+x}${HCLOUD_TOKEN+x}${NODE_OPTIONS+x}${BASH_ENV+x}" = "" ]',
    "printf '%s\\n' 'sandbox-guard-ok' >&2",
    'case "$QA_JOB_MODE" in',
    "  complete) printf '%s\\n' 'Complete=True' ;;",
    "  failed) printf '%s\\n' 'Failed=True' ;;",
    '  api-error) exit 7 ;;',
    '  *) exit 90 ;;',
    'esac',
    '',
  ].join('\n'),
  { mode: 0o700 },
);

function run(mode, executableDirectory = bin) {
  const env = sandboxEnv(process.env, mode, executableDirectory);
  // Recheck the safety boundary immediately before every subprocess, including
  // the deliberately missing-stub case. No real kubectl is ever invoked.
  assert.equal(readFileSync(env.KUBECONFIG, 'utf8'), '');
  assert.equal(env.HOME, shellPath(home));
  assert.equal(env.PATH, searchPath(executableDirectory));
  assert.deepEqual(
    Object.keys(env).filter((key) => /^(AWS|AZURE|GOOGLE|GCLOUD|CLOUDSDK|HCLOUD|KUBE(?!CONFIG$)|HELM|DOCKER|SSH_)/i.test(key)),
    [],
  );
  return spawnSync(shell, [shellPath(helper), 'logbird-migrate-qa'], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });
}

after(() => {
  assert.equal(dirname(resolve(scratch)), resolve(tmpdir()));
  assert.ok(basename(scratch).startsWith('logbird-wait-job-'));
  rmSync(scratch, { recursive: true, force: true });
});

test('sandbox drops inherited provider credentials, config paths and startup hooks', () => {
  const env = sandboxEnv(
    {
      AWS_PROFILE: 'fictional',
      HCLOUD_TOKEN: 'fictional',
      GOOGLE_APPLICATION_CREDENTIALS: '/fictional',
      NODE_OPTIONS: '--fictional',
      BASH_ENV: '/fictional',
      PATH: '/host',
      KUBECONFIG: '/host',
    },
    'complete',
    bin,
  );
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'KUBECONFIG', 'PATH', 'QA_JOB_MODE', 'TEMP', 'TMP', 'USERPROFILE', 'XDG_CONFIG_HOME'].sort());
  assert.equal(env.KUBECONFIG, shellPath(kubeconfig));
  assert.equal(statSync(kubeconfig).size, 0);
  assert.deepEqual(
    Object.keys(sandboxEnv(process.env, 'complete', bin)).filter(
      (key) => !['SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'KUBECONFIG', 'TMP', 'TEMP', 'PATH', 'QA_JOB_MODE'].includes(key),
    ),
    [],
  );
});

for (const [mode, status] of [
  ['complete', 0],
  ['failed', 1],
  ['api-error', 7],
]) {
  test(`wait helper: ${mode}`, () => {
    const result = run(mode);
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stderr, /sandbox-guard-ok/);
  });
}

test('a missed kubectl stub fails closed without searching the host PATH', () => {
  const result = run('complete', missingBin);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 127, result.stderr);
  assert.match(result.stderr, /kubectl: (?:command )?not found/);
  assert.doesNotMatch(result.stderr, /sandbox-guard-ok/);
});
