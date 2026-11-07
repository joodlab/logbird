import { cx as cn } from '../../lib/cx';
import { Highlighted } from './code';

/**
 * The recommended envelope with one-line annotations. Each annotated key's line is marked in the JSON, and the
 * annotation list repeats the key so the pairing reads without colour.
 */
const lines: { text: string; key?: string }[] = [
  { text: '{' },
  { text: '  "action": "booking.cancelled",', key: 'action' },
  { text: '  "actor": { "type": "user", "id": "usr_42", "name": "Lina Haddad" },', key: 'actor' },
  { text: '  "executor": { "type": "api", "id": "api-server" },', key: 'executor' },
  { text: '  "tenant": { "id": "biz_7", "name": "Azure Hotels" },', key: 'tenant' },
  { text: '  "targets": [{ "type": "booking", "id": "bk_1042", "name": "Booking #1042" }],', key: 'targets' },
  { text: '  "changes": [{ "field": "status", "before": "confirmed", "after": "cancelled" }],', key: 'changes' },
  { text: '  "context": { "operationId": "op_cancel_bk_1042" }', key: 'operationId' },
  { text: '}' },
];

const notes: { key: string; label: string; text: string; required?: boolean }[] = [
  { key: 'action', label: 'action', text: 'What happened. The only required field.', required: true },
  { key: 'actor', label: 'actor', text: 'Who asked.' },
  { key: 'executor', label: 'executor', text: 'What did the work, and on which attempt.' },
  { key: 'tenant', label: 'tenant', text: 'Whose account.' },
  { key: 'targets', label: 'targets', text: 'Which records.' },
  { key: 'changes', label: 'changes', text: 'Before and after. Never secrets.' },
  { key: 'operationId', label: 'operationId', text: 'Ties a request to the jobs it started.' },
];

export function Envelope({ className }: { className?: string }) {
  return (
    <div className={cn('grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-10', className)}>
      <div className="frame min-w-0">
        <div className="frame-bar">
          <span className="font-mono text-[11px] text-muted-foreground">POST /v1/events</span>
        </div>
        <pre className="overflow-x-auto py-4 font-mono text-[12.5px] leading-[1.9] sm:text-[13px]">
          <code>
            {lines.map((line) => (
              <span
                className={cn(
                  'block border-s-2 border-transparent ps-4 pe-4',
                  line.key === 'action' && 'border-brand bg-[color-mix(in_oklab,var(--brand)_8%,transparent)]',
                )}
                data-key={line.key}
                key={line.text}
              >
                <Highlighted code={line.text} language="json" />
              </span>
            ))}
          </code>
        </pre>
      </div>
      <dl className="flex flex-col divide-y self-center">
        {notes.map((note) => (
          <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 py-3 first:pt-0 last:pb-0" key={note.key}>
            <dt className="font-mono text-sm">
              <span className={note.required ? 'text-brand' : undefined}>{note.label}</span>
            </dt>
            <dd className="text-muted-foreground text-sm leading-relaxed">
              {note.text}
              {note.required ? <span className="ms-2 rounded-full border px-2 py-0.5 font-medium text-[11px] text-foreground">required</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
