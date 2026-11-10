// The form submissions file (JSONL, mode 600): appends, the retention cleanup and deletion on request. Plain ESM with
// only Node built-ins, so the site server bundles it and the runtime image can run admin.mjs without a build step.
//
// Every write holds one lock per file, so the server's appends and cleanup and an operator's `admin.mjs forget` never
// interleave and lose a line. The lock is a listening socket: binding is exclusive, and the operating system releases
// it the moment its process exits, crash included, so there is no stale lock to detect or take over. On Linux (the
// site image; `docker exec` shares the container's network namespace) it is an abstract Unix socket. Elsewhere
// (development) it is a loopback TCP port derived from the file's path (20000-29999); if an unrelated program happens to hold that
// port, writes wait and then fail with an error, never proceed unlocked.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { retentionExpiry } from './expiry.mjs';

export { retentionExpiry };

const LOCK_WAIT_MS = 30_000;

/**
 * Where the lock for `file` listens, in order of preference. Every process computes the same list. On Windows some
 * port ranges are reserved by the system (EACCES for every process alike), so each process skips the same ones and
 * all of them agree on the first port they may bind.
 */
function lockAddresses(file) {
  const id = createHash('sha256').update(file).digest();
  if (process.platform === 'linux') {
    // exclusive: cluster workers (Node cluster, PM2) must not share one listening handle, or both would hold the lock.
    return [{ path: `\0logbird-waitlist-${id.toString('hex').slice(0, 32)}`, exclusive: true }];
  }
  const first = id.readUInt32BE(0) % 10_000;
  return Array.from({ length: 50 }, (_, step) => ({ host: '127.0.0.1', port: 20_000 + ((first + step * 197) % 10_000), exclusive: true }));
}

function listen(address) {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      server.unref();
      resolve(server);
    });
  });
}

async function acquire(file) {
  const addresses = lockAddresses(file);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let busy = false;
    for (const address of addresses) {
      try {
        return await listen(address);
      } catch (error) {
        if (error?.code === 'EADDRINUSE') {
          busy = true;
          break;
        }
        if (error?.code !== 'EACCES' && error?.code !== 'EADDRNOTAVAIL') {
          throw error;
        }
      }
    }
    if (!busy) {
      throw new Error('No address is available for the form submissions lock.');
    }
    if (Date.now() > deadline) {
      throw new Error('The form submissions file stayed locked for 30 s.');
    }
    await new Promise((done) => setTimeout(done, 20));
  }
}

/**
 * The file's real path, symlinks resolved, so every alias of one file shares one lock, and a rewrite renames over
 * the file that holds the records rather than replacing a symlink and leaving the records in its target. It gives
 * the same answer before and after the file or its directories exist: the nearest existing ancestor is resolved and
 * the missing rest appended, and a dangling symlink (or a chain of them) is followed to the path it will create.
 */
export async function resolveWaitlistPath(file) {
  let path = resolve(file);
  for (let hops = 0; hops <= 40; hops += 1) {
    const missing = [];
    let existing = path;
    let info = await lstat(existing).catch(() => undefined);
    while (!info) {
      const parent = dirname(existing);
      if (parent === existing) {
        return path;
      }
      missing.unshift(basename(existing));
      existing = parent;
      info = await lstat(existing).catch(() => undefined);
    }
    try {
      return join(await realpath(existing), ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT' || !info.isSymbolicLink()) {
        throw error;
      }
    }
    // A dangling symlink: follow one hop and resolve again.
    path = join(resolve(dirname(existing), await readlink(existing)), ...missing);
  }
  throw new Error('Too many symbolic links in the form submissions path.');
}

let local = Promise.resolve();

/**
 * Runs `task` with the file's real path while holding its lock: queued within this process, exclusive across
 * processes. Every read and write inside `task` must use the path it is given.
 */
export function withWaitlistLock(file, task) {
  const run = local.then(async () => {
    const path = await resolveWaitlistPath(file);
    const lock = await acquire(path);
    try {
      return await task(path);
    } finally {
      await new Promise((done) => lock.close(() => done()));
    }
  });
  local = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Appends one record as a JSONL line. */
export function appendWaitlistRecord(file, record) {
  return withWaitlistLock(file, async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
}

const TEMPORARY = '.rewrite-';

/**
 * Rewrites the file keeping only the records `keep` accepts: a new, uniquely named mode-600 file renamed over the
 * old one, so a reader sees either the old file or the new one. Lines that aren't JSON are kept: this never deletes
 * what it can't read. A failed rewrite removes its temporary file; one left by a crash (rewrites only happen under the
 * lock, so any that exists now is a leftover) is deleted first, so no copy of a deleted record survives.
 */
export function rewriteWaitlist(file, keep) {
  return withWaitlistLock(file, async (path) => {
    const prefix = `${basename(path)}${TEMPORARY}`;
    const leftovers = await readdir(dirname(path)).catch(() => []);
    for (const name of leftovers.filter((entry) => entry.startsWith(prefix))) {
      await rm(join(dirname(path), name), { force: true });
    }
    let text;
    try {
      text = await readFile(path, 'utf8');
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
      const temporary = join(dirname(path), `${prefix}${randomUUID()}`);
      try {
        await writeFile(temporary, kept.map((line) => `${line}\n`).join(''), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    }
    return { kept: kept.length, removed };
  });
}

/** Deletes records whose retention period has ended by `now`. A record without a readable `receivedAt` is kept. */
export function pruneWaitlist(file, now, months) {
  return rewriteWaitlist(file, (record) => {
    const receivedAt = typeof record?.receivedAt === 'string' ? Date.parse(record.receivedAt) : Number.NaN;
    return Number.isNaN(receivedAt) || retentionExpiry(receivedAt, months) > now;
  });
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
