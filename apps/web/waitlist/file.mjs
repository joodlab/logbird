// Form submissions on the Node server: appends, the retention cleanup and deletion on request. Plain ESM with only
// Node built-ins, so the site server bundles it and the runtime image can run admin.mjs without a build step.
//
// Storage. WAITLIST_FILE names the store, say /data/waitlist.jsonl. New submissions go into one JSONL file per UTC day
// of receipt in `<WAITLIST_FILE>.d/` (2026-11-11.jsonl, mode 600). Submissions stored before that layout stay in
// WAITLIST_FILE itself (the legacy file); nothing appends to it any more.
//
// Retention never rewrites a file anything still appends to: it deletes whole day files once their last moment is
// past the retention period, and trims the legacy file record by record. New submissions only ever go into today's
// file, which is never that old. So the cleanup can't lose a submission, even when two containers share the volume
// for the seconds a deploy overlaps them. Only `forget` (deletion on request) rewrites files that may still be
// appended to, so it runs in the site's own container (docs/coolify.md), where every writer shares one lock.
//
// The lock is a listening socket: binding is exclusive, and the operating system releases it the moment its process
// exits, crash included, so there is no stale lock to detect or take over. On Linux (the site image; `docker exec`
// shares the container's network namespace) it is an abstract Unix socket. Elsewhere (development) it is a loopback
// TCP port derived from the store's path (20000-29999); if an unrelated program happens to hold that port, writes
// wait and then fail with an error, never proceed unlocked.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises';
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
      throw new Error('The form submissions store stayed locked for 30 s.');
    }
    // A little jitter, so waiting processes take turns rather than retrying in step.
    await new Promise((done) => setTimeout(done, 10 + Math.random() * 20));
  }
}

/**
 * The store's real path, symlinks resolved, so every alias of one store shares one lock, and a rewrite renames over
 * the file that holds the records rather than replacing a symlink and leaving the records in its target. It gives
 * the same answer before and after the file or its directories exist: the nearest existing ancestor is resolved and
 * the missing rest appended, and a dangling symlink (or a chain of them) is followed to the path it will create.
 */
export async function resolveWaitlistPath(file) {
  let path = resolve(file);
  for (let hops = 0; hops <= 40; hops += 1) {
    const missing = [];
    let existing = path;
    let info = await orMissing(() => lstat(existing), undefined);
    while (!info) {
      const parent = dirname(existing);
      if (parent === existing) {
        return path;
      }
      missing.unshift(basename(existing));
      existing = parent;
      info = await orMissing(() => lstat(existing), undefined);
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
 * Runs `task` with the store's real path while holding its lock: queued within this process, exclusive across
 * processes in one container. Every read and write inside `task` must use the path it is given.
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

/** The directory holding one file per day of receipt. */
export const waitlistDays = (path) => `${path}.d`;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/** The day file a record belongs in: its UTC day of receipt, or today when `receivedAt` isn't a valid time. */
function dayFile(path, record) {
  const at = typeof record?.receivedAt === 'string' ? Date.parse(record.receivedAt) : Number.NaN;
  const day = new Date(Number.isNaN(at) ? Date.now() : at).toISOString().slice(0, 10);
  return join(waitlistDays(path), `${day}.jsonl`);
}

/**
 * Calls `read` and treats "doesn't exist" as `missing`. Any other failure (EACCES, EIO) is thrown, so a store that
 * can't be read never looks empty: `forget` would otherwise report "removed 0" while the records remain.
 */
async function orMissing(read, missing) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return missing;
    }
    throw error;
  }
}

/** Every file holding records: the day files, then the legacy file if it exists. */
async function storeFiles(path) {
  const days = (await orMissing(() => readdir(waitlistDays(path)), []))
    .filter((name) => DAY_FILE.test(name))
    .sort()
    .map((name) => join(waitlistDays(path), name));
  const legacy = await orMissing(async () => (await stat(path)).isFile(), false);
  return legacy ? [...days, path] : days;
}

/** Appends one record as a JSONL line to the file for its day of receipt. */
export function appendWaitlistRecord(file, record) {
  return withWaitlistLock(file, async (path) => {
    await mkdir(waitlistDays(path), { recursive: true, mode: 0o700 });
    const handle = await open(dayFile(path, record), 'a+', 0o600);
    try {
      // A crash or a full disk mid-append can leave a last line without its newline. Start a new line then, so the
      // torn line stays alone and this record stays readable instead of being glued onto it.
      const { size } = await handle.stat();
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        prefix = last[0] === NEWLINE ? '' : '\n';
      }
      // Not flushed to disk per record: a power cut right after the response can lose the latest submissions; the
      // notification email is their second copy (docs/coolify.md).
      await handle.appendFile(`${prefix}${JSON.stringify(record)}\n`);
    } finally {
      await handle.close();
    }
  });
}

const TEMPORARY = '.rewrite-';
const NEWLINE = 0x0a;
const LINE_END = Buffer.from('\n');

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
 * Flushes a directory entry change (a rename or a deletion) to disk. Windows can't open a directory for this, and
 * some file systems refuse to sync one (EINVAL, ENOTSUP); any other failure (EIO, say) is reported, because the change
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

/** An error after the store already changed: the deletion happened, but it may not survive a crash. */
function afterChange(error) {
  return Object.assign(new Error(`The submissions were changed, but flushing that to disk failed: ${error?.message ?? error}`), {
    replaced: true,
    cause: error,
  });
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Deletes temporary files left by a crashed rewrite of this store (rewrites only happen under the lock, so any found
 * are leftovers): exactly `<day>.jsonl.rewrite-<uuid>` in the day directory and `<store file>.rewrite-<uuid>` next to
 * the store, and nothing else that merely looks similar.
 */
async function removeLeftovers(path) {
  const places = [
    [waitlistDays(path), new RegExp(`^\\d{4}-\\d{2}-\\d{2}\\.jsonl${escapeRegExp(TEMPORARY)}${UUID}$`)],
    [dirname(path), new RegExp(`^${escapeRegExp(basename(path))}${escapeRegExp(TEMPORARY)}${UUID}$`)],
  ];
  for (const [directory, pattern] of places) {
    for (const name of (await orMissing(() => readdir(directory), [])).filter((entry) => pattern.test(entry))) {
      await rm(join(directory, name), { force: true });
    }
  }
}

/** The non-blank lines of a file, as the bytes they hold (no decoding, so nothing is altered when written back). */
function splitLines(bytes) {
  const lines = [];
  for (let start = 0; start < bytes.length; ) {
    const end = bytes.indexOf(NEWLINE, start);
    const line = bytes.subarray(start, end === -1 ? bytes.length : end);
    if (line.toString('utf8').trim()) {
      lines.push(line);
    }
    start = end === -1 ? bytes.length : end + 1;
  }
  return lines;
}

/**
 * Rewrites one file keeping only the records `keep` accepts: a new, uniquely named mode-600 file, flushed to disk,
 * renamed over the old one, so a reader (or a reboot after a power cut) sees either the old file or the new one.
 * Lines that aren't JSON are kept unless `dropUnreadable` says otherwise, and the kept ones are counted as
 * `unreadable`. Run as root (say `docker exec -u root`), the new file keeps the old one's owner, so the site can still
 * append to it. A failed rewrite removes its temporary file. Must run under the store's lock.
 */
async function rewriteFile(path, keep, dropUnreadable = () => false) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { kept: 0, removed: 0, unreadable: 0 };
    }
    throw error;
  }
  const lines = splitLines(bytes);
  let unreadable = 0;
  const kept = lines.filter((line) => {
    let record;
    try {
      record = JSON.parse(line.toString('utf8'));
    } catch {
      if (dropUnreadable(line)) {
        return false;
      }
      unreadable += 1;
      return true;
    }
    return keep(record);
  });
  const removed = lines.length - kept.length;
  if (!removed) {
    return { kept: kept.length, removed, unreadable };
  }
  const temporary = join(dirname(path), `${basename(path)}${TEMPORARY}${randomUUID()}`);
  const current = await stat(path);
  const owner = process.getuid?.() === 0 ? { uid: current.uid, gid: current.gid } : undefined;
  try {
    await writeDurably(temporary, Buffer.concat(kept.flatMap((line) => [line, LINE_END])), owner);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await syncDirectory(dirname(path));
  } catch (error) {
    throw afterChange(error);
  }
  return { kept: kept.length, removed, unreadable };
}

const countLines = async (path) => (await orMissing(() => readFile(path, 'utf8'), '')).split('\n').filter((line) => line.trim()).length;

/**
 * Deletes submissions whose retention period has ended by `now`. A day file goes whole once even its last moment is
 * past the period (so a submission is never deleted early, and goes at most a day after it expires); its lines, readable or not,
 * go with it. The legacy file is trimmed record by record; a legacy record without a readable `receivedAt` is kept.
 * Today's file, the only one still appended to, is never touched.
 */
export function pruneWaitlist(file, now, months) {
  return withWaitlistLock(file, async (path) => {
    await removeLeftovers(path);
    let removed = 0;
    let kept = 0;
    let deletedDays = false;
    for (const day of await storeFiles(path)) {
      const match = DAY_FILE.exec(basename(day));
      if (!match || day === path) {
        continue;
      }
      const nextDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
      const lines = await countLines(day);
      if (retentionExpiry(nextDay - 1, months) <= now) {
        await rm(day, { force: true });
        removed += lines;
        deletedDays = true;
      } else {
        kept += lines;
      }
    }
    if (deletedDays) {
      try {
        await syncDirectory(waitlistDays(path));
      } catch (error) {
        throw afterChange(error);
      }
    }
    const legacy = await pruneLegacy(path, now, months);
    return { kept: kept + legacy.kept, removed: removed + legacy.removed, unreadable: legacy.unreadable };
  });
}

/**
 * Trims the legacy file. A record with a readable `receivedAt` goes once its own period has passed. A line that can't
 * be read, or a record without a date, can't be dated by itself, but nothing appends to the legacy file since day files
 * began, so every line in it is older than that moment. `<store>.legacy-until` records it (written by the first
 * cleanup that finds the legacy file), and such lines go once the period has passed for it: late, never early. When
 * the legacy file is empty, it and the marker are removed.
 */
async function pruneLegacy(path, now, months) {
  const present = await orMissing(async () => (await stat(path)).isFile(), false);
  if (!present) {
    return { kept: 0, removed: 0, unreadable: 0 };
  }
  const marker = `${path}.legacy-until`;
  let until = Date.parse((await orMissing(() => readFile(marker, 'utf8'), '')).trim());
  if (Number.isNaN(until)) {
    until = now;
    const temporary = `${marker}${TEMPORARY}${randomUUID()}`;
    try {
      await writeDurably(temporary, `${new Date(until).toISOString()}\n`);
      await rename(temporary, marker);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    // Make the rename itself durable: a marker lost to a power cut would be written again later, with a later date,
    // and push back when undated lines expire. A failure here fails the run; the next run writes the marker again.
    await syncDirectory(dirname(marker));
  }
  const undatedExpired = retentionExpiry(until, months) <= now;
  const result = await rewriteFile(
    path,
    (record) => {
      const receivedAt = typeof record?.receivedAt === 'string' ? Date.parse(record.receivedAt) : Number.NaN;
      return Number.isNaN(receivedAt) ? !undatedExpired : retentionExpiry(receivedAt, months) > now;
    },
    () => undatedExpired,
  );
  if (result.kept === 0) {
    await rm(path, { force: true });
    await rm(marker, { force: true });
    try {
      await syncDirectory(dirname(path));
    } catch (error) {
      throw afterChange(error);
    }
  }
  return result;
}

/**
 * Deletes every record sent from `email` (case and surrounding spaces ignored), from every day file and the legacy
 * file. A line that isn't valid JSON (a torn write) is deleted too when it contains the address anywhere, since it may
 * hold that person's data; other unreadable lines are kept and counted, so the operator can check them. It rewrites
 * files that new submissions may still go into, so it must run where every writer shares the lock: in the site's own
 * container.
 */
export async function forgetWaitlistEmail(file, email) {
  const target = email.trim().toLowerCase();
  if (!target) {
    throw new Error('An email address is required.');
  }
  return withWaitlistLock(file, async (path) => {
    await removeLeftovers(path);
    const total = { kept: 0, removed: 0, unreadable: 0 };
    const stores = await storeFiles(path);
    for (const [index, store] of stores.entries()) {
      let result;
      try {
        result = await rewriteFile(
          store,
          (record) =>
            String(record?.email ?? '')
              .trim()
              .toLowerCase() !== target,
          // A substring match: it may also catch a torn line holding a longer address that contains this one. Deleting a
          // broken line too many is the safe side for a deletion request.
          (line) => line.toString('utf8').toLowerCase().includes(target),
        );
      } catch (error) {
        const changed = total.removed > 0 || Boolean(error?.replaced);
        if (!changed) {
          // Nothing was rewritten yet: nothing changed.
          throw error;
        }
        if (error?.replaced && index === stores.length - 1) {
          // Every file was processed; only flushing the last one is in doubt.
          throw error;
        }
        // Some files were rewritten, but this one failed or later ones weren't reached: records may remain.
        throw Object.assign(new Error(error?.message ?? String(error)), { replaced: true, partial: true, cause: error });
      }
      total.kept += result.kept;
      total.removed += result.removed;
      total.unreadable += result.unreadable;
    }
    return total;
  });
}
