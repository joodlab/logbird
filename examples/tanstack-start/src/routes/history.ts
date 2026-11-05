import { createFileRoute } from '@tanstack/react-router';
import { readAuditTrail, trailQuery } from '@trailmark/tanstack-start';
import { client, endpoint } from '../../audit.server';
export const Route = createFileRoute('/history')({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(
            await readAuditTrail({ endpoint, readKey: process.env.TRAILMARK_READ_KEY ?? '' }, trailQuery({ target: { id: 'demo-record' } })),
          );
        } catch {
          await client.flush().catch(() => console.error('Audit flush failed'));
          return Response.json({ error: 'Audit history unavailable. Please retry.' }, { status: 502 });
        }
      },
    },
  },
});
