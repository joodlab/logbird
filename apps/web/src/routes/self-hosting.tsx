import { createFileRoute } from '@tanstack/react-router';
import { ButtonLink } from '../components/marketing/button-link';
import { SiteCode } from '../components/marketing/code';
import { CtaBand } from '../components/marketing/cta-band';
import { FeatureRow } from '../components/marketing/feature-row';
import { PageHero, Section, SectionHeader } from '../components/marketing/section';
import { SelfHostCta } from '../components/marketing/self-host-cta';
import { Steps } from '../components/marketing/steps';
import { GITHUB_PUBLIC } from '../env';
import { CLOUD_OPEN } from '../lib/cloud';
import { IMAGE_NAMESPACE, repoFile, SELF_HOST_VERSION, selfHostQuickstart } from '../lib/selfhost';
import { pageHead } from '../lib/seo';

export const Route = createFileRoute('/self-hosting')({ head: () => pageHead('/self-hosting'), component: SelfHostingPage });

// Copy: marketing/copy/self-hosting.md. Commands are checked against docs/self-hosting.md and docs/coolify.md.

const firstEvent = `curl http://localhost:4600/v1/events \\
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"document.updated"}'`;

const tls = `# .env
APP_URL=https://audit.example.com
LOGBIRD_DOMAIN=audit.example.com
TRUST_PROXY=2

docker compose --profile tls up -d`;

/** One container stack as a small diagram: the shaded boxes run inside Compose, dashed ones are yours. */
function Stack({ title, file, inside, outside, proxy }: { title: string; file: string; inside: string[]; outside?: string[]; proxy?: string }) {
  return (
    <figure className="flex flex-col gap-3">
      {proxy ? <div className="rounded-lg border border-dashed px-3 py-2 text-center text-muted-foreground text-xs">{proxy}</div> : null}
      <div className="rounded-xl border bg-[var(--surface-sunken)] p-3">
        <p className="mb-2 font-mono text-[11px] text-muted-foreground">{file}</p>
        <div className="grid grid-cols-2 gap-2">
          {inside.map((service) => (
            <span
              className="rounded-md border bg-[var(--surface)] px-2.5 py-1.5 text-center font-mono text-xs data-[accent=true]:border-brand/60"
              data-accent={service === 'console'}
              key={service}
            >
              {service}
            </span>
          ))}
        </div>
      </div>
      {outside ? (
        <div className="grid grid-cols-3 gap-2">
          {outside.map((service) => (
            <span className="rounded-md border border-dashed px-2 py-1.5 text-center font-mono text-[11px] text-muted-foreground" key={service}>
              {service}
            </span>
          ))}
        </div>
      ) : null}
      <figcaption className="sr-only">{title}</figcaption>
    </figure>
  );
}

function SelfHostingPage() {
  return (
    <>
      <PageHero
        actions={
          <>
            {GITHUB_PUBLIC ? (
              <ButtonLink href="#quickstart" size="lg">
                Quickstart
              </ButtonLink>
            ) : (
              <ButtonLink search={{ interest: 'self-host' }} size="lg" to="/contact">
                Tell me when the source opens
              </ButtonLink>
            )}
            <ButtonLink size="lg" to="/contact" variant="outline">
              {CLOUD_OPEN ? 'Request Cloud access' : 'Join the Cloud waitlist'}
            </ButtonLink>
          </>
        }
        aside={
          <div className="flex flex-col gap-3">
            <Stack
              file="docker-compose.yml"
              inside={['console', 'api', 'worker', 'postgres', 'clickhouse', 'redis']}
              title="One Compose project runs the console, API, worker, Postgres, ClickHouse and Redis."
            />
            <p className="text-muted-foreground text-sm">
              {GITHUB_PUBLIC
                ? `Compose pulls the published ${SELF_HOST_VERSION} images for amd64 and arm64 from ${IMAGE_NAMESPACE}.`
                : 'Source on GitHub — coming soon. Self-hosting builds from source; no images are published yet.'}
            </p>
          </div>
        }
        eyebrow="Self-hosting"
        lead={`Logbird is MIT-licensed and self-hosts with Docker Compose. Run it on one VM and your events stay on your own servers. It's the same codebase Logbird Cloud ${CLOUD_OPEN ? 'runs' : 'will run'}.`}
        title="Your audit log, on your servers."
      />

      {GITHUB_PUBLIC ? (
        <Section id="quickstart" labelledBy="quickstart-title">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="flex flex-col gap-8">
              <SectionHeader
                eyebrow="Quickstart"
                id="quickstart-title"
                lead="You need Docker Engine and Docker Compose 2.24.4 or newer. Compose pulls four published images; nothing is compiled on your server."
                title="From clone to your first event."
              />
              <ol className="flex flex-col gap-4 text-sm leading-relaxed">
                {[
                  <>
                    Open <code>http://localhost:4600</code> and sign in with the code sent to your email.
                  </>,
                  "Create a workspace and a project. Copy the ingest key; it's shown once.",
                  'Send an event with the request on the right.',
                  <>
                    Expect <code>202</code>, and the event in the explorer.
                  </>,
                ].map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static steps
                  <li className="flex gap-4" key={index}>
                    <span
                      aria-hidden="true"
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-xs"
                    >
                      {index + 1}
                    </span>
                    <span className="pt-1 text-muted-foreground">{step}</span>
                  </li>
                ))}
              </ol>
              <ul className="flex flex-col gap-2 border-t pt-6 text-muted-foreground text-sm leading-relaxed">
                <li>The init script generates the secrets it needs and never overwrites values you've set.</li>
                <li>
                  Need unreleased code or a custom build? The{' '}
                  <a className="text-link" href={`${repoFile('docs/self-hosting.md')}#build-from-source`}>
                    self-hosting guide
                  </a>{' '}
                  covers building from source, every setting, TLS, backups and restores.
                </li>
                <li>
                  <code>/livez</code> checks the API process; <code>/readyz</code> checks Postgres, ClickHouse and Redis.
                </li>
              </ul>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <SiteCode code={selfHostQuickstart} language="bash" title="On your server" />
              <SiteCode code={firstEvent} language="bash" title="Your first event" />
            </div>
          </div>
        </Section>
      ) : (
        <Section id="quickstart" labelledBy="quickstart-title">
          <div className="panel flex flex-col gap-4 p-8 md:p-10">
            <p className="eyebrow">Quickstart</p>
            <h2 className="h2" id="quickstart-title">
              The quickstart is published when the repository opens.
            </h2>
            <p className="lead max-w-3xl">
              On one VM: clone the repository, generate secrets, configure SMTP, build the four roles one at a time, start them with{' '}
              <code>docker compose up -d --no-build</code> and send your first event. You need Docker Engine and Docker Compose 2.24.4 or newer.
              Self-hosting builds from source; no images are published yet.
            </p>
            <div>
              <SelfHostCta size="default" variant="outline" />
            </div>
          </div>
        </Section>
      )}

      <Section compact id="requirements" labelledBy="requirements-title" tone="sunken">
        <SectionHeader eyebrow="Requirements" id="requirements-title" title="What you need." />
        <dl className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[
            ['Host', 'A Linux host, or any machine that runs Linux containers, with Docker Engine and Compose 2.24.4 or newer.'],
            ['Email', 'An SMTP provider for sign-in codes and invitations, for example Amazon SES, Postmark or Brevo.'],
            ['HTTPS', 'A domain and ports 80 and 443 if you want automatic HTTPS.'],
            [
              'Starting size',
              '4 vCPU, 8 GB RAM and SSD storage. That is an initial allocation, not measured capacity. Leave disk for images as well as your data, ClickHouse merges and backups; building from source needs more headroom still.',
            ],
            [
              'Access',
              'Sign-up is open by default: anyone who can reach the console can create an account. On an internet-facing instance, set AUTH_SIGNUP=restricted with your email domains; invitations keep working.',
            ],
          ].map(([term, detail]) => (
            <div className="panel flex flex-col gap-2 p-5" key={term}>
              <dt className="font-semibold">{term}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{detail}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section compact id="options" labelledBy="options-title">
        <SectionHeader eyebrow="Ways to run it" id="options-title" title="Pick the setup that fits what you already run." />
        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {[
            {
              title: 'Bundled Compose',
              body: (
                <>
                  One Compose project runs Postgres, ClickHouse, Redis, the API, the worker and the console. Only the console port is published, on{' '}
                  <code>127.0.0.1</code> by default. A one-off migration step runs before the API and worker start.
                </>
              ),
              stack: (
                <Stack
                  file="docker-compose.yml"
                  inside={['console', 'api', 'worker', 'postgres', 'clickhouse', 'redis']}
                  title="Bundled Compose stack"
                />
              ),
            },
            {
              title: 'Coolify',
              body: (
                <>
                  Point Coolify's Docker Compose build pack at <code>docker-compose.coolify.yml</code>. Coolify generates the secrets, pulls the
                  published images and routes your domain to the console.
                </>
              ),
              stack: (
                <Stack
                  file="docker-compose.coolify.yml"
                  inside={['console', 'api', 'worker', 'postgres', 'clickhouse', 'redis']}
                  proxy="Coolify proxy → your domain"
                  title="The same stack behind Coolify's proxy"
                />
              ),
            },
            {
              title: 'Bring your own databases',
              body: (
                <>
                  Use your own Postgres, ClickHouse and Redis (or Dragonfly) with <code>docker-compose.external.yml</code>. Use ClickHouse 26.9.
                  Logbird creates its own restricted query user and row policies.
                </>
              ),
              stack: (
                <Stack
                  file="docker-compose.external.yml"
                  inside={['console', 'api', 'worker', 'migrate']}
                  outside={['postgres', 'clickhouse', 'redis']}
                  title="Logbird services in Compose, databases you run"
                />
              ),
            },
          ].map((option) => (
            <section aria-label={option.title} className="panel flex flex-col gap-5 p-6" key={option.title}>
              {option.stack}
              <h3 className="h3">{option.title}</h3>
              <p className="body-copy text-muted-foreground text-sm leading-relaxed">{option.body}</p>
            </section>
          ))}
        </div>
        <p className="mt-6 border-s-2 ps-3 text-muted-foreground text-sm">
          {GITHUB_PUBLIC ? (
            <>
              Step by step in the{' '}
              <a className="text-link" href={repoFile('docs/coolify.md')}>
                Coolify guide
              </a>
              .{' '}
            </>
          ) : null}
          Upgrades and restores through Coolify are documented but not yet verified end to end.
        </p>
      </Section>

      <FeatureRow
        eyebrow="HTTPS"
        id="tls"
        limit="Never expose the API server's own port. Everything goes through the console origin."
        title="Automatic HTTPS, or the proxy you already run."
        visual={<SiteCode code={tls} language="bash" title="Caddy, built in" />}
      >
        Set your domain in <code>.env</code> and run <code>docker compose --profile tls up -d</code>. Caddy gets and renews the certificate. Already
        run Nginx, Traefik or another proxy? Forward the whole origin to port 4600 and tell Logbird how many proxies sit in front, so rate limits and
        audit context see the real client address.
      </FeatureRow>

      <Section compact labelledBy="ops-title" tone="sunken">
        <h2 className="sr-only" id="ops-title">
          Operating Logbird
        </h2>
        <div className="grid gap-12 lg:grid-cols-2">
          <section aria-labelledby="smtp-title" className="flex flex-col gap-4" id="smtp">
            <p className="eyebrow">Email</p>
            <h3 className="h2" id="smtp-title">
              Sign-in is by emailed code.
            </h3>
            <p className="body-copy text-muted-foreground leading-relaxed">
              Logbird has no passwords. People sign in with a one-time code sent by email, so configure an SMTP provider. For a first local test you
              can log sign-in codes to the server log instead. Turn that off once SMTP works: anyone who can read the logs can sign in.
            </p>
          </section>
          <section aria-labelledby="upgrades-title" className="flex flex-col gap-6" id="upgrades">
            <p className="eyebrow">Upgrades and backups</p>
            <h3 className="h2" id="upgrades-title">
              Upgrade to a pinned release, after a backup.
            </h3>
            <Steps
              items={[
                { title: 'Stop writes', body: 'Block ingress and stop the console, server and worker; the worker finishes its current job first.' },
                {
                  title: 'Back up',
                  body: 'With writers stopped: matched Postgres (pg_dump) and ClickHouse (BACKUP DATABASE) backups and a SHA-256 checksum file. Keep the original .env; record the release version and image digests.',
                },
                { title: 'Pin the new version', body: 'Check out the new release tag; its Compose file pins the matching images.' },
                {
                  title: 'Pull, then start',
                  body: "docker compose pull, then docker compose up -d --no-build. Migrations run first; if one fails, the new version doesn't start.",
                },
                { title: 'Verify', body: 'Readiness, sign-in, your events, settings and keys, and the retention runs, before you reopen ingress.' },
              ]}
              vertical
            />
            <ul className="flex flex-col gap-2 border-t pt-5 text-muted-foreground text-sm leading-relaxed">
              <li>
                <code>docker compose down</code> keeps your data. <code>docker compose down -v</code> deletes it, permanently.
              </li>
              <li>Restore into empty, separate storage first, and check counts before you switch over.</li>
            </ul>
          </section>
        </div>
      </Section>

      <Section compact id="not-yet" labelledBy="not-yet-title">
        <SectionHeader eyebrow="Not there yet" id="not-yet-title" title="What self-hosting doesn't include today." />
        <dl className="mt-10 grid gap-x-10 gap-y-2 md:grid-cols-2">
          {[
            ['High availability', 'The Compose setup is a single VM. It has no failover.'],
            ['Published capacity numbers', "We haven't published load-test results yet. Size from your own measurements."],
            ['SSO', 'Sign-in is by emailed code only. SSO is on the roadmap.'],
          ].map(([term, detail]) => (
            <div className="flex flex-col gap-1 border-b py-4" key={term}>
              <dt className="font-medium">{term}</dt>
              <dd className="text-muted-foreground text-sm leading-relaxed">{detail}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <CtaBand
        body={
          CLOUD_OPEN
            ? "Logbird Cloud runs the same codebase for you. It's in early access, with sign-ups limited to invited teams."
            : "Logbird Cloud will run the same codebase for you. It isn't open yet."
        }
        title="Rather not run it yourself?"
      />
    </>
  );
}
