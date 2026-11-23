// @vitest-environment happy-dom
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@logbird/ui/components/ui/command';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { paletteEntityValue, paletteFilter } from './palette-filter';

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
