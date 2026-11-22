import type { ApiKeyKind, ReadScope } from '@logbird/contracts';
import { CodeBlock } from '@logbird/ui/components/code-block';
import { cn } from '@logbird/ui/lib/utils';
import type { ReactNode } from 'react';
import { Timestamp } from '@/components/timestamp';
import { MASK_LABEL } from '@/lib/api-keys';
import { viewerTokenSnippet } from '@/lib/snippets';

export const SCOPED_READ_DOCS = 'https://github.com/joodlab/logbird/blob/master/docs/scoped-read-access.md';

const Mono = ({ children }: { children: ReactNode }) => <span className="break-all font-mono text-foreground">{children}</span>;

/** "booking. or auth." */
function prefixList(prefixes: readonly string[]): ReactNode {
  return prefixes.map((p, i) => (
    <span key={p}>
      {i === 0 ? '' : i === prefixes.length - 1 ? ' or ' : ', '}
      <Mono>{p}</Mono>
    </span>
  ));
}

const maskList = (scope: ReadScope) => (scope.mask ?? []).map((m) => MASK_LABEL[m]).join(', ');

/**
 * What a key can do, at a glance: the kind, the scope it reads, where its viewer tokens work and when it expires. Used
 * as the live preview in the create form and to show back what the server actually returned after create or roll.
 */
export function KeyGrantSummary({
  kind,
  scope,
  embedOrigins,
  expiresAt,
  title = 'What this key can do',
  className,
}: {
  kind: ApiKeyKind;
  scope: ReadScope | null | undefined;
  embedOrigins: readonly string[];
  /** ISO instant, or null for a key that never expires. */
  expiresAt: string | null;
  title?: string;
  className?: string;
}) {
  const rows: [string, ReactNode][] = [];
  if (kind === 'ingest') rows.push(['Can', 'Send events to this project. It cannot read them.']);
  else if (kind === 'read') {
    rows.push(['Reads', 'Every event in this project']);
    rows.push(['Viewer tokens', 'It can mint them for any tenant']);
  } else if (scope) {
    rows.push([
      'Reads',
      <>
        Only events of tenant <Mono>{scope.tenantId}</Mono>
      </>,
    ]);
    rows.push([
      'Target',
      scope.target ? (
        <>
          Only events with the target <Mono>{scope.target.type}</Mono> · <Mono>{scope.target.id}</Mono>
        </>
      ) : (
        'Any target'
      ),
    ]);
    rows.push(['Actions', scope.actionPrefixes?.length ? <>Only actions starting with {prefixList(scope.actionPrefixes)}</> : 'All actions']);
    rows.push(['Hidden', scope.mask?.length ? `${maskList(scope)}, and the raw payload` : 'Nothing']);
    rows.push(['Viewer tokens', 'Only for this scope or a narrower one']);
  }
  if (kind !== 'ingest')
    rows.push([
      'Browser origins',
      embedOrigins.length ? (
        <span className="flex flex-col">
          {embedOrigins.map((o) => (
            <Mono key={o}>{o}</Mono>
          ))}
        </span>
      ) : (
        'None: its viewer tokens work server to server only'
      ),
    ]);
  rows.push([
    'Expires',
    expiresAt ? (
      <>
        <Timestamp className="text-foreground" format="full" iso={expiresAt} /> (<Timestamp format="relative" iso={expiresAt} />)
      </>
    ) : (
      'Never. Roll or revoke it yourself.'
    ),
  ]);
  return (
    <section aria-label={title} className={cn('flex flex-col gap-2 rounded-lg border bg-muted/30 p-3', className)} data-testid="key-grant-summary">
      <h3 className="font-medium text-xs">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {rows.map(([label, value]) => (
          <div className="contents" key={label}>
            <dt>{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** One line under a scoped key in the list: "tenant biz_5 · target website site_42 · actions booking., auth. · hides IP address". */
export function KeyScopeLine({ scope }: { scope: ReadScope }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5" data-testid="key-scope-line">
      <span>
        tenant <Mono>{scope.tenantId}</Mono>
      </span>
      {scope.target ? (
        <span>
          · target <Mono>{scope.target.type}</Mono> <Mono>{scope.target.id}</Mono>
        </span>
      ) : null}
      {scope.actionPrefixes?.length ? (
        <span>
          · actions <Mono>{scope.actionPrefixes.join(', ')}</Mono>
        </span>
      ) : null}
      {scope.mask?.length ? <span>· hides {maskList(scope).toLowerCase()}</span> : null}
    </span>
  );
}

/** Viewer tokens: what they are and how a server mints one with this key (the console does not mint them). */
export function ViewerTokenHelp({ secret, scope, onCopied }: { secret?: string; scope?: ReadScope | null; onCopied?: () => void }) {
  return (
    <section aria-label="Viewer tokens" className="flex min-w-0 flex-col gap-2">
      <h3 className="font-medium text-sm">Showing events in a browser</h3>
      <p className="text-muted-foreground text-xs">
        Keep this key on your server. For each page view, your server mints a short-lived viewer token (15 minutes by default) for one{' '}
        {scope ? 'scope inside this key’s scope' : 'tenant'} and gives only the token to the browser. The console does not mint tokens.{' '}
        <a className="underline underline-offset-2 hover:text-foreground" href={SCOPED_READ_DOCS} rel="noreferrer" target="_blank">
          Scoped read access guide
        </a>
      </p>
      <CodeBlock code={viewerTokenSnippet(secret, scope)} language="bash" maxHeight={220} onCopied={onCopied} />
    </section>
  );
}
