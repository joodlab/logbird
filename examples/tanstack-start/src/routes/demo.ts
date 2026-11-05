import { createFileRoute } from '@tanstack/react-router';
import { updateRecord } from '../functions';
export const Route = createFileRoute('/demo')({ server: { handlers: { POST: async () => Response.json(await updateRecord()) } } });
