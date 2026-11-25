// @vitest-environment happy-dom
import type { AuditEvent } from '@logbird/contracts';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationParties } from './operation-parties';

// A profile link needs the router; stand in a plain link that carries what the real one shows.
vi.mock('@/components/entity-link', () => ({
  EntityLink: ({ id, name, kind }: { id: string; name?: string; kind: string }) => (
    <a data-kind={kind} href={`/profile/${id}`}>
      {name || id}
    </a>
  ),
}));

vi.mock('@/components/impersonation', () => ({
  SupportAgentLink: ({ agentId, children }: { agentId: string; children: ReactNode }) => <a href={`/support/${agentId}`}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

type Actor = NonNullable<AuditEvent['actor']>;
type Executor = NonNullable<AuditEvent['executor']>;
const actor = (id: string, name = '', email = '', type = 'user'): Actor => ({ id, type, name, email });
const executor = (id: string, name = '', type = 'worker'): Executor => ({ id, type, name, jobId: '', attempt: 0 });
const ev = (n: number, actorValue: Actor | null, executorValue: Executor | null = null, agent: AuditEvent['impersonator'] = null) =>
  ({ id: `evt_${n}`, actor: actorValue, executor: executorValue, impersonator: agent }) as AuditEvent;
const sam = { id: 'agent_sam', name: 'Sam Support' };

function show(events: AuditEvent[]) {
  act(() => root?.render(<OperationParties events={events} projectId="prj_lab" />));
  return {
    actors: host.querySelector('[data-testid="operation-actors"]') as HTMLElement,
    executors: host.querySelector('[data-testid="operation-executors"]') as HTMLElement,
  };
}
const links = (el: HTMLElement) => [...el.querySelectorAll('a')].map((a) => a.textContent);

describe('OperationParties', () => {
  it('says "Not recorded" for a party no event named', () => {
    const { actors, executors } = show([ev(1, null)]);
    expect(actors.textContent).toBe('Caused byNot recorded');
    expect(executors.textContent).toBe('Performed byNot recorded');
  });

  it('names four actors and counts the fifth, ID-less actors with different emails included', () => {
    const { actors } = show([
      ev(1, actor('u1', 'Lina Haddad')),
      ev(2, actor('u2', 'Omar Saleh')),
      ev(3, actor('u3', 'Sara Nasser')),
      ev(4, actor('', '', 'first@example.test')),
      ev(5, actor('', '', 'second@example.test')),
      ev(6, actor('u1', 'Lina Haddad')),
    ]);
    expect(links(actors)).toEqual(['Lina Haddad', 'Omar Saleh', 'Sara Nasser']);
    expect(actors.textContent).toContain('first@example.test');
    expect(actors.textContent).not.toContain('second@example.test');
    expect(actors.textContent).toContain('and 1 more');
    expect(actors.textContent).not.toContain('Not recorded');
  });

  it('shows four actors with no "more"', () => {
    const { actors } = show([ev(1, actor('a')), ev(2, actor('b')), ev(3, actor('c')), ev(4, actor('d')), ev(5, actor('d'))]);
    expect(links(actors)).toHaveLength(4);
    expect(actors.textContent).not.toContain('more');
  });

  it('reads a repeated actor by its latest name, in its first place', () => {
    const { actors } = show([ev(1, actor('u1')), ev(2, actor('u2', 'Omar Saleh')), ev(3, actor('u1', 'Lina Haddad'))]);
    expect(links(actors)).toEqual(['Lina Haddad', 'Omar Saleh']);
  });

  it('shows a party recorded without an ID as text, never a link or "Not recorded"', () => {
    const { actors, executors } = show([ev(1, actor('', '', '', 'system'), executor('', 'Billing worker'))]);
    expect(actors.querySelector('a')).toBeNull();
    expect(actors.textContent).toBe('Caused bysystem');
    expect(executors.querySelector('a')).toBeNull();
    expect(executors.textContent).toBe('Performed byBilling worker');
  });

  it('keeps ID-less parties apart even when their type and name join alike', () => {
    const { executors } = show([ev(1, null, executor('', 'west', 'service:billing')), ev(2, null, executor('', 'billing:west', 'service'))]);
    expect(executors.textContent).toBe('Performed bywestbilling:west');
  });

  it('preserves distinct recorded names for a shared executor id', () => {
    const { executors } = show([
      ev(1, null, executor('jobs', 'Publish job')),
      ev(2, null, executor('jobs', 'Cache purge')),
      ev(3, null, executor('jobs', 'Publish job')),
    ]);
    expect(links(executors)).toEqual(['Publish job', 'Cache purge']);
  });

  it('names a party recorded by an email or a name alone (as the read API now returns it), never "Not recorded"', () => {
    const { actors, executors } = show([ev(1, actor('', '', 'lina@example.test', ''), executor('', 'Billing worker', ''))]);
    expect(actors.textContent).toBe('Caused bylina@example.test');
    expect(executors.textContent).toBe('Performed byBilling worker');
  });

  it('credits the support agent for an impersonated step, as the drawer does', () => {
    const { actors } = show([ev(1, actor('', '', 'lina@example.test', ''), null, sam)]);
    expect(actors.textContent).toBe('Caused bySam Supportacting aslina@example.test');
    expect(links(actors)).toEqual(['Sam Support']);
  });

  it('keeps the customer acting alone and the agent acting as them apart, and counts both', () => {
    const lina = actor('u1', 'Lina Haddad');
    const { actors } = show([ev(1, lina), ev(2, lina, null, sam), ev(3, null, null, sam)]);
    expect(links(actors)).toEqual(['Lina Haddad', 'Sam Support', 'Lina Haddad', 'Sam Support']);
    expect(actors.textContent).toContain('acting asLina Haddad·Sam Support');
    expect(actors.textContent).toContain('acting asan unknown customer');
  });
});
