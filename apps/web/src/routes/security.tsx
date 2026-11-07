import { createFileRoute } from '@tanstack/react-router';
import {
  ArrowLeftRightIcon,
  ArrowRightIcon,
  BadgeXIcon,
  BanIcon,
  Building2Icon,
  GaugeIcon,
  HashIcon,
  KeyRoundIcon,
  MailIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonLink } from '../components/marketing/button-link';
import { Callout } from '../components/marketing/callout';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { Feature, PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SecurityContact } from '../components/marketing/security-contact';
import { Steps } from '../components/marketing/steps';
import { GITHUB_PUBLIC, SECURITY_EMAIL } from '../env';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/security')({ head: () => pageHead('/security'), component: SecurityPage });

// Copy: marketing/copy/security.md. Change wording there first. No certifications, no claims about Cloud-side logging.
const contents = [
  { id: 'self-host', label: 'Where data lives' },
  { id: 'retention', label: 'Retention' },
  { id: 'isolation', label: 'Projects and keys' },
  { id: 'sql-guard', label: 'SQL mode' },
  { id: 'roles', label: 'Roles' },
  { id: 'impersonation', label: 'Impersonation' },
  { id: 'self-audit', label: 'Workspace activity' },
  { id: 'limits', label: 'Rate limits and delivery' },
  { id: 'reporting', label: 'Responsible disclosure' },
  { id: 'dont-claim', label: "What we don't claim" },
];

const impersonationSample = `{
  "action": "room.rate.updated",
  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad", "email": "lina@example.test" },
  "impersonator": { "id": "usr_7", "name": "Omar Saleh" },
  "tenant": { "id": "biz_7", "name": "Azure Hotels" },
  "targets": [{ "type": "room", "id": "room_12", "name": "Room 12" }]
}`;

const activity = ['project.created', 'api_key.created', 'api_key.revoked', 'project.retention.changed'];

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="body-copy flex flex-col gap-4 leading-relaxed">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list, never reorders
        <li className="flex gap-3" key={index}>
          <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function OnThisPage() {
  return (
    <nav aria-label="On this page" className="panel p-5 md:p-6">
      <p className="eyebrow mb-3">On this page</p>
      <ol className="grid gap-x-6 sm:grid-cols-2">
        {contents.map((item) => (
          <li key={item.id}>
            <a
              className="flex min-h-11 items-center border-b text-muted-foreground text-sm no-underline transition-colors hover:text-foreground"
              href={`#${item.id}`}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SelfHostDiagram() {
  const parts = ['Console', 'API', 'Worker', 'Postgres', 'ClickHouse', 'Redis'];
  return (
    <figure className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,14rem)] md:items-center lg:grid-cols-1">
        <div className="rounded-2xl border-2 border-brand/40 border-dashed p-4 md:p-5">
          <p className="mb-3 font-mono text-muted-foreground text-xs uppercase tracking-wider">Your server</p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {parts.map((part) => (
              <li className="panel px-3 py-2.5 font-medium text-sm" key={part}>
                {part}
              </li>
            ))}
          </ul>
        </div>
        <div aria-hidden="true" className="flex items-center gap-2 self-center px-2 text-muted-foreground text-xs max-md:flex-col lg:flex-col">
          <span className="max-md:order-2 lg:order-2">sign-in codes, invitations</span>
          <ArrowRightIcon className="size-4 max-md:rotate-90 lg:rotate-90" />
        </div>
        <div className="panel flex items-center gap-3 px-4 py-3">
          <MailIcon aria-hidden="true" className="size-4 shrink-0 text-brand" />
          <span className="font-medium text-sm">Your SMTP provider</span>
        </div>
      </div>
      <figcaption className="text-muted-foreground text-sm">
        Self-hosted: the console, API, worker, Postgres, ClickHouse and Redis all run on your server. The server's only outbound connection is to your
        SMTP provider, for sign-in codes and invitations.
      </figcaption>
    </figure>
  );
}

function SecurityPage() {
  return (
    <>
      <PageHero
        aside={<OnThisPage />}
        eyebrow="Security"
        lead={
          <>
            An audit log holds sensitive history, so this page says what Logbird does with it and where each protection stops.
            {GITHUB_PUBLIC ? (
              <>
                {' '}
                The repository's <code>SECURITY.md</code> and <code>docs/SPEC.md</code> have the details.
              </>
            ) : null}
          </>
        }
        title="How Logbird handles your data."
      />

      <Section id="self-host" labelledBy="self-host-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-center">
          <SectionHeader
            eyebrow="Where data lives"
            id="self-host-title"
            lead="When you self-host, events are stored in your own ClickHouse, and workspaces, projects and keys in your own Postgres. The self-hosted software doesn't send usage data back to us. The server's only outbound connection is to the SMTP provider you choose, which delivers sign-in codes and invitations."
            title="Self-hosted, your events stay on your servers."
          />
          <SelfHostDiagram />
        </div>
      </Section>

      <Section id="retention" labelledBy="retention-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow="Retention" id="retention-title" title="Expired events are permanently deleted." />
          <Bullets
            items={[
              'Each project has a retention window, from 7 days to 10 years. New projects start at 90 days.',
              'A worker deletes events older than the window every hour. Each run is recorded and shown in Settings.',
              "Before you lower retention, Logbird shows roughly how many events it will delete. To confirm, you type the project's slug. The purge starts immediately.",
              'Deleting a project deletes all of its events.',
              <strong className="font-semibold" key="undo">
                There's no archive and no undo.
              </strong>,
            ]}
          />
        </div>
      </Section>

      <Section id="isolation" labelledBy="isolation-title">
        <SectionHeader eyebrow="Projects and keys" id="isolation-title" title="Every key belongs to one project and does one job." />
        <div className="mt-12 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          <Feature icon={<KeyRoundIcon className="size-4" />} title="Project-bound keys">
            An API key works for exactly one project.
          </Feature>
          <Feature icon={<ArrowLeftRightIcon className="size-4" />} title="Two kinds">
            Ingest keys (<code>lb_ingest_...</code>) can only write. Read keys (<code>lb_read_...</code>) can only read.
          </Feature>
          <Feature icon={<HashIcon className="size-4" />} title="Stored hashed">
            Logbird keeps a SHA-256 hash and a short display prefix. The full key is shown once, when you create it.
          </Feature>
          <Feature icon={<BanIcon className="size-4" />} title="Revocable">
            Revoke a key in Settings; the console shows when each key was last used.
          </Feature>
          <Feature icon={<Building2Icon className="size-4" />} title="Workspace boundaries">
            The server checks on every request that the project belongs to your active workspace. A request for another workspace's project gets a 404
            and reveals nothing about it.
          </Feature>
        </div>
      </Section>

      <Section id="sql-guard" labelledBy="sql-guard-title" tone="sunken">
        <SectionHeader
          eyebrow="SQL mode"
          id="sql-guard-title"
          lead={
            <>
              SQL mode accepts a single boolean <code>WHERE</code> expression. Four layers stand between it and other people's data.
            </>
          }
          title="SQL search that can only read your project."
        />
        <div className="mt-12 flex flex-col gap-10">
          <Steps
            items={[
              {
                title: "Checked against ClickHouse's own parse",
                body: "The server asks ClickHouse for the statement's syntax tree. It rejects anything that isn't exactly Logbird's own query with your condition in it.",
              },
              {
                title: 'Allowlisted',
                body: (
                  <>
                    Only known columns and a fixed list of functions may appear. Subqueries, <code>UNION</code>, <code>WITH</code>,{' '}
                    <code>SETTINGS</code>, table functions, system tables, comments and semicolons are rejected.
                  </>
                ),
              },
              {
                title: 'A restricted user',
                body: (
                  <>
                    Queries run as a separate read-only ClickHouse user. It can only <code>SELECT</code>, and it has fixed ceilings on time, rows
                    read, memory and result size.
                  </>
                ),
              },
              {
                title: 'Row policies',
                body: (
                  <>
                    Database row policies limit that user to the project you're authorized for. Even <code>1 OR 1</code> can't return another
                    project's rows.
                  </>
                ),
              },
            ]}
          />
          <Callout icon={<ShieldAlertIcon className="size-5" />} title="Where these layers stop">
            These layers protect against a broadened or malformed filter. They don't replace the server's own authorization, and they don't protect
            against stolen database credentials. SQL mode is for the console only; the public API rejects it.
          </Callout>
        </div>
      </Section>

      <Section id="roles" labelledBy="roles-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-start">
          <SectionHeader
            eyebrow="Roles"
            id="roles-title"
            lead="Owners and admins manage projects, keys, retention and invitations. Members search, export, save views and read workspace activity. Any action that isn't explicitly allowed is denied, for every role. The UI hides what you can't do, but the API is what enforces it."
            title="Permissions are checked by the server."
          />
          <div className="grid gap-6 lg:pt-10">
            <Feature compact icon={<MailIcon className="size-4" />} title="One-time sign-in codes">
              Sign-in is by a one-time code sent by email. There are no passwords to leak.
            </Feature>
            <Feature compact icon={<GaugeIcon className="size-4" />} title="Rate-limited sign-in">
              Sign-in requests are rate-limited per client.
            </Feature>
          </div>
        </div>
      </Section>

      <Section id="impersonation" labelledBy="impersonation-title" tone="sunken">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:items-center">
          <SectionHeader
            eyebrow="Impersonation"
            id="impersonation-title"
            lead={
              <>
                Send the staff member as <code>impersonator</code> and keep the customer as <code>actor</code>. The event detail shows both. Search{' '}
                <code>impersonator:*</code> to list every event done on someone's behalf.
              </>
            }
            title="When staff act for a customer, both names are recorded."
          />
          <div className="flex min-w-0 flex-col gap-3">
            <SiteCode code={impersonationSample} language="json" title="Support changes a rate for Lina" />
            <p className="text-muted-foreground text-sm">Lina stays the actor. Omar, from support, is on the event as the impersonator.</p>
          </div>
        </div>
      </Section>

      <Section id="self-audit" labelledBy="self-audit-title">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
          <SectionHeader
            eyebrow="Workspace activity"
            id="self-audit-title"
            lead="Creating a project, creating or revoking a key, changing retention, inviting a member: each of these is recorded as an event in your workspace's activity stream. Every member can read it."
            title="Logbird audits its own management actions."
          />
          <figure className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {activity.map((action, index) => (
                <li className="log-row" data-newest={index === 0} key={action}>
                  <span aria-hidden="true" className="log-dot bg-outcome-success" />
                  <span className="truncate">{action}</span>
                  <span className="text-muted-foreground text-xs">workspace</span>
                </li>
              ))}
            </ul>
            <figcaption className="text-muted-foreground text-sm">Examples of management actions in the activity stream.</figcaption>
          </figure>
        </div>
      </Section>

      <Section id="limits" labelledBy="limits-title" tone="sunken">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start">
          <SectionHeader eyebrow="Rate limits and delivery" id="limits-title" title="Bounded by design." />
          <Bullets
            items={[
              'Each project has its own ingest and read rate limits, shared across replicas through Redis.',
              'Failed authentication attempts are limited per client, so repeated bad keys are throttled. Valid keys keep working behind a shared network address.',
              'If Redis fails, sign-in limits fail closed (requests are refused) and ingest and read limits fail open (requests continue).',
              'Delivery is at least once. A retry can store an event twice, so counts may include duplicates.',
              <>
                Don't send secrets. The SDK's <code>redact()</code> helper replaces common secret fields before sending.
              </>,
            ]}
          />
        </div>
      </Section>

      <Section id="reporting" labelledBy="reporting-title">
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="panel flex flex-col gap-5 p-6 md:p-8">
            <SectionHeader eyebrow="Responsible disclosure" id="reporting-title" title="Report a vulnerability privately." />
            <p className="text-muted-foreground leading-relaxed">
              Please don't post details in a public issue. <SecurityContact /> Include the affected version, a reproduction using fictional data, and
              the impact. We'll coordinate the fix and the disclosure with you. We don't offer a response-time SLA yet.
            </p>
            {SECURITY_EMAIL ? (
              <div className="mt-auto pt-2">
                <ButtonLink href={`mailto:${SECURITY_EMAIL}`} variant="outline">
                  <MailIcon aria-hidden="true" className="size-4" />
                  Email {SECURITY_EMAIL}
                </ButtonLink>
              </div>
            ) : null}
          </div>
          <section aria-labelledby="dont-claim-title" className="panel flex flex-col gap-5 p-6 md:p-8" id="dont-claim">
            <p className="eyebrow">What we don't claim</p>
            <h2 className="h2 flex items-center gap-3" id="dont-claim-title">
              <BadgeXIcon aria-hidden="true" className="size-7 shrink-0 text-muted-foreground" />
              No certifications yet.
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Logbird doesn't hold SOC 2, ISO 27001 or any other certification today, and we don't claim that using it makes you compliant with any
              law or standard. Logbird can help you answer an auditor's questions: who did what, when, in which account, and what changed. The rest of
              the work is yours, and we'll say so plainly.
            </p>
          </section>
        </div>
      </Section>

      <CtaBand />
    </>
  );
}
