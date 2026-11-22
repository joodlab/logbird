import { GITHUB_URL } from '../env';
import { latestRelease } from './releases';

/**
 * The self-host quickstart, checked against docs/self-hosting.md § Five-minute quickstart: clone the latest release tag,
 * whose Compose file defaults LOGBIRD_VERSION to that version, then pull the published GHCR images (no source build).
 * Only rendered once the repository is public (WEB_GITHUB_PUBLIC); the URL comes from config.
 */
/** The newest published release, or undefined before the first one: release-tag commands render only when it exists. */
export const SELF_HOST_VERSION: string | undefined = latestRelease?.version;

/** The clone URL: WEB_GITHUB_URL may be configured with or without a trailing `.git` or slash. */
export const cloneUrl = (url: string) => `${url.replace(/\/+$/, '').replace(/\.git$/, '')}.git`;
export const CLONE_URL = GITHUB_URL ? cloneUrl(GITHUB_URL) : undefined;

/** The quickstart for the latest release; before the first release there are no images, so it points at a source build. */
export const selfHostQuickstart = SELF_HOST_VERSION
  ? `git clone --branch v${SELF_HOST_VERSION} ${CLONE_URL} logbird
cd logbird
sh scripts/selfhost-init.sh   # creates .env and generates secrets
# Set SMTP in .env, or AUTH_LOG_SIGN_IN_CODES=true for a first local test.
# Internet-facing? Also set AUTH_SIGNUP=restricted and AUTH_SIGNUP_DOMAINS.
docker compose pull
docker compose up -d --no-build`
  : `git clone ${CLONE_URL} logbird
cd logbird
sh scripts/selfhost-init.sh   # creates .env and generates secrets
# Nothing has been released yet, so there are no images: build from source (docs/self-hosting.md).`;

/** A file in the repository at the default branch, e.g. `docs/self-hosting.md`. */
export const repoFile = (path: string) => `${GITHUB_URL}/blob/master/${path}`;
