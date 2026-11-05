import { z } from 'zod';
import { eventSchema } from './events';

/* ------------------------------------------------------------------ */
/* Project setup status (GET /api/projects/:projectId/setup)           */
/* ------------------------------------------------------------------ */

/**
 * Ordered checklist. `required` steps decide whether the integration "works"; optional steps are recommended.
 * Every step is computed from real state (Postgres + ClickHouse), never from UI clicks, except `retention`
 * (an explicit "reviewed" acknowledgement, see `updateProjectSchema.retentionReviewed`).
 */
export const SETUP_STEPS = [
  'ingest_key', // a non-revoked ingest key exists
  'first_event', // at least one non-sample event was ever received
  'recent_events', // ≥ 1 non-sample event received in the last 24h
  'envelope', // avg conformance of recent non-sample events ≥ SETUP_CONFORMANCE_TARGET
  'operation_id', // ≥ 1 recent non-sample event carries context.operationId
  'retention', // retention window reviewed (acknowledged or changed) by a member
  'read_key', // a non-revoked read key exists (for products reading the audit trail)
  'teammate', // the workspace has another member or a pending invitation
] as const;
export const setupStepIdSchema = z.enum(SETUP_STEPS);
export type SetupStepId = z.infer<typeof setupStepIdSchema>;

export const SETUP_REQUIRED_STEPS: readonly SetupStepId[] = ['ingest_key', 'first_event', 'recent_events', 'envelope', 'retention'];

/** Average conformance (0..100) at which the envelope step counts as done. */
export const SETUP_CONFORMANCE_TARGET = 70;
/** Window used for the envelope / operationId checks: the most recent N non-sample events within 7 days. */
export const SETUP_ENVELOPE_SAMPLE = 10_000;

/**
 * done      – satisfied
 * todo      – never satisfied
 * attention – was satisfied but regressed or is only partly met (e.g. events stopped in the last 24h,
 *             conformance below target, only sample data so far)
 */
export const SETUP_STEP_STATUSES = ['done', 'todo', 'attention'] as const;
export const setupStepStatusSchema = z.enum(SETUP_STEP_STATUSES);

export const setupStepSchema = z.object({
  id: setupStepIdSchema,
  status: setupStepStatusSchema,
  required: z.boolean(),
  /** When the step first became true (key createdAt, first event time, reviewedAt…); null if unknown/never. */
  completedAt: z.string().nullable(),
});
export type SetupStep = z.infer<typeof setupStepSchema>;

/** Recommended envelope parts the envelope step reports coverage for, worst-covered first. */
export const ENVELOPE_FIELDS = ['actor', 'tenant', 'executor', 'targets', 'outcome', 'occurredAt'] as const;
export const envelopeFieldSchema = z.enum(ENVELOPE_FIELDS);
export type EnvelopeField = z.infer<typeof envelopeFieldSchema>;
/**
 * Explorer query (lang "query") that lists recent events missing the field, or null when the query language cannot
 * express it (outcome / occurredAt fall back to server defaults, so they are detected from the raw payload).
 */
export const ENVELOPE_MISSING_QUERIES: Record<EnvelopeField, string | null> = {
  actor: '-actor:*',
  tenant: '-tenant:*',
  executor: '-executor:*',
  targets: '-target:*',
  outcome: null,
  occurredAt: null,
};

/** Events loaded by "Load sample data" carry this `source`; they never count toward setup steps. */
export const SAMPLE_DATA_SOURCE = 'trailmark-sample';
export const SAMPLE_DATA_EVENTS = 2000;

export const projectSetupSchema = z.object({
  projectId: z.string(),
  generatedAt: z.string(),
  /** done = steps with status "done"; total = SETUP_STEPS.length. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  /** Every step is done. The overview card hides itself when complete or dismissed. */
  complete: z.boolean(),
  /** First step (in SETUP_STEPS order) that is not done, required steps first; null when complete. */
  nextStep: setupStepIdSchema.nullable(),
  /** Set via PATCH project { setupDismissed: true }; cleared with false. Workspace-wide, not per user. */
  dismissedAt: z.string().nullable(),
  steps: z.array(setupStepSchema),
  ingest: z.object({
    activeIngestKeys: z.number().int(),
    firstEventAt: z.string().nullable(), // non-sample events only (by receivedAt)
    /** The earliest non-sample event, so the first-event step can show what arrived. */
    firstEvent: eventSchema.nullable(),
    lastEventAt: z.string().nullable(), // non-sample
    eventsLast24h: z.number().int(), // non-sample
    sampleEvents: z.number().int(), // rows with source = SAMPLE_DATA_SOURCE
  }),
  envelope: z.object({
    sampledEvents: z.number().int(),
    avgConformance: z.number(), // 0..100, 0 when sampledEvents = 0
    target: z.number(), // SETUP_CONFORMANCE_TARGET
    /** All ENVELOPE_FIELDS, sorted by coverage ascending (most missing first). */
    fields: z.array(
      z.object({
        field: envelopeFieldSchema,
        coverage: z.number(), // 0..1 share of sampled events carrying it
        missingQuery: z.string().nullable(), // ENVELOPE_MISSING_QUERIES[field]
      }),
    ),
  }),
  operations: z.object({ coverage: z.number(), eventsWithOperationId: z.number().int() }),
  retention: z.object({ retentionDays: z.number().int(), reviewedAt: z.string().nullable() }),
  readKeys: z.object({ active: z.number().int() }),
  team: z.object({ members: z.number().int(), pendingInvitations: z.number().int() }),
});
export type ProjectSetup = z.infer<typeof projectSetupSchema>;

/* ------------------------------------------------------------------ */
/* Workspace setup summary (GET /api/workspace/setup)                  */
/* ------------------------------------------------------------------ */

/**
 * Resumable onboarding: `/` sends the user to `onboarding.next`.
 *  profile      – user has no display name
 *  workspace    – user has no active organization
 *  project      – active organization has no project
 *  first_event  – no project has received a non-sample event yet (projectId = most recently created project)
 *  null         – onboarding done → go to projectId's overview (most recently active project)
 */
export const ONBOARDING_STEPS = ['profile', 'workspace', 'project', 'first_event'] as const;
export const onboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const workspaceSetupSchema = z.object({
  organizationId: z.string().nullable(),
  onboarding: z.object({ next: onboardingStepSchema.nullable(), projectId: z.string().nullable() }),
  team: z.object({ members: z.number().int(), pendingInvitations: z.number().int() }),
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      slug: z.string(),
      progress: z.object({ done: z.number().int(), total: z.number().int() }),
      complete: z.boolean(),
      nextStep: setupStepIdSchema.nullable(),
      dismissedAt: z.string().nullable(),
      firstEventAt: z.string().nullable(),
    }),
  ),
});
export type WorkspaceSetup = z.infer<typeof workspaceSetupSchema>;

/* ------------------------------------------------------------------ */
/* Sample data (POST/DELETE /api/projects/:projectId/sample-data)      */
/* ------------------------------------------------------------------ */

/** POST loads SAMPLE_DATA_EVENTS synthetic events over the last 7 days (idempotent: replaces earlier sample rows). */
export const sampleDataResponseSchema = z.object({ inserted: z.number().int() });
export type SampleDataResponse = z.infer<typeof sampleDataResponseSchema>;
