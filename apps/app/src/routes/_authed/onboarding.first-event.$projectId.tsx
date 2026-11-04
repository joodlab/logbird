import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import type { AuditEvent } from '@trailmark/contracts';
import { OutcomeDot } from '@trailmark/ui/components/badges';
import { CodeBlock, CodeTabs } from '@trailmark/ui/components/code-block';
import { CopyButton } from '@trailmark/ui/components/copy-button';
import { Button } from '@trailmark/ui/components/ui/button';
import { cn } from '@trailmark/ui/lib/utils';
import { ArrowRightIcon, CheckCircle2Icon, KeyRoundIcon, Loader2Icon, SendIcon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api/client';
import { errorMessage } from '@/lib/api/errors';
import { keys, projectQuery } from '@/lib/api/queries';
import { eventSentence } from '@/lib/events';
import { formatTime } from '@/lib/format';
import { peekSecret } from '@/lib/one-time-secrets';
import { curlSnippet, SDK_INSTALL, sdkSnippet } from '@/lib/snippets';

export const Route = createFileRoute('/_authed/onboarding/first-event/$projectId')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(projectQuery(params.projectId)),
  component: FirstEventStep,
});

function FirstEventStep() {
  const { projectId } = Route.useParams();
  const project = Route.useLoaderData();
  const queryClient = useQueryClient();
  const [secret] = useState(() => peekSecret(projectId));
  const [since] = useState(() => new Date(Date.parse(project.createdAt) - 1000).toISOString());
  const [received, setReceived] = useState<AuditEvent | null>(null);

  // Poll the live tail until the first event lands, then stop.
  useQuery({
    queryKey: [...keys.project(projectId), 'first-event', since],
    queryFn: async ({ signal }) => {
      const res = await api.events.live(projectId, { since, limit: 1 }, signal);
      const first = res.data.at(-1) ?? res.data[0];
      if (first && !received) {
        setReceived(first);
        queryClient.invalidateQueries({ queryKey: keys.project(projectId) });
      }
      return res;
    },
    refetchInterval: received ? false : 2000,
    refetchIntervalInBackground: true,
  });

  const test = useMutation({
    mutationFn: () => api.events.testEvent(projectId),
    onSuccess: () => toast.success('Test event accepted', { description: 'It should appear below within a few seconds.' }),
    onError: (error) => toast.error('Could not send the test event', { description: errorMessage(error) }),
  });

  const key = secret ?? 'tm_ingest_••••••••';

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Send your first event to {project.name}</h1>
        <p className="text-muted-foreground text-sm">Any JSON object with an action is a valid event. Start small — you can enrich it later.</p>
      </div>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-xs">
        <div className="flex items-center gap-2">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          <h2 className="font-medium text-sm">Ingest key</h2>
        </div>
        {secret ? (
          <>
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 py-1.5 ps-3 pe-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{secret}</code>
              <CopyButton label="Copy key" showLabel value={secret} variant="outline" />
            </div>
            <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
              <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-outcome-denied" />
              This is the only time the full key is shown. Store it in your secrets manager — Trailmark keeps only a hash.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">
            The key was shown when the project was created and is no longer available. Create a fresh one in{' '}
            <Link className="font-medium text-foreground underline underline-offset-2" params={{ projectId }} to="/p/$projectId/settings/keys">
              Settings → API keys
            </Link>
            .
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-sm">1 · Install the SDK</h2>
        <CodeBlock code={SDK_INSTALL} language="bash" />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-sm">2 · Send an event</h2>
        <CodeTabs
          tabs={[
            { id: 'sdk', label: 'TypeScript', code: sdkSnippet(key), language: 'ts' },
            { id: 'curl', label: 'curl', code: curlSnippet(key), language: 'bash' },
          ]}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-sm">3 · Watch it arrive</h2>
        <div
          aria-live="polite"
          className={cn(
            'flex flex-col gap-4 rounded-xl border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between',
            received ? 'border-outcome-success/30 bg-outcome-success/5' : 'border-dashed bg-card',
          )}
        >
          {received ? (
            <div className="flex min-w-0 items-start gap-3">
              <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-outcome-success" />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium text-sm">First event received</p>
                <p className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
                  <OutcomeDot outcome={received.outcome} />
                  <span className="truncate">{eventSentence(received)}</span>
                </p>
                <p className="font-mono text-muted-foreground text-xs">
                  {received.action} · {formatTime(received.timestamp)}
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="relative flex size-3">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/50" />
                <span className="relative inline-flex size-3 rounded-full bg-brand" />
              </span>
              <div className="flex flex-col">
                <p className="font-medium text-sm">Listening for your first event…</p>
                <p className="text-muted-foreground text-xs">Run one of the snippets above, or send a test event from here.</p>
              </div>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {received ? (
              <Button nativeButton={false} render={<Link params={{ projectId }} to="/p/$projectId" />}>
                Open overview
                <ArrowRightIcon />
              </Button>
            ) : (
              <Button disabled={test.isPending} onClick={() => test.mutate()} variant="outline">
                {test.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
                Send a test event
              </Button>
            )}
          </div>
        </div>
        {received ? null : (
          <Link className="self-start text-muted-foreground text-sm hover:text-foreground" params={{ projectId }} to="/p/$projectId">
            Skip for now — go to the console
          </Link>
        )}
      </section>
    </div>
  );
}
