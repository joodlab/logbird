/**
 * In-memory evaluation of the read API over fixture events: search, histogram, facets,
 * overview, entities, fields, operations. Semantics follow docs/SPEC.md closely enough that
 * the console behaves the same against fixtures and the real server.
 */
import type { AuditEvent, Entity, EntityKind } from '@trailmark/contracts';
import { entityQuery } from '@/lib/entities';
import { canonicalField, tokenize } from '@/lib/query-language';
import type { StoredEvent } from './normalize';

type Predicate = (e: AuditEvent) => boolean;

function eq(a: string, b: string): boolean {
  if (b.endsWith('*')) return a.toLowerCase().startsWith(b.slice(0, -1).toLowerCase());
  return a.toLowerCase() === b.toLowerCase();
}

function fieldValues(e: AuditEvent, field: string): string[] {
  switch (field) {
    case 'action':
      return [e.action];
    case 'category':
      return [e.category];
    case 'outcome':
      return [e.outcome];
    case 'severity':
      return [e.severity];
    case 'env':
      return [e.environment];
    case 'actor':
    case 'actor.id':
      return e.actor ? [e.actor.id] : [];
    case 'actor.type':
      return e.actor ? [e.actor.type] : [];
    case 'actor.name':
      return e.actor ? [e.actor.name] : [];
    case 'actor.email':
      return e.actor ? [e.actor.email] : [];
    case 'impersonator':
    case 'impersonator.id':
      return e.impersonator ? [e.impersonator.id] : [];
    case 'impersonator.name':
      return e.impersonator ? [e.impersonator.name] : [];
    case 'tenant':
    case 'tenant.id':
      return e.tenant ? [e.tenant.id] : [];
    case 'tenant.name':
      return e.tenant ? [e.tenant.name] : [];
    case 'executor':
    case 'executor.id':
      return e.executor ? [e.executor.id] : [];
    case 'executor.type':
      return e.executor ? [e.executor.type] : [];
    case 'executor.name':
      return e.executor ? [e.executor.name] : [];
    case 'job':
      return e.executor?.jobId ? [e.executor.jobId] : [];
    case 'target':
    case 'target.id':
      return e.targets.flatMap((t) => [t.id, `${t.type}:${t.id}`]);
    case 'target.type':
      return e.targets.map((t) => t.type);
    case 'target.name':
      return e.targets.map((t) => t.name);
    case 'operation':
      return [e.context.operationId];
    case 'request':
      return [e.context.requestId];
    case 'trace':
      return [e.context.traceId];
    case 'parent':
      return [e.context.parentEventId];
    case 'source':
      return e.source ? [e.source] : [];
    case 'id':
      return [e.id];
    case 'ip':
      return [e.context.ip];
    default: {
      const key = field.startsWith('attr.') ? field.slice(5) : field;
      const v = e.attributes[key];
      return v === undefined ? [] : [v];
    }
  }
}

function haystack(e: AuditEvent): string {
  return [e.description, e.action, e.actor?.name ?? '', e.tenant?.name ?? '', ...e.targets.map((t) => t.name)].join(' ').toLowerCase();
}

export function compile(q: string | undefined): Predicate {
  if (!q?.trim()) return () => true;
  const preds: Predicate[] = [];
  for (const t of tokenize(q)) {
    if (t.kind === 'space' || t.kind === 'paren' || t.kind === 'operator') continue;
    let p: Predicate;
    if (t.kind === 'field') {
      const field = canonicalField(t.field ?? '');
      const value = t.value ?? '';
      p = (e) => fieldValues(e, field).some((v) => eq(v, value));
    } else {
      const needle = (t.value ?? '').toLowerCase();
      if (!needle) continue;
      p = (e) => haystack(e).includes(needle);
    }
    preds.push(t.negated ? (e) => !p(e) : p);
  }
  return (e) => preds.every((p) => p(e));
}

export class EventStore {
  /** Newest first. */
  private events: StoredEvent[] = [];
  private byId = new Map<string, StoredEvent>();

  add(items: StoredEvent[]): void {
    if (items.length === 0) return;
    for (const item of items) this.byId.set(item.event.id, item);
    this.events.push(...items);
    this.events.sort((a, b) => (a.event.timestamp < b.event.timestamp ? 1 : a.event.timestamp > b.event.timestamp ? -1 : 0));
  }

  /** Permanently drop events older than the cutoff (retention). Returns how many were deleted. */
  purgeBefore(cutoffMs: number): number {
    const before = this.events.length;
    this.events = this.events.filter((s) => Date.parse(s.event.timestamp) >= cutoffMs);
    this.byId = new Map(this.events.map((s) => [s.event.id, s]));
    return before - this.events.length;
  }

  get(id: string): StoredEvent | undefined {
    return this.byId.get(id);
  }

  /** Events visible "now": received already. */
  all(now = Date.now()): AuditEvent[] {
    const nowIso = new Date(now).toISOString();
    return this.events.filter((s) => s.event.receivedAt <= nowIso).map((s) => s.event);
  }

  range(fromIso: string, toIso: string, q?: string, now = Date.now()): AuditEvent[] {
    const pred = compile(q);
    return this.all(now).filter((e) => e.timestamp >= fromIso && e.timestamp <= toIso && pred(e));
  }

  get size(): number {
    return this.events.length;
  }

  oldest(): string | null {
    return this.events.at(-1)?.event.timestamp ?? null;
  }
}

export function histogram(events: AuditEvent[], fromMs: number, toMs: number, interval?: number) {
  const seconds = (toMs - fromMs) / 1000;
  const candidates = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600, 43_200, 86_400];
  const step = interval ?? candidates.find((c) => seconds / c <= 60) ?? 86_400;
  const stepMs = step * 1000;
  const start = Math.floor(fromMs / stepMs) * stepMs;
  const buckets: { ts: string; total: number; byOutcome: Record<string, number> }[] = [];
  for (let t = start; t < toMs; t += stepMs) buckets.push({ ts: new Date(t).toISOString(), total: 0, byOutcome: {} });
  for (const e of events) {
    const idx = Math.floor((Date.parse(e.timestamp) - start) / stepMs);
    const b = buckets[idx];
    if (!b) continue;
    b.total += 1;
    b.byOutcome[e.outcome] = (b.byOutcome[e.outcome] ?? 0) + 1;
  }
  return { interval: step, buckets };
}

export function facetValue(e: AuditEvent, field: string): { value: string; label: string }[] {
  switch (field) {
    case 'actor':
      return e.actor ? [{ value: e.actor.id, label: e.actor.name || e.actor.id }] : [];
    case 'tenant':
      return e.tenant ? [{ value: e.tenant.id, label: e.tenant.name || e.tenant.id }] : [];
    case 'executor':
      return e.executor?.id ? [{ value: e.executor.id, label: e.executor.name || e.executor.id }] : [];
    case 'environment':
      return [{ value: e.environment, label: e.environment }];
    default:
      return [...new Set(fieldValues(e, field))].filter(Boolean).map((v) => ({ value: v, label: v }));
  }
}

export function facets(events: AuditEvent[], field: string, limit: number) {
  const counts = new Map<string, { value: string; label: string; count: number }>();
  for (const e of events) {
    for (const fv of facetValue(e, field === 'target.type' ? 'target.type' : field)) {
      const cur = counts.get(fv.value);
      if (cur) cur.count += 1;
      else counts.set(fv.value, { ...fv, count: 1 });
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count);
  const values = sorted.slice(0, limit);
  const otherCount = sorted.slice(limit).reduce((s, v) => s + v.count, 0);
  return { field, values, otherCount };
}

function top<T extends { id: string }>(items: Map<string, T & { count: number }>, n: number) {
  return [...items.values()].sort((a, b) => b.count - a.count).slice(0, n);
}

export function overview(store: EventStore, fromMs: number, toMs: number, q?: string) {
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const len = toMs - fromMs;
  const cur = store.range(fromIso, toIso, q);
  const prev = store.range(new Date(fromMs - len).toISOString(), fromIso, q);
  const failRate = (list: AuditEvent[]) =>
    list.length ? list.filter((e) => e.outcome === 'failure' || e.outcome === 'denied').length / list.length : 0;
  const distinct = (list: AuditEvent[], f: (e: AuditEvent) => string | undefined) => new Set(list.map(f).filter(Boolean)).size;

  const actions = new Map<string, { id: string; label: string; count: number }>();
  const actors = new Map<string, { id: string; label: string; type: string; count: number }>();
  const tenants = new Map<string, { id: string; label: string; count: number }>();
  const executors = new Map<string, { id: string; label: string; type: string; count: number }>();
  let conformance = 0;
  for (const e of cur) {
    conformance += e.conformance;
    const a = actions.get(e.action) ?? { id: e.action, label: e.action, count: 0 };
    a.count += 1;
    actions.set(e.action, a);
    if (e.actor) {
      const x = actors.get(e.actor.id) ?? { id: e.actor.id, label: e.actor.name || e.actor.id, type: e.actor.type, count: 0 };
      x.count += 1;
      actors.set(e.actor.id, x);
    }
    if (e.tenant) {
      const x = tenants.get(e.tenant.id) ?? { id: e.tenant.id, label: e.tenant.name || e.tenant.id, count: 0 };
      x.count += 1;
      tenants.set(e.tenant.id, x);
    }
    if (e.executor?.id) {
      const x = executors.get(e.executor.id) ?? { id: e.executor.id, label: e.executor.name || e.executor.id, type: e.executor.type, count: 0 };
      x.count += 1;
      executors.set(e.executor.id, x);
    }
  }
  const all = store.all();
  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000).toISOString();
  const lastHour = all.filter((e) => e.timestamp >= hourAgo);
  const perMinute = Array.from({ length: 60 }, (_, i) => {
    const start = Math.floor(now / 60_000) * 60_000 - (59 - i) * 60_000;
    return { ts: new Date(start).toISOString(), count: 0 };
  });
  const firstMinute = Date.parse(perMinute[0]?.ts ?? hourAgo);
  for (const e of lastHour) {
    const idx = Math.floor((Date.parse(e.timestamp) - firstMinute) / 60_000);
    const slot = perMinute[idx];
    if (slot) slot.count += 1;
  }

  return {
    kpis: {
      events: cur.length,
      eventsPrev: prev.length,
      actors: distinct(cur, (e) => e.actor?.id),
      actorsPrev: distinct(prev, (e) => e.actor?.id),
      tenants: distinct(cur, (e) => e.tenant?.id),
      failureRate: failRate(cur),
      failureRatePrev: failRate(prev),
      avgConformance: cur.length ? conformance / cur.length : 0,
    },
    series: histogram(cur, fromMs, toMs),
    topActions: top(actions, 8),
    topActors: top(actors, 8),
    topTenants: top(tenants, 8),
    topExecutors: top(executors, 8),
    recentProblems: cur.filter((e) => e.outcome === 'failure' || e.outcome === 'denied' || e.severity === 'critical').slice(0, 8),
    ingest: { lastEventAt: all[0]?.receivedAt ?? null, eventsLastHour: lastHour.length, perMinute },
  };
}

/* ------------------------------------------------------------------ */
/* Entities                                                            */
/* ------------------------------------------------------------------ */

export function entityRefs(e: AuditEvent): { kind: EntityKind; id: string; type: string; name: string }[] {
  const refs: { kind: EntityKind; id: string; type: string; name: string }[] = [];
  if (e.actor) refs.push({ kind: 'actor', id: e.actor.id, type: e.actor.type, name: e.actor.name });
  if (e.tenant) refs.push({ kind: 'tenant', id: e.tenant.id, type: '', name: e.tenant.name });
  if (e.executor?.id) refs.push({ kind: 'executor', id: e.executor.id, type: e.executor.type, name: e.executor.name });
  for (const t of e.targets) refs.push({ kind: 'target', id: `${t.type}:${t.id}`, type: t.type, name: t.name });
  return refs;
}

export function entityIndex(events: AuditEvent[], kind: EntityKind): Map<string, Entity> {
  const map = new Map<string, Entity>();
  // events are newest first
  for (const e of events) {
    for (const ref of entityRefs(e)) {
      if (ref.kind !== kind) continue;
      const cur = map.get(ref.id);
      if (cur) {
        cur.events += 1;
        cur.firstSeen = e.timestamp;
      } else {
        map.set(ref.id, { kind, id: ref.id, type: ref.type, name: ref.name, firstSeen: e.timestamp, lastSeen: e.timestamp, events: 1 });
      }
    }
  }
  return map;
}

export function profile(store: EventStore, kind: EntityKind, id: string, fromMs: number, toMs: number) {
  const all = store.all();
  const pred = compile(entityQuery(kind, id));
  const mine = all.filter(pred);
  if (mine.length === 0) return null;
  const entity = entityIndex(mine, kind).get(id);
  if (!entity) return null;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const inRange = mine.filter((e) => e.timestamp >= fromIso && e.timestamp <= toIso);
  const actions = new Map<string, { id: string; label: string; count: number }>();
  const outcomes: Record<string, number> = {};
  const related = new Map<string, { kind: EntityKind; id: string; type: string; name: string; count: number }>();
  for (const e of inRange) {
    const a = actions.get(e.action) ?? { id: e.action, label: e.action, count: 0 };
    a.count += 1;
    actions.set(e.action, a);
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    for (const ref of entityRefs(e)) {
      if (ref.kind === kind && ref.id === id) continue;
      const key = `${ref.kind}|${ref.id}`;
      const r = related.get(key) ?? { ...ref, count: 0 };
      r.count += 1;
      related.set(key, r);
    }
  }
  const relatedTop = [...related.values()].sort((a, b) => b.count - a.count);
  // Keep a balanced mix of kinds.
  const byKind = new Map<EntityKind, typeof relatedTop>();
  for (const r of relatedTop) {
    const list = byKind.get(r.kind) ?? [];
    if (list.length < 6) list.push(r);
    byKind.set(r.kind, list);
  }
  return {
    entity,
    series: histogram(inRange, fromMs, toMs),
    topActions: [...actions.values()].sort((a, b) => b.count - a.count).slice(0, 8),
    outcomes,
    related: [...byKind.values()].flat(),
  };
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

const CORE_FIELDS: [string, (e: AuditEvent) => string | string[] | undefined][] = [
  ['action', (e) => e.action],
  ['occurredAt', (e) => e.timestamp],
  ['outcome', (e) => (e.outcome ? e.outcome : undefined)],
  ['severity', (e) => e.severity],
  ['environment', (e) => e.environment],
  ['description', (e) => e.description || undefined],
  ['actor.id', (e) => e.actor?.id],
  ['actor.type', (e) => e.actor?.type || undefined],
  ['actor.name', (e) => e.actor?.name || undefined],
  ['actor.email', (e) => e.actor?.email || undefined],
  ['impersonator.id', (e) => e.impersonator?.id],
  ['executor.type', (e) => e.executor?.type || undefined],
  ['executor.id', (e) => e.executor?.id || undefined],
  ['executor.jobId', (e) => e.executor?.jobId || undefined],
  ['tenant.id', (e) => e.tenant?.id],
  ['tenant.name', (e) => e.tenant?.name || undefined],
  ['source', (e) => e.source ?? undefined],
  ['targets', (e) => (e.targets.length ? e.targets.map((t) => `${t.type}:${t.id}`) : undefined)],
  ['changes', (e) => (e.changes.length ? e.changes.map((c) => c.field) : undefined)],
  ['context.operationId', (e) => e.context.operationId || undefined],
  ['context.parentEventId', (e) => e.context.parentEventId || undefined],
  ['context.requestId', (e) => e.context.requestId || undefined],
  ['context.traceId', (e) => e.context.traceId || undefined],
  ['context.ip', (e) => e.context.ip || undefined],
  ['context.userAgent', (e) => e.context.userAgent || undefined],
];

export function fields(events: AuditEvent[]) {
  const total = events.length || 1;
  const collect = (key: string, kind: 'core' | 'attribute', get: (e: AuditEvent) => string | string[] | undefined) => {
    let present = 0;
    const distinct = new Set<string>();
    let lastSeen: string | null = null;
    for (const e of events) {
      const v = get(e);
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      present += 1;
      lastSeen ??= e.timestamp;
      for (const x of Array.isArray(v) ? v : [v]) if (distinct.size < 5000) distinct.add(x);
    }
    return {
      key,
      kind,
      coverage: present / total,
      distinctApprox: distinct.size,
      samples: [...distinct].slice(0, 5).map((s) => (s.length > 80 ? `${s.slice(0, 77)}…` : s)),
      lastSeen,
    };
  };
  const core = CORE_FIELDS.map(([key, get]) => collect(key, 'core', get));
  const attrKeys = new Set<string>();
  for (const e of events) for (const k of Object.keys(e.attributes)) attrKeys.add(k);
  const attrs = [...attrKeys].sort().map((k) => collect(`attr.${k}`, 'attribute', (e) => e.attributes[k]));
  return {
    data: [...core, ...attrs.sort((a, b) => b.coverage - a.coverage)],
    avgConformance: events.length ? events.reduce((s, e) => s + e.conformance, 0) / events.length : 0,
  };
}
