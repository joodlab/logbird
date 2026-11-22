import { z } from 'zod';

/**
 * Alerts v1 (#139, approved design + 8 changes, 2026-11-22). Per-project rules evaluated by the worker every minute on
 * arrival-time windows that end at the settled ingest watermark.
 *
 * - `match`: at least one new event matching `q` arrived. Resolves after `quietMinutes` without a new match.
 * - `threshold`: the count of events matching `q` that arrived in the last `windowMinutes` is `>` / `<` `value`,
 *   optionally per `groupBy` value (at most 50 groups tracked). Resolves after 2 evaluations back within bounds.
 * - `silence`: no event matching `q` (empty = any event) arrived for `silenceMinutes`. Arms on the first matching event,
 *   or immediately when `silenceArm` is `now`. Never fires while evaluation is behind: the rule shows
 *   `evaluation_delayed` instead. Resolves on the first matching event.
 *
 * Events whose occurrence time is more than 24 hours before their arrival never count (imports don't trigger alerts).
 */
export const ALERT_RULE_KINDS = ['match', 'threshold', 'silence'] as const;
export const alertRuleKindSchema = z.enum(ALERT_RULE_KINDS);
export type AlertRuleKind = z.infer<typeof alertRuleKindSchema>;

/** One field per grouped threshold (`groupBy`); each group has its own state. */
export const ALERT_GROUP_BY = ['actor', 'tenant', 'ip', 'target', 'source'] as const;
export const alertGroupBySchema = z.enum(ALERT_GROUP_BY);

/**
 * Rule state.
 * - `ok`: evaluated and not firing.
 * - `firing`: an incident is open.
 * - `unarmed`: a silence rule waiting for its first matching event.
 * - `evaluation_delayed`: the settled watermark has not advanced (storage, unconfirmed receipts, worker restart); a
 *   silence rule never fires in this state, and nothing is sent.
 */
export const ALERT_STATES = ['ok', 'firing', 'unarmed', 'evaluation_delayed'] as const;
export const alertStateSchema = z.enum(ALERT_STATES);
export type AlertState = z.infer<typeof alertStateSchema>;

/** Why a rule cannot notify right now (it keeps evaluating and recording incidents). */
export const ALERT_CHANNEL_ERRORS = ['webhook_disabled', 'webhook_scoped', 'webhook_missing', 'no_eligible_recipients'] as const;

export const alertChannelsSchema = z
  .object({
    /** Workspace members to email (user ids). Membership is re-checked at send time. */
    emails: z.array(z.string().min(1)).max(50).default([]),
    /**
     * Project webhook endpoints to call with a signed `logbird.alert.*` message. An endpoint restricted to a tenant or
     * target cannot be an alert channel (400 `alert_channel_scoped`): it feeds that tenant's own system, and a
     * project-wide alert would leak other tenants' activity.
     */
    webhookEndpointIds: z.array(z.string().min(1)).max(10).default([]),
  })
  .strict();
export type AlertChannels = z.infer<typeof alertChannelsSchema>;

const ruleFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  kind: alertRuleKindSchema,
  /** Logbird query language (not SQL mode). Empty = any event. Validated on save (422 `invalid_query`). */
  q: z.string().max(4096).default(''),
  /** `threshold` only. */
  windowMinutes: z.number().int().min(1).max(1440).optional(),
  /** `threshold` only. */
  comparator: z.enum(['>', '<']).optional(),
  /** `threshold` only: the count the window is compared with. */
  value: z.number().int().min(0).max(1_000_000_000).optional(),
  /** `threshold` only: evaluate per value of this field. */
  groupBy: alertGroupBySchema.nullable().optional(),
  /** `silence` only. */
  silenceMinutes: z.number().int().min(1).max(1440).optional(),
  /** `silence` only: `first_event` (default) arms on the first matching event; `now` arms at creation. */
  silenceArm: z.enum(['first_event', 'now']).optional(),
  /** `match` only: minutes without a new match before the incident resolves (default 15). */
  quietMinutes: z.number().int().min(1).max(1440).optional(),
  /** At most one firing notification per rule and group per cooldown (default 15). */
  cooldownMinutes: z.number().int().min(0).max(1440).default(15),
  channels: alertChannelsSchema.default({ emails: [], webhookEndpointIds: [] }),
  enabled: z.boolean().default(true),
};

const kindRules = (input: Record<string, unknown>, ctx: z.RefinementCtx) => {
  const need = (field: string, kinds: AlertRuleKind[]) => {
    const present = input[field] !== undefined && input[field] !== null;
    const allowed = kinds.includes(input.kind as AlertRuleKind);
    if (present && !allowed) ctx.addIssue({ code: 'custom', path: [field], message: `${field} applies to ${kinds.join('/')} rules only.` });
  };
  need('windowMinutes', ['threshold']);
  need('comparator', ['threshold']);
  need('value', ['threshold']);
  need('groupBy', ['threshold']);
  need('silenceMinutes', ['silence']);
  need('silenceArm', ['silence']);
  need('quietMinutes', ['match']);
  if (input.kind === 'threshold')
    for (const field of ['windowMinutes', 'comparator', 'value'])
      if (input[field] === undefined) ctx.addIssue({ code: 'custom', path: [field], message: `Threshold rules need ${field}.` });
  if (input.kind === 'silence' && input.silenceMinutes === undefined)
    ctx.addIssue({ code: 'custom', path: ['silenceMinutes'], message: 'Silence rules need silenceMinutes.' });
};

/** `POST /api/projects/:projectId/alerts` (owners/admins). At most `ALERT_RULES_PER_PROJECT` rules (default 20). */
export const createAlertRuleSchema = z.object(ruleFields).strict().superRefine(kindRules);
export type CreateAlertRule = z.infer<typeof createAlertRuleSchema>;

/**
 * `PATCH /api/projects/:projectId/alerts/:ruleId` (owners/admins). `kind` cannot change. `muted: true` mutes until
 * unmuted; `mutedUntil` snoozes until a time (null clears). While muted the rule evaluates and records incidents but
 * sends nothing; unmuting replays nothing.
 */
export const updateAlertRuleSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(ruleFields)
        .filter(([k]) => k !== 'kind')
        .map(([k, v]) => [k, (v as z.ZodType).optional()]),
    ),
    muted: z.boolean().optional(),
    mutedUntil: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type UpdateAlertRule = z.infer<typeof updateAlertRuleSchema>;

export const alertRuleSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: alertRuleKindSchema,
  q: z.string(),
  windowMinutes: z.number().int().nullable(),
  comparator: z.enum(['>', '<']).nullable(),
  value: z.number().int().nullable(),
  groupBy: alertGroupBySchema.nullable(),
  silenceMinutes: z.number().int().nullable(),
  silenceArm: z.enum(['first_event', 'now']).nullable(),
  quietMinutes: z.number().int().nullable(),
  cooldownMinutes: z.number().int(),
  channels: z.object({ emails: z.array(z.string()), webhookEndpointIds: z.array(z.string()) }),
  enabled: z.boolean(),
  muted: z.boolean(),
  mutedUntil: z.string().nullable(),
  state: alertStateSchema,
  /** Groups currently firing (threshold with groupBy), else 0 or 1. */
  firingGroups: z.number().int(),
  /** Set when the rule cannot notify (it keeps evaluating). */
  channelError: z.enum(ALERT_CHANNEL_ERRORS).nullable(),
  lastEvaluatedAt: z.string().nullable(),
  /** Watermark of the last evaluation: events that arrived before it are counted. */
  evaluatedThrough: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type AlertRule = z.infer<typeof alertRuleSchema>;

/** One firing period of a rule (and group). Kept 90 days. */
export const alertIncidentSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  /** The group value for grouped thresholds, else null. */
  groupKey: z.string().nullable(),
  openedAt: z.string(),
  resolvedAt: z.string().nullable(),
  /** The count (threshold), matches (match) or minutes since the last event (silence) when it opened / at its peak. */
  openValue: z.number(),
  peakValue: z.number(),
  lastValue: z.number(),
  /** Up to 5 matching event ids (match, threshold), for links into the explorer. */
  sampleEventIds: z.array(z.string()),
  /** Whether notifications were suppressed (muted, snoozed, cooldown or rate limit). */
  suppressed: z.boolean(),
});
export type AlertIncident = z.infer<typeof alertIncidentSchema>;
export const alertIncidentListSchema = z.object({ data: z.array(alertIncidentSchema), nextCursor: z.string().nullable() });

/** `GET …/alerts/preview`: what a rule with these settings would see right now (for the create form). */
export const alertPreviewQuerySchema = z.object({
  kind: alertRuleKindSchema,
  q: z.string().max(4096).optional(),
  windowMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  silenceMinutes: z.coerce.number().int().min(1).max(1440).optional(),
  groupBy: alertGroupBySchema.optional(),
});
export const alertPreviewSchema = z.object({
  /** Matches since the window start (match/threshold), or minutes since the last matching event (silence; null = never). */
  value: z.number().nullable(),
  /** Top groups by count (threshold with groupBy), at most 50. */
  groups: z.array(z.object({ key: z.string(), count: z.number().int() })).optional(),
  evaluatedThrough: z.string(),
});
export type AlertPreview = z.infer<typeof alertPreviewSchema>;

/**
 * Body of `logbird.alert.firing`, `logbird.alert.resolved` and `logbird.alert.test` webhook messages (Standard
 * Webhooks, signed with the endpoint's secret). One message per rule per evaluation: grouped thresholds list their
 * groups (at most 20, with `moreGroups`). Times are ISO-8601 UTC. Ids, never event payloads.
 */
export const alertWebhookBodySchema = z.object({
  type: z.enum(['logbird.alert.firing', 'logbird.alert.resolved', 'logbird.alert.test']),
  projectId: z.string(),
  rule: z.object({ id: z.string(), name: z.string(), kind: alertRuleKindSchema, q: z.string() }),
  incidents: z.array(
    z.object({ id: z.string(), groupKey: z.string().nullable(), openedAt: z.string(), resolvedAt: z.string().nullable(), value: z.number() }),
  ),
  moreGroups: z.number().int(),
  window: z.object({ from: z.string(), to: z.string() }).nullable(),
  sampleEventIds: z.array(z.string()),
  consoleUrl: z.string(),
});
export type AlertWebhookBody = z.infer<typeof alertWebhookBodySchema>;

/**
 * Alert routes (session auth). Owners and admins manage rules; members read rules and incidents. Moved into `routes`
 * with the implementation PR (the route-authorization matrix requires every listed route to exist).
 */
export const alertRoutes = {
  list: { method: 'GET', path: '/api/projects/:projectId/alerts', auth: 'session' }, // → { data: AlertRule[] }
  create: { method: 'POST', path: '/api/projects/:projectId/alerts', auth: 'session' }, // CreateAlertRule → 201 AlertRule
  get: { method: 'GET', path: '/api/projects/:projectId/alerts/:ruleId', auth: 'session' }, // → AlertRule
  update: { method: 'PATCH', path: '/api/projects/:projectId/alerts/:ruleId', auth: 'session' }, // UpdateAlertRule → AlertRule
  remove: { method: 'DELETE', path: '/api/projects/:projectId/alerts/:ruleId', auth: 'session' }, // → 204
  incidents: { method: 'GET', path: '/api/projects/:projectId/alerts/:ruleId/incidents', auth: 'session' }, // ?cursor= → AlertIncidentList
  test: { method: 'POST', path: '/api/projects/:projectId/alerts/:ruleId/test', auth: 'session' }, // → 202, rate limited
  preview: { method: 'GET', path: '/api/projects/:projectId/alerts/preview', auth: 'session' }, // AlertPreviewQuery → AlertPreview
} as const;
