#!/usr/bin/env node
// Deletes one person's form submissions on request (docs/coolify.md, "Form submissions"). In the site container:
//
//   docker exec <site container> node waitlist/admin.mjs forget someone@example.com
//
// Run it in the container that serves the site, so it shares the lock with new submissions. From a source checkout:
// `pnpm --filter @logbird/web waitlist:forget someone@example.com`. Reads WAITLIST_FILE (the image sets
// /data/waitlist.jsonl; the day files are in /data/waitlist.jsonl.d). Prints only counts, never the records.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { forgetWaitlistEmail } from './file.mjs';

const [command, email] = process.argv.slice(2);
const file = process.env.WAITLIST_FILE ? resolve(process.env.WAITLIST_FILE) : resolve('.data/waitlist.jsonl');
if (command !== 'forget' || !email) {
  console.error('Usage: node waitlist/admin.mjs forget <email>');
  process.exit(2);
}
if (!existsSync(file) && !existsSync(`${file}.d`)) {
  // Usually the wrong WAITLIST_FILE, or the command run outside the site's container.
  console.error(`No form submissions store at ${file}; set WAITLIST_FILE to the site's store. Nothing was deleted.`);
  process.exit(1);
}
try {
  const { removed, kept, unreadable } = await forgetWaitlistEmail(file, email);
  console.log(`Removed ${removed} submission(s) for that address; ${kept} other submission(s) kept in ${file} and its day files.`);
  if (unreadable) {
    // None of these contains the address (those were removed), but they can't be read, so a person should look.
    console.log(`${unreadable} line(s) that aren't valid JSON remain; none contains that address. Check them by hand.`);
  }
  console.log('Also delete the notification emails for that address from the team mailbox.');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (error?.replaced) {
    // Some or all of the submissions are gone, but the change may not survive a crash: check the disk, then run the
    // command again (it is safe to repeat).
    console.error(`The submissions were removed, but the result may not be on disk yet: ${reason}`);
  } else {
    // Nothing changed, so it is safe to fix the cause and run it again.
    console.error(`Nothing was deleted: ${reason}`);
  }
  process.exit(1);
}
