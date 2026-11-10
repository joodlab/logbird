import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendWaitlistRecord, forgetWaitlistEmail, pruneWaitlist, retentionCutoff } from '../../waitlist/file.mjs';
import { createCloudflareStore, retentionSeconds } from './waitlist-cloudflare';
import { sweepWaitlist } from './waitlist-retention';

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

it('cuts off whole calendar months', () => {
  expect(retentionCutoff(Date.parse('2026-11-10T12:00:00.000Z'), 24)).toBe('2024-11-10T12:00:00.000Z');
  expect(retentionCutoff(Date.parse('2026-03-31T00:00:00.000Z'), 1)).toBe('2026-03-03T00:00:00.000Z');
});

it('deletes submissions older than the retention period and keeps the rest, logging counts only', async () => {
  await appendWaitlistRecord(file, record('old@example.test', '2024-11-09T23:59:59.000Z'));
  await appendWaitlistRecord(file, record('edge@example.test', '2024-11-10T12:00:00.000Z'));
  await appendWaitlistRecord(file, record('new@example.test', '2026-11-01T08:00:00.000Z'));
  await writeFile(file, 'not json\n', { flag: 'a' });
  const lines: string[] = [];
  const result = await sweepWaitlist(file, { now: Date.parse('2026-11-10T12:00:00.000Z'), months: 24, log: (line) => lines.push(line) });
  expect(result).toEqual({ kept: 3, removed: 1 });
  // What it can't read, it keeps.
  expect(await readFile(file, 'utf8')).toContain('not json');
  expect(
    (await readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .slice(0, 2)
      .map((line) => JSON.parse(line).email),
  ).toEqual(['edge@example.test', 'new@example.test']);
  expect(lines).toEqual([JSON.stringify({ level: 'info', event: 'waitlist.retention', removed: 1, kept: 3, months: 24 })]);
  expect(lines.join('')).not.toContain('@');
  if (process.platform !== 'win32') {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  // Nothing to do: the file is left alone and nothing is logged.
  expect(await sweepWaitlist(file, { now: Date.parse('2026-11-10T12:00:00.000Z'), months: 24, log: (line) => lines.push(line) })).toEqual({
    kept: 3,
    removed: 0,
  });
  expect(lines).toHaveLength(1);
});

it('treats a missing file as empty', async () => {
  expect(await pruneWaitlist(file, '2026-01-01T00:00:00.000Z')).toEqual({ kept: 0, removed: 0 });
});

it('forgets every submission from one address, ignoring case and spaces', async () => {
  await appendWaitlistRecord(file, record('Someone@Example.test', '2026-11-01T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('other@example.test', '2026-11-02T00:00:00.000Z'));
  await appendWaitlistRecord(file, record('someone@example.test', '2026-11-03T00:00:00.000Z'));
  expect(await forgetWaitlistEmail(file, ' SOMEONE@example.test ')).toEqual({ kept: 1, removed: 2 });
  expect(await emails()).toEqual(['other@example.test']);
  await expect(forgetWaitlistEmail(file, '  ')).rejects.toThrow(/required/);
});

it('never loses a submission written while the file is being rewritten', async () => {
  for (let index = 0; index < 20; index += 1) {
    await appendWaitlistRecord(file, record(`old-${index}@example.test`, '2020-01-01T00:00:00.000Z'));
  }
  const fresh = Array.from({ length: 20 }, (_, index) => record(`new-${index}@example.test`, '2026-11-10T00:00:00.000Z'));
  await Promise.all([pruneWaitlist(file, '2025-01-01T00:00:00.000Z'), ...fresh.map((entry) => appendWaitlistRecord(file, entry))]);
  await pruneWaitlist(file, '2025-01-01T00:00:00.000Z');
  expect((await emails()).sort()).toEqual(fresh.map((entry) => entry.email).sort());
});

it('waits for a lock held by another process and takes over one left by a crash', async () => {
  const lock = `${file}.lock`;
  await mkdir(lock);
  const pending = appendWaitlistRecord(file, record('waiting@example.test', '2026-11-10T00:00:00.000Z'));
  await new Promise((done) => setTimeout(done, 100));
  await expect(stat(file)).rejects.toThrow();
  await rm(lock, { recursive: true });
  await pending;
  expect(await emails()).toEqual(['waiting@example.test']);
  // A lock older than 30 s belongs to a process that crashed.
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await appendWaitlistRecord(file, record('after-crash@example.test', '2026-11-10T00:00:00.000Z'));
  expect(await emails()).toEqual(['waiting@example.test', 'after-crash@example.test']);
  await expect(stat(lock)).rejects.toThrow();
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
  const receivedAt = '2026-11-10T12:00:00.000Z';
  expect(retentionSeconds(Date.parse(receivedAt), 24)).toBe((Date.parse('2028-11-10T12:00:00.000Z') - Date.parse(receivedAt)) / 1000);
  const put = vi.fn(async () => undefined);
  await createCloudflareStore({ WAITLIST_KV: { put } }, 24)({ email: 'kv@example.test', interest: 'cloud', receivedAt });
  expect(put).toHaveBeenCalledWith(expect.stringMatching(/^waitlist:2026-11-10T12:00:00\.000Z:/), expect.any(String), {
    expirationTtl: retentionSeconds(Date.parse(receivedAt), 24),
  });
});
