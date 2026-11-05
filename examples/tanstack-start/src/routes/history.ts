import { createFileRoute } from '@tanstack/react-router';
import { readAuditTrail, trailQuery } from '@trailmark/tanstack-start';
export const Route = createFileRoute('/history')({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          await readAuditTrail(
            { endpoint: 'http://127.0.0.1:4731', readKey: process.env.TRAILMARK_READ_KEY ?? '' },
            trailQuery({ target: { id: 'demo-record' } }),
          ),
        ),
    },
  },
});
