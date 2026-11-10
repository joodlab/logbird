import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendWaitlistRecord, forgetWaitlistEmail, pruneWaitlist, retentionExpiry } from '../../waitlist/file.mjs';
import { createCloudflareStore, retentionSeconds } from './waitlist-cloudflare';
import { sweepWaitlist } from './waitlist-retention';

const fileModule = pathToFileURL(fileURLToPath(new URL('../../waitlist/file.mjs', import.meta.url))).href;
let dir = '';
let file = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'logbird-waitlist-'));
  file = join(dir, 'waitlist.jsonl');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const record = (email: string, receivedAt: string) => ({ email, interest: 'cloud', receivedAt });
const emails = async () =>
  (await readFile(file, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).email);
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

/** Runs a script in a separate Node process that imports waitlist/file.mjs as `waitlist`. */
function child(body: string) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import * as waitlist from ${JSON.stringify(fileModule)};\n${body}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

it('keeps a submission for whole calendar months, ending on the last day of a shorter month', () => {
  expect(iso(retentionExpiry(at('2024-11-10T12:00:00.000Z'), 24))).toBe('2026-11-10T12:00:00.000Z');
  // Never early: 1 March + 1 month is 1 April, 31 March + 1 month is 30 April.
  expect(iso(retentionExpiry(at('2026-03-01T08:00:00.000Z'), 1))).toBe('2026-04-01T08:00:00.000Z');
  expect(iso(retentionExpiry(at('2026-03-31T23:30:00.000Z'), 1))).toBe('2026-04-30T23:30:00.000Z');
  expect(iso(retentionExpiry(at('2026-01-31T00:00:00.000Z'), 1))).toBe('2026-02-28T00:00:00.000Z');
  expect(iso(retentionExpiry(at('2028-01-31T00:00:00.000Z'), 1))).toBe('2028-02-29T00:00:00.000Z');
  expect(iso(retentionExpiry(at('2024-02-29T10:00:00.000Z'), 24))).toBe('2026-02-28T10:00:00.000Z');
  expect(iso(retentionExpiry(at('2026-12-15T00:00:00.000Z'), 1))).toBe('2027-01-15T00:00:00.000Z');
});

it('deletes submissions whose retention period has ended and keeps the rest, logging counts only', async () => {
  await appendWaitlistRecord(file, record('old@example.test', '2024-11-09T23:59:59.000Z'));
  await appendWaitlistRecord(file, record('ended-now@example.test', '2024-11-10T12:00:00.000Z'));
  await appendWaitlistRecord(file, record('just-inside@example.test', '2024-11-10T12:00:00.001Z'));
  await appendWaitlistRecord(file, record('new@example.test', '2026-11-01T08:00:00.000Z'));
  await writeFile(file, 'not json\n', { flag: 'a' });
  const lines: string[] = [];
  const now = at('2026-11-10T12:00:00.000Z');
  const result = await sweepWaitlist(file, { now, months: 24, log: (line) => lines.push(line) });
  expect(result).toEqual({ kept: 3, removed: 2 });
  // What it can't read, it keeps.
  expect(await readFile(file, 'utf8')).toContain('not json');
  expect(
    (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(0, 2)
      .map((line) => JSON.parse(line).email),
  ).toEqual(['just-inside@example.test', 'new@example.test']);
  expect(lines).toEqual([JSON.stringify({ level: 'info', event: 'waitlist.retention', removed: 2, kept: 3, months: 24 })]);
  if (process.platform !== 'win32') {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  // Nothing to do: the file is left alone and nothing is logged.
  expect(await sweepWaitlist(file, { now, months: 24, log: (line) => lines.push(line) })).toEqual({ kept: 3, removed: 0 });
  expect(lines).toHaveLength(1);
});

it('treats a missing file as empty', async () => {
  expect(await pruneWaitlist(file, Date.now(), 24)).toEqual({ kept: 0, removed: 0 });
});

it('removes a temporary copy left by a crashed rewrite, so a deleted record has no other copy', async () => {
  await appendWaitlistRecord(file, record('forget-me@example.test', '2026-11-01T00:00:00.000Z'));
  const leftover = `${file}.rewrite-crashed`;
  await writeFile(leftover, `${JSON.stringify(record('forget-me@example.test', '2026-11-01T00:00:00.000Z'))}\n`);
  expect(await forgetWaitlistEmail(file, 'forget-me@example.test')).toEqual({ kept: 0, removed: 1 });
  expect(await readdir(dir)).toEqual(['waitlist.jsonl']);
});

it('forgets every submission from one address, ignoring case and spaces', async () => {
  await appendWaitlistRecord(file, record('Someone@Example.test', '2026-11-01T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('other@example.test', '2026-11-02T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('someone@example.test', '2026-11-03T00:00:00.000Z'));
  expect(await forgetWaitlistEmail(file, ' SOMEONE@example.test ')).toEqual({ kept: 1, removed: 2 });
  expect(await emails()).toEqual(['other@example.test']);
  await expect(forgetWaitlistEmail(file, '  ')).rejects.toThrow(/required/);
});

it('never loses a submission another process writes while this one rewrites the file', async () => {
  for (let index = 0; index < 50; index += 1) {
    await appendWaitlistRecord(file, record(`old-${index}@example.test`, '2020-01-01T00:00:00.000Z'));
  }
  // Three other processes append 30 fresh submissions each while this one keeps rewriting the file.
  const writers = [0, 1, 2].map((writer) =>
    child(
      `for (let i = 0; i < 30; i++) await waitlist.appendWaitlistRecord(${JSON.stringify(file)}, { email: 'new-${writer}-' + i + '@example.test', interest: 'cloud', receivedAt: new Date().toISOString() });`,
    ),
  );
  const finished = Promise.all(writers.map((writer) => new Promise((done) => writer.on('exit', done))));
  let rewrites = 0;
  let running = true;
  void finished.then(() => {
    running = false;
  });
  while (running) {
    await pruneWaitlist(file, Date.now(), 24);
    await forgetWaitlistEmail(file, `old-${rewrites}@example.test`);
    rewrites += 1;
  }
  expect(await finished).toEqual([0, 0, 0]);
  await pruneWaitlist(file, Date.now(), 24);
  const fresh = (await emails()).filter((email: string) => email.startsWith('new-'));
  expect(fresh).toHaveLength(90);
  expect(rewrites).toBeGreaterThan(0);
}, 60_000);

it('waits while another process holds the lock, and gets it as soon as that process dies', async () => {
  // The timer keeps the holder busy (the lock itself never keeps a process alive).
  const holder = child(
    `await waitlist.withWaitlistLock(${JSON.stringify(file)}, async () => { setInterval(() => {}, 1000); console.log('held'); await new Promise(() => {}); });`,
  );
  await new Promise<void>((done) => holder.stdout.on('data', (data: Buffer) => data.toString().includes('held') && done()));
  let appended = false;
  const pending = appendWaitlistRecord(file, record('after-crash@example.test', '2026-11-10T00:00:00.000Z')).then(() => {
    appended = true;
  });
  await new Promise((done) => setTimeout(done, 300));
  expect(appended).toBe(false);
  // A crash: no cleanup runs, yet the operating system releases the lock with the process.
  holder.kill('SIGKILL');
  await pending;
  expect(await emails()).toEqual(['after-crash@example.test']);
}, 30_000);

it('never lets two cluster workers hold the lock at once (they must not share one listening handle)', async () => {
  // Workers re-run the primary's script, so the program must be a file rather than `node -e`.
  const script = join(dir, 'cluster.mjs');
  await writeFile(
    script,
    `import * as waitlist from ${JSON.stringify(fileModule)};
    import cluster from 'node:cluster';
    const file = ${JSON.stringify(file)};
    if (cluster.isPrimary) {
      const spans = [];
      for (let i = 0; i < 2; i++) cluster.fork().on('message', (span) => spans.push(span));
      let exited = 0;
      cluster.on('exit', () => { if (++exited === 2) console.log(JSON.stringify(spans)); });
    } else {
      for (let round = 0; round < 3; round++) {
        await waitlist.withWaitlistLock(file, async () => {
          const start = Date.now();
          await new Promise((done) => setTimeout(done, 150));
          process.send({ start, end: Date.now() });
        });
      }
      process.disconnect();
    }`,
  );
  const program = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  program.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  await new Promise((done) => program.on('exit', done));
  const spans = (JSON.parse(output) as { start: number; end: number }[]).sort((a, b) => a.start - b.start);
  expect(spans).toHaveLength(6);
  for (let index = 1; index < spans.length; index += 1) {
    expect(spans[index]?.start).toBeGreaterThanOrEqual(spans[index - 1]?.end ?? Number.POSITIVE_INFINITY);
  }
}, 60_000);

it('the admin script deletes one address and prints counts only', async () => {
  await appendWaitlistRecord(file, record('forget-me@example.test', '2026-11-01T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('keep-me@example.test', '2026-11-02T00:00:00.000Z'));
  const admin = fileURLToPath(new URL('../../waitlist/admin.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [admin, 'forget', 'Forget-Me@example.test'], {
    env: { ...process.env, WAITLIST_FILE: file },
  });
  expect(stdout).toContain('Removed 1 submission(s)');
  expect(stdout).not.toContain('keep-me');
  expect(await emails()).toEqual(['keep-me@example.test']);
  await expect(promisify(execFile)(process.execPath, [admin, 'forget'], { env: { ...process.env, WAITLIST_FILE: file } })).rejects.toMatchObject({
    code: 2,
  });
});

it('the Cloudflare store gives each record the same lifetime as a KV expiry', async () => {
  const receivedAt = '2026-03-31T12:00:00.000Z';
  expect(retentionSeconds(at(receivedAt), 1)).toBe((at('2026-04-30T12:00:00.000Z') - at(receivedAt)) / 1000);
  const put = vi.fn(async () => undefined);
  await createCloudflareStore({ WAITLIST_KV: { put } }, 24)({ email: 'kv@example.test', interest: 'cloud', receivedAt });
  expect(put).toHaveBeenCalledWith(expect.stringMatching(/^waitlist:2026-03-31T12:00:00\.000Z:/), expect.any(String), {
    expirationTtl: retentionSeconds(at(receivedAt), 24),
  });
});
