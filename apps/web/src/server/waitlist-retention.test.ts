import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  appendWaitlistRecord,
  forgetWaitlistEmail,
  pruneWaitlist,
  resolveWaitlistPath,
  retentionExpiry,
  waitlistDays,
} from '../../waitlist/file.mjs';
import { createCloudflareStore, retentionDeadline } from './waitlist-cloudflare';
import { scheduleWaitlistRetention, sweepWaitlist } from './waitlist-retention';

const fileModule = pathToFileURL(fileURLToPath(new URL('../../waitlist/file.mjs', import.meta.url))).href;
let dir = '';
let file = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'logbird-waitlist-'));
  file = join(dir, 'waitlist.jsonl');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const record = (email: string, receivedAt: string) => ({ email, interest: 'cloud', receivedAt });
const lines = async (path: string) =>
  (await readFile(path, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
/** Every stored email, day files in date order, then the legacy file. */
async function emails(store = file) {
  const days = (await readdir(waitlistDays(store)).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort();
  const all: { email: string }[] = [];
  for (const day of days) {
    all.push(...(await lines(join(waitlistDays(store), day))));
  }
  all.push(...(await lines(store)));
  return all.map((entry) => entry.email);
}
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

it('stores each submission in the file for its UTC day of receipt, mode 600', async () => {
  await appendWaitlistRecord(file, record('a@example.test', '2026-11-10T23:59:59.999Z'));
  await appendWaitlistRecord(file, record('b@example.test', '2026-11-11T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('c@example.test', '2026-11-11T09:00:00.000Z'));
  expect((await readdir(waitlistDays(file))).sort()).toEqual(['2026-11-10.jsonl', '2026-11-11.jsonl']);
  expect((await lines(join(waitlistDays(file), '2026-11-11.jsonl'))).map((entry) => entry.email)).toEqual(['b@example.test', 'c@example.test']);
  if (process.platform !== 'win32') {
    expect((await stat(join(waitlistDays(file), '2026-11-11.jsonl'))).mode & 0o777).toBe(0o600);
  }
});

it('deletes a day file once its last moment is past the period, and trims the legacy file record by record', async () => {
  const now = at('2026-11-10T12:00:00.000Z');
  // Day files: 9 November 2024 ended before now minus 24 months; 10 November 2024 has not ended yet.
  await appendWaitlistRecord(file, record('day-old-1@example.test', '2024-11-09T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('day-old-2@example.test', '2024-11-09T23:59:59.000Z'));
  await writeFile(join(waitlistDays(file), '2024-11-09.jsonl'), 'torn line\n', { flag: 'a' });
  await appendWaitlistRecord(file, record('day-edge@example.test', '2024-11-10T00:00:01.000Z'));
  await appendWaitlistRecord(file, record('day-new@example.test', '2026-11-01T08:00:00.000Z'));
  // The legacy file from before day files: trimmed per record; a line it can't read is kept and reported.
  await writeFile(
    file,
    [
      JSON.stringify(record('legacy-old@example.test', '2024-11-09T23:59:59.000Z')),
      JSON.stringify(record('legacy-ended-now@example.test', '2024-11-10T12:00:00.000Z')),
      JSON.stringify(record('legacy-inside@example.test', '2024-11-10T12:00:00.001Z')),
      'not json',
      '',
    ].join('\n'),
  );
  const logged: string[] = [];
  const result = await sweepWaitlist(file, { now, months: 24, log: (line) => logged.push(line) });
  // Removed: the whole 9 November file (3 lines, the torn one included) and two legacy records.
  expect(result).toEqual({ kept: 4, removed: 5, unreadable: 1 });
  expect((await readdir(waitlistDays(file))).sort()).toEqual(['2024-11-10.jsonl', '2026-11-01.jsonl']);
  const legacy = await readFile(file, 'utf8');
  expect(legacy).toContain('not json');
  expect(legacy).toContain('legacy-inside@example.test');
  expect(legacy).not.toMatch(/legacy-old|legacy-ended-now/);
  expect(logged).toEqual([JSON.stringify({ level: 'warn', event: 'waitlist.retention', removed: 5, kept: 4, unreadable: 1, months: 24 })]);
  expect(logged.join('')).not.toContain('@');
  if (process.platform !== 'win32') {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  // With nothing to delete and nothing unreadable, nothing is logged.
  await writeFile(file, (await readFile(file, 'utf8')).replace('not json\n', ''));
  expect(await sweepWaitlist(file, { now, months: 24, log: (line) => logged.push(line) })).toEqual({ kept: 3, removed: 0, unreadable: 0 });
  expect(logged).toHaveLength(1);
});

it('never deletes a day file early, and deletes it within a day of its last submission expiring', async () => {
  await appendWaitlistRecord(file, record('late@example.test', '2026-03-31T23:30:00.000Z'));
  // The day's last moment plus one month is 30 April, 23:59:59.999.
  expect((await pruneWaitlist(file, at('2026-04-30T23:59:59.998Z'), 1)).removed).toBe(0);
  expect((await pruneWaitlist(file, at('2026-04-30T23:59:59.999Z'), 1)).removed).toBe(1);
});

it('treats a missing store as empty', async () => {
  expect(await pruneWaitlist(file, Date.now(), 24)).toEqual({ kept: 0, removed: 0, unreadable: 0 });
  expect(await forgetWaitlistEmail(file, 'nobody@example.test')).toEqual({ kept: 0, removed: 0, unreadable: 0 });
});

it('waits before the first cleanup, then sweeps', async () => {
  await appendWaitlistRecord(file, record('old@example.test', '2020-01-01T00:00:00.000Z'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const stop = scheduleWaitlistRetention(file, { firstAfterMs: 300 });
  await new Promise((done) => setTimeout(done, 100));
  expect(await emails()).toEqual(['old@example.test']);
  await vi.waitFor(async () => expect(await emails()).toEqual([]), { timeout: 5000 });
  stop();
  log.mockRestore();
});

it('removes temporary copies left by a crashed rewrite, so a deleted record has no other copy', async () => {
  await appendWaitlistRecord(file, record('forget-me@example.test', '2026-11-01T00:00:00.000Z'));
  const copy = `${JSON.stringify(record('forget-me@example.test', '2026-11-01T00:00:00.000Z'))}\n`;
  await writeFile(join(waitlistDays(file), '2026-11-01.jsonl.rewrite-crashed'), copy);
  await writeFile(`${file}.rewrite-crashed`, copy);
  expect(await forgetWaitlistEmail(file, 'forget-me@example.test')).toMatchObject({ removed: 1 });
  expect(await readdir(waitlistDays(file))).toEqual(['2026-11-01.jsonl']);
  expect((await readdir(dir)).sort()).toEqual(['waitlist.jsonl.d']);
});

it('forgets every submission from one address in every day file and the legacy file, ignoring case and spaces', async () => {
  await appendWaitlistRecord(file, record('Someone@Example.test', '2026-11-01T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('other@example.test', '2026-11-02T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('someone@example.test', '2026-11-03T00:00:00.000Z'));
  await writeFile(file, `${JSON.stringify(record('SOMEONE@example.test', '2025-01-01T00:00:00.000Z'))}\n`);
  expect(await forgetWaitlistEmail(file, ' SOMEONE@example.test ')).toEqual({ kept: 1, removed: 3, unreadable: 0 });
  expect(await emails()).toEqual(['other@example.test']);
  await expect(forgetWaitlistEmail(file, '  ')).rejects.toThrow(/required/);
});

it('works on the real store behind a symlinked WAITLIST_FILE, and keeps the symlink', async (context) => {
  const target = join(dir, 'real', 'waitlist.jsonl');
  const link = join(dir, 'link.jsonl');
  await mkdir(join(dir, 'real'));
  await writeFile(target, `${JSON.stringify(record('legacy@example.test', '2026-10-01T00:00:00.000Z'))}\n`);
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    // Windows allows file symlinks only with Developer Mode or elevation.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip();
    }
    throw error;
  }
  await appendWaitlistRecord(link, record('forget-me@example.test', '2026-11-01T00:00:00.000Z'));
  await appendWaitlistRecord(target, record('keep-me@example.test', '2026-11-02T00:00:00.000Z'));
  // Both paths reach one store: the day files sit next to the real file.
  expect(await readdir(waitlistDays(target))).toEqual(['2026-11-01.jsonl', '2026-11-02.jsonl']);
  expect(await forgetWaitlistEmail(link, 'legacy@example.test')).toMatchObject({ removed: 1 });
  expect(await forgetWaitlistEmail(link, 'forget-me@example.test')).toMatchObject({ removed: 1 });
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect(await emails(target)).toEqual(['keep-me@example.test']);
});

it('resolves every alias of a store to one path, before and after its directory exists', async (context) => {
  const real = join(dir, 'real');
  const alias = join(dir, 'alias');
  await mkdir(real);
  // A directory junction needs no privileges on Windows; elsewhere the type is ignored.
  await symlink(real, alias, 'junction');
  const viaAlias = join(alias, 'new', 'waitlist.jsonl');
  const viaReal = join(real, 'new', 'waitlist.jsonl');
  const expected = await resolveWaitlistPath(viaReal);
  expect(await resolveWaitlistPath(viaAlias)).toBe(expected);
  await mkdir(join(real, 'new'));
  expect(await resolveWaitlistPath(viaAlias)).toBe(expected);
  await writeFile(viaReal, '');
  expect(await resolveWaitlistPath(viaAlias)).toBe(expected);
  // A chain of dangling symlinks resolves to the file it will create.
  const end = join(real, 'later', 'waitlist.jsonl');
  try {
    await symlink(end, join(dir, 'second.jsonl'), 'file');
    await symlink(join(dir, 'second.jsonl'), join(dir, 'first.jsonl'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip();
    }
    throw error;
  }
  expect(await resolveWaitlistPath(join(dir, 'first.jsonl'))).toBe(await resolveWaitlistPath(end));
});

/**
 * Starts writer processes that each append 30 records (stamped now, so all into today's file) once a go-file appears,
 * and meanwhile keeps rewriting today's file for real through `rewriteVia`: adds a record and forgets it again, so
 * every pass renames a new file into place. Returns how many real rewrites ran while the writers were writing.
 */
async function rewriteWhileOthersAppend(paths: string[], rewriteVia: string) {
  const go = join(dir, 'go');
  const writers = paths.map((path, writer) =>
    child(
      `const { existsSync } = await import('node:fs');
       console.log('ready');
       while (!existsSync(${JSON.stringify(go)})) await new Promise((done) => setTimeout(done, 5));
       for (let i = 0; i < 30; i++) await waitlist.appendWaitlistRecord(${JSON.stringify(path)}, { email: 'new-${writer}-' + i + '@example.test', interest: 'cloud', receivedAt: new Date().toISOString() });`,
    ),
  );
  await Promise.all(writers.map((writer) => new Promise<void>((done) => writer.stdout.once('data', () => done()))));
  const finished = Promise.all(writers.map((writer) => new Promise((done) => writer.on('exit', done))));
  let running = true;
  void finished.then(() => {
    running = false;
  });
  await writeFile(go, '');
  let rewrites = 0;
  for (let pass = 0; running; pass += 1) {
    await appendWaitlistRecord(rewriteVia, record(`victim-${pass}@example.test`, new Date().toISOString()));
    const { removed } = await forgetWaitlistEmail(rewriteVia, `victim-${pass}@example.test`);
    if (running && removed === 1) {
      rewrites += 1;
    }
    await new Promise((done) => setTimeout(done, 2));
  }
  expect(await finished).toEqual(paths.map(() => 0));
  return rewrites;
}

it('never loses a submission other processes write while this one rewrites the same day file', async () => {
  const rewrites = await rewriteWhileOthersAppend([file, file, file], file);
  expect(rewrites).toBeGreaterThan(0);
  const fresh = (await emails()).filter((email: string) => email.startsWith('new-'));
  expect(fresh).toHaveLength(90);
  expect(new Set(fresh).size).toBe(90);
}, 60_000);

it('loses nothing when processes create the store through different aliases while it is rewritten', async () => {
  const real = join(dir, 'real');
  const alias = join(dir, 'alias');
  await mkdir(real);
  await symlink(real, alias, 'junction');
  // The directory doesn't exist yet: the first writer creates it while the others are already writing.
  const paths = [join(alias, 'new', 'waitlist.jsonl'), join(real, 'new', 'waitlist.jsonl')];
  const rewrites = await rewriteWhileOthersAppend(paths, paths[0] as string);
  expect(rewrites).toBeGreaterThan(0);
  expect((await emails(paths[1] as string)).filter((email: string) => email.startsWith('new-'))).toHaveLength(60);
}, 60_000);

it('the cleanup never touches the file new submissions go into, even without the lock (another container)', async () => {
  // An expired day file and submissions arriving today: a process appending today shares nothing with the cleanup.
  await appendWaitlistRecord(file, record('expired@example.test', '2020-01-01T00:00:00.000Z'));
  const writer = child(
    `for (let i = 0; i < 40; i++) await waitlist.appendWaitlistRecord(${JSON.stringify(file)}, { email: 'today-' + i + '@example.test', interest: 'cloud', receivedAt: new Date().toISOString() });`,
  );
  const finished = new Promise((done) => writer.on('exit', done));
  let sweeps = 0;
  let running = true;
  void finished.then(() => {
    running = false;
  });
  while (running) {
    await pruneWaitlist(file, Date.now(), 1);
    sweeps += 1;
    await new Promise((done) => setTimeout(done, 2));
  }
  expect(await finished).toBe(0);
  expect(sweeps).toBeGreaterThan(0);
  expect((await emails()).filter((email: string) => email.startsWith('today-'))).toHaveLength(40);
  expect(await emails()).not.toContain('expired@example.test');
}, 60_000);

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

it.skipIf(process.platform === 'win32')('says when a failure came after the store had already changed', async () => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async (original) => {
    const real = (await original()) as typeof import('node:fs/promises');
    return {
      ...real,
      // Opening a directory to flush the rename fails, as on a failing disk.
      open: (async (path: string, flags?: string, mode?: number) => {
        if (flags === 'r' && (await real.stat(path)).isDirectory()) {
          throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
        }
        return real.open(path, flags, mode);
      }) as typeof real.open,
    };
  });
  try {
    const fresh = await import('../../waitlist/file.mjs');
    await fresh.appendWaitlistRecord(file, record('forget-me@example.test', '2026-11-01T00:00:00.000Z'));
    await fresh.appendWaitlistRecord(file, record('keep-me@example.test', '2026-11-01T01:00:00.000Z'));
    await expect(fresh.forgetWaitlistEmail(file, 'forget-me@example.test')).rejects.toMatchObject({ replaced: true });
    // The deletion did happen; only its durability is in doubt.
    expect(await emails()).toEqual(['keep-me@example.test']);
  } finally {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  }
});

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
  expect(retentionDeadline(at(receivedAt), 1)).toBe(at('2026-04-30T12:00:00.000Z') / 1000);
  const put = vi.fn(async () => undefined);
  await createCloudflareStore({ WAITLIST_KV: { put } }, 24)({ email: 'kv@example.test', interest: 'cloud', receivedAt });
  expect(put).toHaveBeenCalledWith(expect.stringMatching(/^waitlist:2026-03-31T12:00:00\.000Z:/), expect.any(String), {
    expiration: at('2028-03-31T12:00:00.000Z') / 1000,
  });
});
