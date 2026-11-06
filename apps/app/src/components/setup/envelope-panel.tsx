import type { EnvelopeField, ProjectSetup } from '@logbird/contracts';
import { CodeBlock } from '@logbird/ui/components/code-block';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@logbird/ui/components/ui/collapsible';
import { cn } from '@logbird/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon, ChevronDownIcon } from 'lucide-react';
import { pluralize } from '@/lib/format';
import { ENVELOPE_CORE, ENVELOPE_EXAMPLE } from '@/lib/snippets';

/** What to send for each recommended envelope part — the "what to fix" hint next to its coverage. */
export const ENVELOPE_HINTS: Record<EnvelopeField, { shape: string; hint: string }> = {
  actor: { shape: 'actor: { type, id, name }', hint: 'Who caused the change. Scheduled runs use type "system".' },
  tenant: { shape: 'tenant: { id, name }', hint: 'The customer account the change belongs to — powers the Tenants pages.' },
  executor: { shape: 'executor: { type, id }', hint: 'Who performed it: the API, a worker, a job (add jobId and attempt).' },
  targets: { shape: 'targets: [{ type, id, name }]', hint: 'Every record the event touched; each gets its own history page.' },
  outcome: {
    shape: 'outcome: "success" | "failure" | "denied" | "partial"',
    hint: 'Without it the server records "unknown", so failures are invisible on the dashboard.',
  },
  occurredAt: {
    shape: 'occurredAt: ISO-8601 time',
    hint: 'When it happened. Without it the arrival time is used, which drifts for queued or batched events.',
  },
};

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;

export function EnvelopePanel({ projectId, setup }: { projectId: string; setup: ProjectSetup }) {
  const { envelope } = setup;
  if (envelope.sampledEvents === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="rounded-lg border border-dashed px-4 py-3 text-muted-foreground text-sm">
          Coverage is measured on your most recent real events (sample data is ignored). Send a few events and this fills in.
        </p>
        <EnvelopeSnippet />
      </div>
    );
  }
  const avg = Math.round(envelope.avgConformance);
  const met = avg >= envelope.target;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">
            <span className={cn('font-semibold text-2xl tabular-nums tracking-tight', met ? 'text-outcome-success' : 'text-foreground')}>{avg}%</span>{' '}
            <span className="text-muted-foreground">average conformance · target {envelope.target}%</span>
          </p>
          <span className="text-muted-foreground text-xs tabular-nums">{pluralize(envelope.sampledEvents, 'recent event')}</span>
        </div>
        <div className="relative h-2 rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-[width] duration-500', met ? 'bg-outcome-success' : 'bg-brand')}
            style={{ width: `${Math.min(100, avg)}%` }}
          />
          <span
            aria-hidden
            className="-top-1 absolute h-4 w-0.5 rounded bg-foreground/60"
            style={{ left: `calc(${envelope.target}% - 1px)` }}
            title={`Target ${envelope.target}%`}
          />
        </div>
      </div>

      <ul className="divide-y rounded-lg border" data-testid="envelope-fields">
        {envelope.fields.map((f) => {
          const hint = ENVELOPE_HINTS[f.field];
          const full = f.coverage >= 0.999;
          return (
            <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-4" key={f.field}>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <code className="font-mono text-[13px]">{f.field}</code>
                  <span
                    className={cn(
                      'text-xs tabular-nums',
                      full ? 'text-outcome-success' : f.coverage < 0.5 ? 'text-outcome-denied' : 'text-muted-foreground',
                    )}
                  >
                    {pct(f.coverage)}
                  </span>
                </span>
                {full ? (
                  <span className="text-muted-foreground text-xs">Present on every recent event.</span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    Send <span className="font-mono text-foreground">{hint.shape}</span>. {hint.hint}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3 sm:w-56">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className={cn('h-full rounded-full', full ? 'bg-outcome-success' : 'bg-brand')} style={{ width: pct(f.coverage) }} />
                </div>
                {!full && f.missingQuery ? (
                  <Link
                    className="inline-flex shrink-0 items-center gap-0.5 text-brand text-xs hover:underline"
                    params={{ projectId }}
                    search={{ q: f.missingQuery, range: '7d' }}
                    to="/p/$projectId/events"
                  >
                    Find missing
                    <ArrowUpRightIcon className="size-3" />
                  </Link>
                ) : !full ? (
                  <span className="w-[86px] shrink-0 text-[11px] text-muted-foreground" title="Detected from the raw payload; not searchable">
                    from payload
                  </span>
                ) : (
                  <span className="w-[86px] shrink-0" />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground text-xs">
        Conformance also counts <span className="font-mono text-foreground">description</span> and{' '}
        <span className="font-mono text-foreground">context.operationId</span> or <span className="font-mono text-foreground">requestId</span>.
        Per-field coverage for every attribute lives on{' '}
        <Link className="text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/fields">
          Fields
        </Link>
        .
      </p>
      <EnvelopeSnippet />
    </div>
  );
}

function EnvelopeSnippet() {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">Recommended envelope</p>
      <CodeBlock code={ENVELOPE_CORE} language="json" />
      <Collapsible>
        <CollapsibleTrigger className="group inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground">
          <ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" />
          Full reference (impersonator, changes, metadata…)
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <CodeBlock code={ENVELOPE_EXAMPLE} language="json" maxHeight={420} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
