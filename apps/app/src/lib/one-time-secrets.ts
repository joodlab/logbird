/**
 * Secrets the server returns exactly once (ingest keys on project creation). Kept in memory
 * only — never in storage — so a reload genuinely forgets them, matching "shown once".
 */
const secrets = new Map<string, string>();

export function stashSecret(id: string, secret: string): void {
  secrets.set(id, secret);
}

export function peekSecret(id: string): string | undefined {
  return secrets.get(id);
}
