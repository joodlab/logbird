// Run one Vitest process per file and record its verdict; size available resources before execution.
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const option = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--pnpm') || !process.argv.includes('--output'))
  throw new Error('Usage: node scripts/test-server-files.mjs --pnpm <pinned pnpm.cjs> --output <evidence directory>');
const pnpm = path.resolve(option('--pnpm'));
const output = path.resolve(option('--output'));
mkdirSync(output, { recursive: true });
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const head = revision();
const files = execFileSync('rg', ['--files', 'apps/server/src', '-g', '*test.ts'], { encoding: 'utf8' }).trim().split(/\r?\n/).sort();
const verdicts = [];
for (const file of files) {
  if (revision() !== head) throw new Error('HEAD changed during verification');
  const name = path.basename(file);
  const report = path.join(output, `${name}.json`);
  const out = openSync(path.join(output, `${name}.out.log`), 'w');
  const err = openSync(path.join(output, `${name}.err.log`), 'w');
  const startedAt = new Date().toISOString();
  let run;
  try {
    run = spawnSync(
      process.execPath,
      [
        pnpm,
        '--filter',
        '@logbird/server',
        'exec',
        'dotenv',
        '-e',
        '../../.env',
        '--',
        'vitest',
        'run',
        file.replaceAll('\\', '/').replace('apps/server/', ''),
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      {
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, LOGBIRD_EXPORT_PROOF_DIR: output, INGEST_FIXTURE_LEDGER: path.join(output, 'immutable-fixtures.jsonl') },
      },
    );
  } finally {
    closeSync(out);
    closeSync(err);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(report, 'utf8'));
  } catch {
    /* A startup failure has no Vitest report. */
  }
  const verdict = {
    file,
    revision: head,
    startedAt,
    finishedAt: new Date().toISOString(),
    exit: run.status,
    passed: result?.numPassedTests ?? 0,
    failed: result?.numFailedTests ?? 0,
    skipped: result?.numPendingTests ?? 0,
    success: run.status === 0 && result?.success === true,
  };
  verdicts.push(verdict);
  writeFileSync(path.join(output, 'verdicts.json'), `${JSON.stringify({ revision: head, verdicts }, null, 2)}\n`);
  console.log(`${name}: ${verdict.success ? 'PASS' : 'FAIL'} (${verdict.passed} passed / ${verdict.skipped} skipped)`);
}
if (revision() !== head) throw new Error('HEAD changed during verification');
if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'apps', 'packages']).status !== 0) throw new Error('Source changed during verification');
console.log(
  JSON.stringify({
    revision: head,
    files: verdicts.length,
    passed: verdicts.reduce((n, v) => n + v.passed, 0),
    skipped: verdicts.reduce((n, v) => n + v.skipped, 0),
    failedFiles: verdicts.filter((v) => !v.success).map((v) => v.file),
  }),
);
if (verdicts.some((v) => !v.success)) process.exitCode = 1;
