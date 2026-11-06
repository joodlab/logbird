import { Button } from '@logbird/ui/components/ui/button';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, KeyRoundIcon, SendIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NotFound } from '@/components/not-found';
import { ApiKeyStep } from '@/components/setup/api-key-step';
import { FIRST_EVENT_POLL_MS, FirstEventPanel } from '@/components/setup/first-event-panel';
import { ApiRequestError } from '@/lib/api/errors';
import { projectQuery, projectSetupQuery } from '@/lib/api/queries';
import { skipFirstEvent } from '@/lib/onboarding';
import { ensureActiveWorkspace } from '@/lib/session';

export const Route = createFileRoute('/_authed/onboarding/first-event/$projectId')({
  head: () => ({ meta: [{ title: 'Send your first event · Logbird' }] }),
  beforeLoad: async ({ context }) => ({ me: await ensureActiveWorkspace(context.queryClient, context.me) }),
  loader: async ({ context, params }) => {
    try {
      context.queryClient.prefetchQuery(projectSetupQuery(params.projectId, { pollUntilFirstEvent: FIRST_EVENT_POLL_MS }));
      return await context.queryClient.ensureQueryData(projectQuery(params.projectId));
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) throw notFound();
      throw error;
    }
  },
  notFoundComponent: () => <NotFound description="This project does not exist in your workspace, or it was deleted." title="Project not found" />,
  component: FirstEventStep,
});

function FirstEventStep() {
  const { projectId } = Route.useParams();
  const project = Route.useLoaderData();
  const navigate = useNavigate();
  const setup = useQuery(projectSetupQuery(projectId, { pollUntilFirstEvent: FIRST_EVENT_POLL_MS }));
  const received = Boolean(setup.data?.ingest.firstEventAt);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight">Send your first event to {project.name}</h1>
        <p className="text-muted-foreground text-sm">
          Any JSON object with an <span className="font-mono text-foreground">action</span> is a valid event. Start small — you can enrich it later
          from the Setup page.
        </p>
      </div>

      <Step icon={KeyRoundIcon} n={1} title="Your ingest key">
        <ApiKeyStep kind="ingest" projectId={projectId} />
      </Step>

      <Step icon={SendIcon} n={2} title="Send an event and watch it arrive">
        <FirstEventPanel projectId={projectId} />
      </Step>

      <div className="flex flex-col-reverse items-start gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        {received ? (
          <p className="text-muted-foreground text-sm">Next: the overview fills in, and Setup lists what to add for a production-grade trail.</p>
        ) : (
          <Button
            className="text-muted-foreground"
            data-testid="skip-first-event"
            onClick={() => {
              skipFirstEvent(projectId);
              navigate({ to: '/p/$projectId', params: { projectId } });
            }}
            variant="ghost"
          >
            Skip for now
          </Button>
        )}
        <Button
          disabled={!received}
          onClick={() => navigate({ to: '/p/$projectId', params: { projectId } })}
          title={received ? undefined : 'Waiting for the first event'}
        >
          Continue to overview
          <ArrowRightIcon />
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, icon: Icon, children }: { n: number; title: string; icon: typeof KeyRoundIcon; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-medium text-sm">
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground tabular-nums">{n} ·</span> {title}
      </h2>
      {children}
    </section>
  );
}
