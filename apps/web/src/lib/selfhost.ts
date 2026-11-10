import { GITHUB_URL } from '../env';
import { latestRelease } from './releases';

/**
 * The self-host quickstart, checked against docs/self-hosting.md § Five-minute quickstart: clone the latest release tag,
 * whose Compose file defaults LOGBIRD_VERSION to that version, then pull the published GHCR images (no source build).
 * Only rendered once the repository is public (WEB_GITHUB_PUBLIC); the URL comes from config.
 */
export const SELF_HOST_VERSION = latestRelease?.version ?? '0.1.0';

export const selfHostQuickstart = `git clone --branch v${SELF_HOST_VERSION} ${GITHUB_URL}.git
cd logbird
sh scripts/selfhost-init.sh   # creates .env and generates secrets
# Set SMTP in .env, or AUTH_LOG_SIGN_IN_CODES=true for a first local test.
# Internet-facing? Also set AUTH_SIGNUP=restricted and AUTH_SIGNUP_DOMAINS.
docker compose pull
docker compose up -d --no-build`;

/** The image namespace: the release workflow publishes `ghcr.io/<repository owner>/logbird-<role>`. */
export const IMAGE_NAMESPACE = GITHUB_URL ? `ghcr.io/${new URL(GITHUB_URL).pathname.split('/')[1]}` : undefined;

/** A file in the repository at the default branch, e.g. `docs/self-hosting.md`. */
export const repoFile = (path: string) => `${GITHUB_URL}/blob/master/${path}`;
