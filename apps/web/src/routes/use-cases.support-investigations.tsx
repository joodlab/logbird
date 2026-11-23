import { createFileRoute } from '@tanstack/react-router';
import { UseCasePage } from '../components/marketing/use-case';
import { supportInvestigations } from '../content/use-cases/support-investigations';
import { pageHead } from '../lib/seo';

// Words: content/use-cases/support-investigations.ts. This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/use-cases/support-investigations')({
  head: () => pageHead('/use-cases/support-investigations'),
  component: () => <UseCasePage page={supportInvestigations} />,
});
