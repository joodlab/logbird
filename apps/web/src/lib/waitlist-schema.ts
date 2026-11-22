import { z } from 'zod';

/** Optional qualifying answers. The values are stored; the labels live in the form (components/waitlist-form.tsx). */
export const VOLUMES = ['unsure', 'under-100k', '100k-1m', '1m-10m', 'over-10m'] as const;
export const NEEDS = ['customer-audit-log', 'compliance', 'investigations', 'self-host-support', 'other'] as const;

// A native form sends an unanswered select as "" and checkboxes as repeated fields; JSON sends a list.
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);
const toList = (value: unknown) => (value === undefined || value === '' ? undefined : Array.isArray(value) ? value : [value]);

export const waitlistSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  interest: z.enum(['cloud', 'self-host', 'updates', 'correction', 'other', 'privacy']),
  volume: z.preprocess(blankToUndefined, z.enum(VOLUMES).optional()),
  needs: z
    .preprocess(toList, z.array(z.enum(NEEDS)).max(NEEDS.length).optional())
    .transform((list) => (list?.length ? [...new Set(list)] : undefined))
    .optional(),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(2000).optional(),
});
export type WaitlistInput = z.infer<typeof waitlistSchema>;
export type WaitlistRecord = Omit<WaitlistInput, 'website'> & { receivedAt: string };
