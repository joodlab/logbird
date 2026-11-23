// @vitest-environment happy-dom
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@logbird/ui/components/ui/command';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { paletteEntityValue, paletteFilter, paletteKeyedValue, paletteValue } from './palette-filter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

type Entity = { kind: 'tenant' | 'actor'; id: string; name: string };

/** The palette as cmdk shows it for `search`: the server-ranked entities, plus other rows (a saved view, a page). */
function shown(search: string, entities: Entity[], others: { value: string; label: string }[] = []): string[] {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <Command filter={paletteFilter(entities, search)}>
        <CommandInput value={search} />
        <CommandList>
          <CommandGroup heading="Entities">
            {entities.map((e) => (
              <CommandItem key={`${e.kind}:${e.id}`} value={paletteEntityValue(e)}>
                {e.name}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Other">
            {others.map((o) => (
              <CommandItem key={o.value} value={o.value}>
                {o.label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>,
    ),
  );
  return [...host.querySelectorAll('[cmdk-item]')].map((n) => n.textContent ?? '');
}

// As the server ranks them for `act`: the tenant whose id starts with it, then the actor whose name contains it.
const ranked: Entity[] = [
  { kind: 'tenant', id: 'actual27', name: 'Actual Clinics' },
  { kind: 'actor', id: 'bob', name: 'Contact Desk' },
];

it('keeps the server rank order for entities instead of re-sorting them by kind (#239)', () => {
  expect(shown('act', ranked)).toEqual(['Actual Clinics', 'Contact Desk']);
});

it('keeps them with spaces around what was typed, and never drops one the server found', () => {
  expect(shown(' act', ranked)).toEqual(['Actual Clinics', 'Contact Desk']);
  // An actor found by its name ("Marsa"), whose id does not contain the text.
  expect(shown(' mar', [{ kind: 'actor', id: 'zz', name: 'Marsa' }])).toEqual(['Marsa']);
});

it('an entity row never shares a value with another row, so selecting one never selects the other', () => {
  const view = { value: 'view actor:sam', label: 'Saved view actor:sam' };
  const entity: Entity = { kind: 'actor', id: 'sam', name: 'Viewer' };
  expect(paletteEntityValue(entity)).not.toBe(view.value);
  expect(shown('view', [entity], [view])).toEqual(['Viewer', 'Saved view actor:sam']);
});

it('no two rows share a value, whatever the typed text or the ids hold, so only one is ever selected (#239)', () => {
  // Typed text that looks like an entity value, an exact tenant with that id, and an actor whose id repeats it all.
  const typed = 'entity:actor:sam';
  const actor: Entity = { kind: 'actor', id: 'sam open tenant entity:actor:sam', name: 'Sam' };
  const jump = { value: paletteValue('jump', 'open', 'tenant', typed), label: 'Open tenant entity:actor:sam' };
  expect(paletteEntityValue(actor)).not.toBe(jump.value);
  expect(shown(typed, [actor], [jump])).toEqual(['Sam', 'Open tenant entity:actor:sam']);
  expect(document.querySelectorAll('[cmdk-item][aria-selected="true"]')).toHaveLength(1);
  // Parts are kept apart: an agent `a b` called `c` is not an agent `a` called `b c`.
  expect(paletteValue('support', 'a b', 'c')).not.toBe(paletteValue('support', 'a', 'b c'));
});

it('scores Jump to rows and notices as written, even when the text looks like an entity value (#239)', () => {
  const typed = 'entity:actor:sam';
  const filter = paletteFilter([], typed);
  expect(filter(paletteValue('jump', 'open', 'tenant', typed), typed)).toBe(1);
  expect(filter(paletteValue('jump', 'search', typed), typed)).toBe(1);
  expect(filter(paletteValue('notice', 'support agents unavailable'), typed)).toBe(1);
  // Entity rows share the best entity score (here none: the floor), never cmdk's own for the value.
  expect(filter(paletteEntityValue({ kind: 'actor', id: 'zz' }), typed)).toBe(0.01);
});

it('keeps namesake saved views and projects apart, and scores them on their name only (#239)', () => {
  const views = [
    { value: paletteKeyedValue('view', 'Sample', 'cmv1zq'), label: 'Sample (one)' },
    { value: paletteKeyedValue('view', 'Sample', 'cmv2zq'), label: 'Sample (two)' },
  ];
  expect(shown('sample', [], views)).toEqual(['Sample (one)', 'Sample (two)']);
  expect(document.querySelectorAll('[cmdk-item][aria-selected="true"]')).toHaveLength(1);
  const filter = paletteFilter([], 'zq');
  // The id is never matched: "zq" is in both ids, in neither name.
  expect(filter(views[0]?.value ?? '', 'zq')).toBe(0);
  expect(filter(paletteKeyedValue('project', 'Sample', 'p1'), 'project sam')).toBeGreaterThan(0);
});
