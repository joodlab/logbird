import { z } from 'zod';
export const waitlistSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  interest: z.enum(['cloud', 'self-host', 'updates', 'correction', 'other']),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(2000).optional(),
});
export type WaitlistInput = z.infer<typeof waitlistSchema>;
export type WaitlistRecord = Omit<WaitlistInput, 'website'> & { receivedAt: string };
