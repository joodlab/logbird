// The form submissions file (JSONL, mode 600): appends, the retention cleanup and deletion on request. Plain ESM with
// only Node built-ins, so the site server bundles it and the runtime image can run admin.mjs without a build step.
// Every write holds one lock, a directory next to the file (mkdir is atomic across processes), so the server's
// appends and cleanup and an operator's `admin.mjs forget` never interleave and lose a line.
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A lock older than this was left by a crashed process (every holder finishes in milliseconds). */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

let local = Promise.resolve();

/** Runs `task` while holding the file's lock: serialised within this process, then across processes. */
export function withWaitlistLock(file, task) {
  const run = local.then(() => holdLock(file, task));
  local = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function holdLock(file, task) {
  const lock = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > STALE_LOCK_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`The form submissions file is locked (${lock}).`);
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  }
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Appends one record as a JSONL line. */
export function appendWaitlistRecord(file, record) {
  return withWaitlistLock(file, () => appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 }));
}

/**
 * Rewrites the file keeping only the records `keep` accepts, atomically (a temporary file renamed over it, mode 600).
 * Lines that aren't JSON are kept: this never deletes what it can't read.
 */
export function rewriteWaitlist(file, keep) {
  return withWaitlistLock(file, async () => {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { kept: 0, removed: 0 };
      }
      throw error;
    }
    const lines = text.split('\n').filter((line) => line.trim());
    const kept = lines.filter((line) => {
      try {
        return keep(JSON.parse(line));
      } catch {
        return true;
      }
    });
    const removed = lines.length - kept.length;
    if (removed) {
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, kept.map((line) => `${line}\n`).join(''), { mode: 0o600 });
      await rename(temporary, file);
    }
    return { kept: kept.length, removed };
  });
}

/** The moment `months` calendar months before `now`, as an ISO timestamp (what `receivedAt` holds). */
export function retentionCutoff(now, months) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

/** Deletes records received before the cutoff. A record without a `receivedAt` is kept. */
export function pruneWaitlist(file, cutoff) {
  return rewriteWaitlist(file, (record) => typeof record?.receivedAt !== 'string' || record.receivedAt >= cutoff);
}

/** Deletes every record sent from `email` (case and surrounding spaces ignored). */
export async function forgetWaitlistEmail(file, email) {
  const target = email.trim().toLowerCase();
  if (!target) {
    throw new Error('An email address is required.');
  }
  return rewriteWaitlist(
    file,
    (record) =>
      String(record?.email ?? '')
        .trim()
        .toLowerCase() !== target,
  );
}
