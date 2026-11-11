#!/usr/bin/env node
// Deletes one person's form submissions on request (docs/coolify.md, "Form submissions"). In the site container:
//
//   docker exec <site container> node waitlist/admin.mjs forget someone@example.com
//
// From a source checkout: `pnpm --filter @logbird/web waitlist:forget someone@example.com`. Reads WAITLIST_FILE (the
// image sets /data/waitlist.jsonl). Prints only counts, never the records.
import { resolve } from 'node:path';
import { forgetWaitlistEmail } from './file.mjs';

const [command, email] = process.argv.slice(2);
const file = process.env.WAITLIST_FILE ? resolve(process.env.WAITLIST_FILE) : resolve('.data/waitlist.jsonl');
if (command !== 'forget' || !email) {
  console.error('Usage: node waitlist/admin.mjs forget <email>');
  process.exit(2);
}
try {
  const { removed, kept } = await forgetWaitlistEmail(file, email);
  console.log(`Removed ${removed} submission(s) for that address; ${kept} other submission(s) kept in ${file}.`);
  console.log('Also delete the notification emails for that address from the team mailbox.');
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (error?.replaced) {
    // The submissions are gone from the file, but the change may not survive a crash: check the disk, then run the
    // command again (it is safe to repeat).
    console.error(`The submissions were removed, but the result may not be on disk yet: ${reason}`);
  } else {
    // Nothing changed. The usual cause is another site container still running on this volume (a deploy in
    // progress): try again once it has stopped.
    console.error(`Nothing was deleted: ${reason}`);
  }
  process.exit(1);
}
