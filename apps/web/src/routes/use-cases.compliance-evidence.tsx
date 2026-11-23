import { createFileRoute } from '@tanstack/react-router';
import { UseCasePage } from '../components/marketing/use-case';
import { complianceEvidence } from '../content/use-cases/compliance-evidence';
import { pageHead } from '../lib/seo';

// Words: content/use-cases/compliance-evidence.ts. This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/use-cases/compliance-evidence')({
  head: () => pageHead('/use-cases/compliance-evidence'),
  component: () => <UseCasePage page={complianceEvidence} />,
});
