import { repoFile, SELF_HOST_VERSION } from '../lib/selfhost';
import { byCloud, byRepo, SITE } from './site';

/**
 * Words and samples of /self-hosting. Brief: marketing/copy/self-hosting.md. Commands are checked against
 * docs/self-hosting.md and docs/coolify.md; the quickstart script is lib/selfhost.ts (`selfHostQuickstart`). Inline
 * marks: `code` (components/marketing/rich.tsx). Sentences that hold a link are split into parts around it.
 */
const firstEvent = `curl http://localhost:4600/v1/events \\
  -H "Authorization: Bearer $LOGBIRD_INGEST_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"action":"document.updated"}'`;

const tls = `# .env
APP_URL=https://audit.example.com
LOGBIRD_DOMAIN=audit.example.com
TRUST_PROXY=2

docker compose --profile tls up -d`;

const buildFromSourceHref = `${repoFile('docs/self-hosting.md')}#build-from-source`;

export const selfHosting = {
  samples: { firstEvent, tls },
  hero: {
    eyebrow: 'Self-hosting',
    title: 'Your audit log, on your servers.',
    lead: `Logbird is MIT-licensed and self-hosts with Docker Compose. Run it on one VM and your events stay on your own servers. It's the same codebase Logbird Cloud ${byCloud(SITE, { open: 'runs', closed: 'will run' })}.`,
    quickstartAction: 'Quickstart',
    notifyAction: 'Tell me when the source opens',
    cloudAction: byCloud(SITE, { open: 'Request Cloud access', closed: 'Join the Cloud waitlist' }),
    stackTitle: 'One Compose project runs the console, API, worker, Postgres, ClickHouse and Redis.',
    status: byRepo(SITE, {
      public: SELF_HOST_VERSION
        ? `Compose pulls the published ${SELF_HOST_VERSION} images for amd64 and arm64 from GHCR.`
        : 'Nothing has been released yet.',
      private: 'Source on GitHub — coming soon.',
    }),
  },
  quickstart: {
    eyebrow: 'Quickstart',
    title: 'From clone to your first event.',
    lead: 'You need Docker Engine and Docker Compose 2.24.4 or newer. Compose pulls the four published Logbird role images; nothing is compiled on your server.',
    steps: [
      'Open `http://localhost:4600` and sign in with the code sent to your email, or printed in the server log if you set `AUTH_LOG_SIGN_IN_CODES=true`.',
      "Create a workspace and a project. Copy the ingest key; it's shown once.",
      'Set LOGBIRD_INGEST_KEY to the key you just copied, and send an event with the request on the right.',
      'Expect `202`, and the event in the explorer.',
    ],
    notes: {
      init: "The init script generates the secrets it needs and never overwrites values you've set.",
      guide: {
        before: 'Need unreleased code or a custom build? The ',
        label: 'self-hosting guide',
        href: buildFromSourceHref,
        after: ' covers building from source, every setting, TLS, backups and restores.',
      },
      health: '`/livez` checks the API process; `/readyz` checks Postgres, ClickHouse and Redis.',
    },
    serverTitle: 'On your server',
    eventTitle: 'Your first event',
    /** Shown instead of the quickstart until the repository is public and a release is published. */
    pending: {
      title: byRepo(SITE, { public: 'Nothing has been released yet.', private: 'The quickstart is published when the repository opens.' }),
      lead: byRepo(SITE, {
        public:
          'There are no published images yet. Build the four roles from source, start them, then sign in and send your first event. You need Docker Engine and Docker Compose 2.24.4 or newer.',
        private:
          'On one VM: clone the repository, generate secrets, configure SMTP, start Logbird with Docker Compose and send your first event. You need Docker Engine and Docker Compose 2.24.4 or newer.',
      }),
      buildLink: { label: 'Build from source (self-hosting guide)', href: buildFromSourceHref },
    },
  },
  requirements: {
    eyebrow: 'Requirements',
    title: 'What you need.',
    items: [
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
    ],
  },
  options: {
    eyebrow: 'Ways to run it',
    title: 'Pick the setup that fits what you already run.',
    bundled: {
      title: 'Bundled Compose',
      body: 'One Compose project runs Postgres, ClickHouse, Redis, the API, the worker and the console. Only the console port is published, on `127.0.0.1` by default. A one-off migration step runs before the API and worker start.',
      stackTitle: 'Bundled Compose stack',
    },
    coolify: {
      title: 'Coolify',
      body: `Point Coolify's Docker Compose build pack at \`docker-compose.coolify.yml\`. Coolify generates the secrets, ${
        SELF_HOST_VERSION ? 'pulls the published images' : 'builds the images once you add docker-compose.build.yml (see the Coolify guide)'
      } and routes your domain to the console.`,
      proxy: 'Coolify proxy → your domain',
      stackTitle: "The same stack behind Coolify's proxy",
    },
    external: {
      title: 'Bring your own databases',
      body: 'Use your own Postgres, ClickHouse and Redis (or Dragonfly) with `docker-compose.external.yml`. Use ClickHouse 26.9. Logbird creates its own restricted query user and row policies.',
      stackTitle: 'Logbird services in Compose, databases you run',
    },
    /** "Step by step in the [Coolify guide]. ", only while the repository is public. */
    guide: SITE.repoPublic ? { before: 'Step by step in the ', label: 'Coolify guide', href: repoFile('docs/coolify.md'), after: '. ' } : undefined,
    note: 'Upgrades and restores through Coolify are documented but not yet verified end to end.',
  },
  tls: {
    eyebrow: 'HTTPS',
    title: 'Automatic HTTPS, or the proxy you already run.',
    limit: "Never expose the API server's own port. Everything goes through the console origin.",
    codeTitle: 'Caddy, built in',
    body: 'Set your domain in `.env` and run `docker compose --profile tls up -d`. Caddy gets and renews the certificate. Already run Nginx, Traefik or another proxy? Forward the whole origin to port 4600 and tell Logbird how many proxies sit in front, so rate limits and audit context see the real client address.',
  },
  ops: {
    title: 'Operating Logbird',
    smtp: {
      eyebrow: 'Email',
      title: 'Sign-in is by emailed code.',
      body: 'Logbird has no passwords. People sign in with a one-time code sent by email, so configure an SMTP provider. For a first local test you can log sign-in codes to the server log instead. Turn that off once SMTP works: anyone who can read the logs can sign in.',
    },
    upgrades: {
      eyebrow: 'Upgrades and backups',
      title: 'Upgrade to a pinned release, after a backup.',
      steps: [
        {
          title: 'Stop writes',
          body: "Run every command in these steps with the installation's own Compose project, env file, -f files and profile (after a restore cutover, the restored project's). Block ingress and stop the console, server and worker. The worker gets five minutes to finish its current job: wait for the stop to complete, and check its logs if it had to be killed.",
        },
        {
          title: 'Back up',
          body: 'With writers stopped: matched Postgres (pg_dump) and ClickHouse (BACKUP DATABASE) backups and a SHA-256 checksum file. Keep the original env file; record the Git revision (git rev-parse HEAD) and the images (docker compose images).',
        },
        {
          title: 'Pin the new version',
          body: "Check out the release tag vX.Y.Z, then set LOGBIRD_VERSION=X.Y.Z, without the v, in the env file the installation runs with (.env, or the one you cut over to after a restore): its value overrides the Compose default, and a LOGBIRD_VERSION or LOGBIRD_IMAGE_REGISTRY exported in your shell overrides the env file (unset it). Run docker compose config --images and check the full names: all four must be <registry>/logbird-<role>:X.Y.Z, with the registry you expect (the project's GHCR namespace by default). Built from source (docker-compose.build.yml)? Keep that override and build the four roles from the new revision instead; the image check doesn't apply.",
        },
        {
          title: 'Pull, then start',
          body: "docker compose pull (skip it for a source build), then docker compose up -d --no-build. Migrations run first; if one fails, the new version doesn't start.",
        },
        { title: 'Verify', body: 'Readiness, sign-in, your events, settings and keys, and the retention runs, before you reopen ingress.' },
      ],
      notes: [
        '`docker compose down` keeps your data. `docker compose down -v` permanently deletes the Compose-managed volumes, which hold the bundled Postgres, ClickHouse and Redis data.',
        'Restore into empty, separate storage first, and check counts before you switch over.',
      ],
    },
  },
  notYet: {
    eyebrow: 'Not there yet',
    title: "What self-hosting doesn't include today.",
    items: [
      ['High availability', 'The Compose setup is a single VM. It has no failover.'],
      ['Production sizing guarantee', "There's no published sizing guarantee yet. Size from your own measurements."],
      ['SSO', 'Sign-in is by emailed code only. SSO is on the roadmap.'],
    ],
  },
  cta: {
    title: 'Rather not run it yourself?',
    body: byCloud(SITE, {
      open: "Logbird Cloud runs the same codebase for you. It's in early access, with sign-ups limited to invited teams.",
      closed: "Logbird Cloud will run the same codebase for you. It isn't open yet.",
    }),
  },
} as const;
