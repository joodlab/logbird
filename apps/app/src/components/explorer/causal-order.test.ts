import { expect, it } from 'vitest';
import { causalPageOrder } from './causal-order';

const event = (id: string, parentEventId = '', timestamp = '2026-11-25T10:00:00.000Z') => ({
  id,
  timestamp,
  context: { parentEventId, operationId: '', requestId: '', traceId: '', ip: '', userAgent: '' },
});

it('moves same-time prerequisites ahead of an event in either direction, including chains and branches', () => {
  const root = event('3');
  const child = event('2', root.id);
  const grandchild = event('1', child.id);
  const sibling = event('4', root.id);
  const unrelated = event('5');
  const asc = [grandchild, child, root, sibling, unrelated];
  const desc = [...asc].reverse();
  expect(causalPageOrder(asc, 'asc')).toEqual([root, child, grandchild, sibling, unrelated]);
  expect(causalPageOrder(desc, 'desc')).toEqual([unrelated, sibling, grandchild, child, root]);
  expect(asc[0]).toBe(grandchild);
});

it('does not reorder untied timestamps or move events between pages', () => {
  const late = event('1', '2', '2026-11-25T10:00:00.001Z');
  const parent = event('2', '1');
  const external = event('3', 'elsewhere');
  expect(causalPageOrder([late, external, parent], 'desc')).toEqual([late, external, parent]);
  expect(causalPageOrder([external], 'asc')).toEqual([external]);
  expect(causalPageOrder([parent], 'asc')).toEqual([parent]);
});

it('retains corrupt cycles and self links while still ordering independent relations', () => {
  const first = event('1', '2');
  const second = event('2', '1');
  const self = event('3', '3');
  const child = event('4', '5');
  const parent = event('5');
  expect(causalPageOrder([first, second, self, child, parent], 'asc')).toEqual([second, first, self, parent, child]);
});
