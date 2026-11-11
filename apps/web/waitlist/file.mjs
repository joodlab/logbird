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
import { appendFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
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
    // A little jitter, so waiting processes take turns rather than retrying in step.
    await new Promise((done) => setTimeout(done, 10 + Math.random() * 20));
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

// The socket lock keeps writers apart inside one container. Two containers sharing the volume (a deploy that starts
// the new one before stopping the old) each have their own lock, so they also coordinate through files next to the
// submissions file, in `<file>.writers/`:
//
// - `host-<hostname>`: a container announcing it writes the file. The site server touches it on start, every 30 s
//   and on every append; an announcement older than 90 s belongs to a container that has stopped.
// - `rewrite-<hostname>`: a container rewriting the file right now (the cleanup or `forget`).
//
// A rewrite writes its marker first and then looks for another container's announcement; an append writes its
// announcement first and then looks for another container's marker. Each writes its own flag before reading the
// other's, so at least one of them sees the other: the rewrite backs off (it refuses, and the cleanup tries again on
// its next pass), or the append waits until the rewrite has finished. A foreign append can therefore never land in a
// file that a rewrite is about to replace. The volume must be local to one machine (one clock, one file system), as a
// Docker volume is.
const WRITER_FRESH_MS = 90_000;
/** A rewrite takes well under a second; a marker older than this was left by a container that crashed mid-rewrite. */
const REWRITE_STALE_MS = 60_000;
const writers = (path) => `${path}.writers`;
const announcement = (host) => `host-${host}`;
const marker = (host) => `rewrite-${host}`;

async function touch(path, name) {
  await mkdir(writers(path), { recursive: true });
  await writeFile(join(writers(path), name), `${Date.now()}\n`, { mode: 0o600 });
}

/** Other hosts with an entry of `kind` touched within `freshMs`. */
async function othersWith(path, kind, freshMs) {
  const names = await readdir(writers(path)).catch(() => []);
  const prefix = `${kind}-`;
  const others = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry !== `${prefix}${hostname()}`)) {
    const info = await stat(join(writers(path), name)).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs < freshMs) {
      others.push(name.slice(prefix.length));
    }
  }
  return others;
}

/** Announces this host as a writer of `file` until the returned function is called (the site server does this). */
export async function registerWaitlistWriter(file, everyMs = 30_000) {
  const path = await resolveWaitlistPath(file);
  await touch(path, announcement(hostname()));
  const timer = setInterval(() => touch(path, announcement(hostname())).catch(() => undefined), everyMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await rm(join(writers(path), announcement(hostname())), { force: true });
  };
}

/** Appends one record as a JSONL line, after any rewrite another container is running has finished. */
export function appendWaitlistRecord(file, record) {
  return withWaitlistLock(file, async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await touch(path, announcement(hostname()));
    const deadline = Date.now() + LOCK_WAIT_MS;
    while ((await othersWith(path, 'rewrite', REWRITE_STALE_MS)).length) {
      if (Date.now() > deadline) {
        throw new Error('Another site container kept rewriting the form submissions file for 30 s.');
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
}

const TEMPORARY = '.rewrite-';

/** Writes `text` to a new file and flushes it to disk, so a rename that follows never exposes an empty file. */
async function writeDurably(path, text, owner) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    if (owner) {
      await handle.chown(owner.uid, owner.gid);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Flushes a directory entry change (the rename) to disk. Windows can't open a directory for this, and some file
 * systems refuse to sync one (EINVAL, ENOTSUP); any other failure (EIO, say) is reported, because the deletion
 * may then not survive a crash.
 */
async function syncDirectory(path) {
  if (process.platform === 'win32') {
    return;
  }
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Rewrites the file keeping only the records `keep` accepts: a new, uniquely named mode-600 file, flushed to disk,
 * renamed over the old one, so a reader (or a reboot after a power cut) sees either the old file or the new one.
 * Lines that aren't JSON are kept, because this never deletes what it can't read, and counted as `unreadable` so an
 * operator can deal with them. Run as root (say `docker exec -u root`), the new file keeps the old one's owner, so
 * the site can still append to it. A failed rewrite removes its temporary file; one left by a crash (rewrites only
 * happen under the lock, so any that exists now is a leftover) is deleted first, so no copy of a deleted record
 * survives. It refuses while another container writes the file (see above).
 *
 * An error thrown before the new file replaced the old one means nothing changed. One thrown after carries
 * `replaced: true`: the deletion happened, but it may not survive a crash.
 */
export function rewriteWaitlist(file, keep) {
  return withWaitlistLock(file, async (path) => {
    await touch(path, marker(hostname()));
    try {
      const others = await othersWith(path, 'host', WRITER_FRESH_MS);
      if (others.length) {
        throw new Error(`Another site container (${others.join(', ')}) is writing this file; not rewriting it until it stops.`);
      }
      return await rewriteAlone(path, keep);
    } finally {
      await rm(join(writers(path), marker(hostname())), { force: true });
    }
  });
}

async function rewriteAlone(path, keep) {
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
      return { kept: 0, removed: 0, unreadable: 0 };
    }
    throw error;
  }
  const lines = text.split('\n').filter((line) => line.trim());
  let unreadable = 0;
  const kept = lines.filter((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      unreadable += 1;
      return true;
    }
    return keep(record);
  });
  const removed = lines.length - kept.length;
  if (!removed) {
    return { kept: kept.length, removed, unreadable };
  }
  const temporary = join(dirname(path), `${prefix}${randomUUID()}`);
  const current = await stat(path);
  const owner = process.getuid?.() === 0 ? { uid: current.uid, gid: current.gid } : undefined;
  try {
    await writeDurably(temporary, kept.map((line) => `${line}\n`).join(''), owner);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    throw Object.assign(new Error(`The file was rewritten, but flushing that to disk failed: ${error?.message ?? error}`), {
      replaced: true,
      cause: error,
    });
  }
  return { kept: kept.length, removed, unreadable };
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
