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
  // Nothing was deleted. The likely cause is another site container still running on this volume (a deploy in
  // progress): try again once it has stopped.
  console.error(`Nothing was deleted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
