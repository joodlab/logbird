import { z } from 'zod';
import { INTERESTS, NEEDS, VOLUMES } from './waitlist-options';

/** The stored values (lib/waitlist-options.ts, kept free of Zod for the browser); the labels: content/waitlist-form.ts. */
export { INTERESTS, NEEDS, VOLUMES };

// A form sends an unanswered select as "". Checkboxes always arrive as a list: the server collects repeated native
// fields, and the enhanced form sends an array.
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);

export const waitlistSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  interest: z.enum(INTERESTS),
  volume: z.preprocess(blankToUndefined, z.enum(VOLUMES).optional()),
  needs: z
    .array(z.enum(NEEDS))
    .max(NEEDS.length)
    .optional()
    .transform((list) => (list?.length ? [...new Set(list)] : undefined))
    .optional(),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(2000).optional(),
});
export type WaitlistInput = z.infer<typeof waitlistSchema>;
export type WaitlistRecord = Omit<WaitlistInput, 'website'> & { receivedAt: string };
