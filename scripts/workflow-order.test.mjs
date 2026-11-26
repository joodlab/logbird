import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';
import { checkoutOrderViolations, producesFiles, workflowFiles, workflowJobs } from './workflow-order.mjs';

const job = (steps) => `name: t\non: push\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;

// The images job of the v0.4.0 release.yml: the digests were downloaded, then a sparse checkout deleted them.
const v040Images = job(`      - uses: actions/download-artifact@v8
        with:
          pattern: digest-server-*
          path: digests
          merge-multiple: true
      - uses: actions/checkout@v7
        with:
          sparse-checkout: scripts/release-aliases.mjs
      - name: Publish
        run: cat digests/amd64.txt
`);

test('every repository workflow runs each checkout before any step that downloads or writes files', () => {
  const files = workflowFiles();
  assert.ok(files.some((file) => basename(file) === 'release.yml'));
  for (const file of files) assert.deepEqual(checkoutOrderViolations(readFileSync(file, 'utf8'), file), []);
});

test('the parser finds every job of release.yml with its steps', () => {
  const jobs = workflowJobs(
    readFileSync(
      workflowFiles().find((file) => basename(file) === 'release.yml'),
      'utf8',
    ),
  );
  assert.deepEqual(
    jobs.map((j) => j.id),
    ['preflight', 'npm', 'build', 'images', 'release', 'aliases', 'nuget', 'npm-publish'],
  );
  for (const j of jobs) assert.ok(j.reusable || j.steps.length > 0, `${j.id} has steps`);
  const images = jobs.find((j) => j.id === 'images');
  assert.match(images.steps[0], /actions\/checkout@/);
});

test('refuses a checkout after a download, as in the v0.4.0 images job', () => {
  const [violation] = checkoutOrderViolations(v040Images, 'release.yml');
  assert.match(violation, /job publish: step 2 \(actions\/checkout\) runs after step 1, which downloads artifacts/);
});

test('accepts the same steps with the checkout first', () => {
  const fixed = job(`      - uses: actions/checkout@v7
      - uses: actions/download-artifact@v8
        with:
          path: digests
      - run: cat digests/amd64.txt
`);
  assert.deepEqual(checkoutOrderViolations(fixed), []);
});

test('refuses a checkout after a run step that writes into the workspace', () => {
  const steps = job(`      - run: echo ok > state.txt
      - uses: actions/checkout@v7
`);
  assert.equal(checkoutOrderViolations(steps).length, 1);
  assert.equal(producesFiles('      - run: mkdir -p out'), 'creates files');
  assert.equal(producesFiles('      - run: gh release download v1.2.3 --dir released'), 'creates files');
});

test('allows step outputs, the summary, /dev/null and the runner temp folder before a checkout', () => {
  const steps = job(`      - name: Gate
        run: |
          echo "publish=false" >> "$GITHUB_OUTPUT"
          echo note >> $GITHUB_STEP_SUMMARY
          command -v jq > /dev/null 2>&1
          echo x > "$RUNNER_TEMP/scratch"
      - uses: actions/checkout@v7
`);
  assert.deepEqual(checkoutOrderViolations(steps), []);
});

test('skips reusable-workflow jobs and refuses a job whose steps it cannot read', () => {
  const reusable = 'jobs:\n  npm:\n    uses: ./.github/workflows/npm-tarballs.yml\n';
  assert.deepEqual(checkoutOrderViolations(reusable), []);
  const unreadable = 'jobs:\n  odd:\n    runs-on: ubuntu-latest\n    steps: [{uses: actions/checkout@v7}]\n';
  assert.match(checkoutOrderViolations(unreadable)[0], /no steps found/);
});

test('reads past column-0 comments between jobs and quoted job ids and uses values', () => {
  const text = `on: push
jobs:
  first:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
# A comment between jobs.

  'second':
    runs-on: ubuntu-latest
    steps:
      - uses: "actions/download-artifact@v8"
        with:
          path: digests
      # A comment inside the steps.
      - uses: 'actions/checkout@v7'
`;
  assert.deepEqual(
    workflowJobs(text).map((j) => j.id),
    ['first', 'second'],
  );
  assert.equal(checkoutOrderViolations(text).length, 1);
});

test('refuses a workflow in which it finds no jobs', () => {
  assert.match(checkoutOrderViolations('on: push\njobs: {}\n')[0], /no jobs found/);
});

test('npm publishing follows the Release and has only OIDC and read permissions', () => {
  const workflow = readFileSync(
    workflowFiles().find((file) => basename(file) === 'release.yml'),
    'utf8',
  ).replaceAll('\r', '');
  const publish = workflow.match(/^ {2}npm-publish:\n(?:^ {4}.*\n)+/m)?.[0];
  assert.ok(publish);
  assert.match(publish, /^ {4}needs: \[preflight, release, aliases\]$/m);
  assert.match(publish, /^ {4}if: vars\.NPM_PUBLISH_ENABLED == 'true'$/m);
  assert.match(publish, /^ {4}permissions:\n {6}contents: read\n {6}id-token: write\n {4}steps:$/m);
  assert.match(publish, /^ {10}persist-credentials: false$/m);
  assert.doesNotMatch(publish, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|github\.token|\bpack\b/);
  assert.match(publish, /run: node scripts\/npm-publish\.mjs /);
});
