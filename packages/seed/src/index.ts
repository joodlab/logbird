import type { EventInput } from '@logbird/sdk';
import { type Action, businesses, hospitalityActions, ledgerActions, support, users } from './catalog';

export interface SeedOptions {
  events: number;
  days: number;
  project: string;
  seed?: number;
  now?: Date;
}
const DAY = 86_400_000;
const HOUR = 3_600_000;
const cities = ['Makkah', 'Madinah', 'Riyadh', 'Jeddah', 'Al Khobar', 'Doha'];
const rooms = ['Deluxe King Room', 'Family Courtyard Suite', 'Superior Twin Room', 'Palm View Studio'];
const campaigns = ['Ramadan Early Booking 20%', 'Umrah Season Packages', 'Return to the Courtyard', 'Weekend Family Escape'];
const agents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1',
];

export function* generateEvents(options: SeedOptions): Generator<EventInput> {
  const end = (options.now ?? new Date()).getTime();
  if (
    !Number.isInteger(options.events) ||
    options.events < 1 ||
    !Number.isFinite(options.days) ||
    options.days <= 0 ||
    !Number.isFinite(end) ||
    !Number.isInteger(options.seed ?? 42)
  )
    throw new Error('Invalid seed options');
  let state = (options.seed ?? 42) >>> 0;
  const random = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)] as T;
  const start = end - options.days * DAY;
  const ledger = options.project.toLowerCase().includes('ledger');
  const vocabulary = ledger ? ledgerActions : hospitalityActions;
  let emitted = 0;
  let operation = 0;
  // Two independently staggered hourly feeds, for 12 enabled businesses. This
  // stream is bounded by the requested count; small fixtures are valid prefixes.
  let tick = Math.ceil(start / HOUR) * HOUR;
  let scheduledBusiness = 0;
  let scheduledResource = 0;
  while (emitted < options.events) {
    const scheduled = !ledger && tick + 35 * 60_000 < end;
    const biz = scheduled ? scheduledBusiness : Math.floor(random() ** 2.1 * 30);
    const tenantName = ledger
      ? `${['Cedar Quill', 'Copper Fern', 'Amber Folio', 'Juniper Loom', 'Moonstone Desk'][biz % 5]} Trading`
      : (businesses[biz] as string);
    // Five staff per business, with the first staff member busiest.
    const user = users[biz * 5 + Math.floor(random() ** 1.8 * 5)] as (typeof users)[number];
    const websiteIndex = Math.floor(random() * (1 + (biz % 3)));
    const website = {
      type: 'website',
      id: `web_${biz + 1}_${websiteIndex + 1}`,
      name: `${tenantName.toLowerCase().replaceAll(' ', '-')}${websiteIndex ? `-${websiteIndex + 1}` : ''}.example.com`,
    };
    const op = `${options.project}-s${options.seed ?? 42}-op${operation++}`;
    let timestamp = scheduled ? tick + (scheduledResource ? 35 : 5) * 60_000 : 0;
    if (!scheduled) {
      // Friday/Saturday weekend; office hours are interpreted in Asia/Riyadh.
      let accepted = false;
      while (!accepted) {
        timestamp = start + random() * Math.max(1, end - start - 10_000);
        const local = new Date(timestamp + 3 * HOUR);
        const age = (timestamp - start) / (end - start);
        const day = Math.floor((timestamp - start) / DAY);
        const spike = day === Math.floor(options.days * 0.55) || day === Math.floor(options.days * 0.8);
        const weight =
          ([5, 6].includes(local.getUTCDay()) ? 0.45 : 1) *
          (local.getUTCHours() >= 8 && local.getUTCHours() < 19 ? 1 : 0.18) *
          (0.35 + age * 0.65) *
          (spike ? 1 : 0.4);
        accepted = random() < weight;
      }
    }
    const day = Math.floor((timestamp - start) / DAY);
    const outage = day === Math.floor(options.days * 0.8);
    const importing = day === Math.floor(options.days * 0.55);
    const workflow = scheduled || random() < (ledger ? 0.15 : importing ? 0.65 : 0.23);
    const resource = ledger
      ? 'invoice approval'
      : scheduled
        ? scheduledResource
          ? 'bookings'
          : 'guests'
        : pick(['guests', 'bookings', 'catalog', 'translation', 'campaign', 'screenshot']);
    const provider = !ledger && !workflow && random() < 0.12 ? pick(['staybook', 'meta-whatsapp', 'payment-provider']) : undefined;
    const apiKey = !scheduled && !provider && random() < 0.04;
    const actor = scheduled
      ? { type: 'system', id: `crm-hourly-biz_${biz + 1}-${resource}`, name: `Hourly CRM ${resource} scheduler - ${tenantName}` }
      : provider
        ? { type: 'integration', id: provider, name: provider }
        : apiKey
          ? { type: 'api_key', id: `key_${biz + 1}`, name: `Catalog partner automation - ${tenantName}` }
          : user;
    const impersonated = actor.type === 'user' && random() < 0.02;
    const base: EventInput = {
      action: '',
      environment: 'production',
      schemaVersion: '1',
      actor,
      tenant: { id: `biz_${ledger ? (biz % 5) + 1 : biz + 1}`, name: tenantName },
      source: provider ?? (ledger ? 'ledger' : 'staydesk'),
      ...(impersonated ? { impersonator: { type: 'user', id: `support_${(biz % 3) + 1}`, name: support[biz % 3] } } : {}),
      metadata: {
        fictional: true,
        role: user.role,
        locale: biz % 3 === 0 ? 'ar' : 'en',
        ...(outage ? { incident: 'whatsapp-provider-outage' } : importing ? { incident: 'seasonal-crm-import' } : {}),
      },
      context: {
        operationId: op,
        ...(!scheduled && !provider
          ? {
              requestId: `req_${op}`,
              traceId: Array.from({ length: 4 }, () =>
                Math.floor(random() * 4_294_967_296)
                  .toString(16)
                  .padStart(8, '0'),
              ).join(''),
              ip: `${biz % 2 ? '203.0.113' : '198.51.100'}.${biz + 10}`,
              userAgent: pick(agents),
            }
          : {}),
      },
    };
    const event = (
      action: string,
      description: string,
      executor: EventInput['executor'],
      parent?: string,
      outcome = 'success',
      changes: EventInput['changes'] = [],
      targets: EventInput['targets'] = [website],
    ): EventInput => {
      const index = emitted++;
      const id = `${op}-${index}`;
      const result: EventInput = {
        ...base,
        id,
        action,
        occurredAt: new Date(Math.min(end - 1, timestamp + (index - operationStart) * 700)).toISOString(),
        description,
        executor,
        outcome,
        severity: outcome === 'failure' || outcome === 'unknown' ? 'warning' : 'info',
        changes,
        targets,
        context: { ...base.context, ...(parent ? { parentEventId: parent } : {}) },
      };
      // Precisely one in forty events exercises missing actor / legacy / custom keys.
      if (index % 40 === 39) {
        if (index % 120 === 39) {
          delete result.actor;
          result.performed_by = actor.id;
        } else if (index % 120 === 79) {
          delete result.schemaVersion;
          delete result.executor;
          result.legacy = { operator: actor.id, result: outcome };
        } else result.provider_extension = { region: 'gulf-test', revision: 2 };
      }
      return result;
    };
    const operationStart = emitted;
    if (workflow) {
      const config = ledger
        ? { queue: 'ledger-posting', job: 'journal:post', root: 'invoice.approval.requested', done: 'journal.posted', record: 'invoice.approved' }
        : resource === 'guests' || resource === 'bookings'
          ? {
              queue: 'business-crm',
              job: `crm:sync:${resource}`,
              root: 'crm.sync.requested',
              done: `crm.${resource}.sync.completed`,
              record: resource === 'guests' ? 'guest.updated' : 'booking.modified',
            }
          : resource === 'catalog'
            ? {
                queue: 'content',
                job: 'sync:business-hotels',
                root: 'catalog.sync.requested',
                done: 'catalog.sync.completed',
                record: 'catalog.hotel.synced',
              }
            : resource === 'translation'
              ? {
                  queue: 'content',
                  job: 'translation:article',
                  root: 'article.translation.requested',
                  done: 'article.translation.completed',
                  record: 'article.translated',
                }
              : resource === 'campaign'
                ? {
                    queue: 'business-crm',
                    job: 'crm:campaign:send',
                    root: 'campaign.send.requested',
                    done: 'campaign.sent',
                    record: 'campaign.recipient.delivered',
                  }
                : {
                    queue: 'website',
                    job: 'website:screenshot',
                    root: 'website.screenshot.requested',
                    done: 'website.screenshot.completed',
                    record: 'website.screenshot.captured',
                  };
      base.metadata = {
        ...base.metadata,
        queue: config.queue,
        jobName: config.job,
        ...(scheduled ? { schedulerId: actor.id, cron: resource === 'guests' ? '5 * * * *' : '35 * * * *' } : {}),
      };
      const root = event(config.root, `${actor.name} requested ${resource} processing for ${tenantName}.`, {
        type: scheduled ? 'scheduler' : 'api',
        id: scheduled ? actor.id : 'api-server',
        name: scheduled ? actor.name : 'API server',
      });
      yield root;
      let parent = root.id;
      const fails = random() < (outage && resource === 'campaign' ? 0.8 : 0.035);
      const attempts = fails ? (random() < 0.5 ? 2 : 3) : 1;
      for (let attempt = 1; attempt <= attempts && emitted < options.events; attempt++) {
        const failed = attempt < attempts;
        const partial = !failed && random() < 0.025;
        const unknown = !failed && outage && resource === 'campaign' && random() < 0.4;
        const job = event(
          failed ? `${config.queue}.job.failed` : config.done,
          unknown
            ? `${actor.name}'s ${resource} request timed out at the provider; delivery remains unconfirmed.`
            : `${actor.name}'s ${resource} request for ${tenantName} ${failed ? 'failed; retry queued' : partial ? 'completed with skipped records' : 'completed'}.`,
          { type: 'worker', id: `${config.queue}-worker`, name: `${config.queue} worker`, jobId: `job_${op}`, attempt },
          parent,
          failed ? 'failure' : unknown ? 'unknown' : partial ? 'partial' : 'success',
        );
        job.metadata = {
          ...base.metadata,
          ...(failed || unknown
            ? { errorCode: unknown ? 'PROVIDER_TIMEOUT' : 'PROVIDER_503' }
            : {
                examined: 120,
                created: 0,
                changed: importing ? 12 : 2,
                unchanged: 120 - (importing ? 12 : 2) - (partial ? 3 : 0),
                skipped: partial ? 3 : 0,
              }),
        };
        yield job;
        parent = job.id;
        if (!failed && !unknown) {
          for (let record = 0; record < (importing ? 12 : 2) && emitted < options.events; record++) {
            const type = ledger
              ? 'invoice'
              : resource === 'guests'
                ? 'guest'
                : resource === 'bookings'
                  ? 'booking'
                  : resource === 'catalog'
                    ? 'hotel'
                    : resource === 'translation'
                      ? 'article'
                      : resource === 'campaign'
                        ? 'guest'
                        : 'website';
            const target = {
              type,
              id: `${type}_${biz + 1}_${record + 1}`,
              name:
                type === 'invoice'
                  ? `INV-${8400 + biz * 100 + record + 1}`
                  : type === 'guest'
                    ? `Guest G-${biz + 1}-${record + 1} (masked)`
                    : type === 'booking'
                      ? `BK-${58_213 + biz * 100 + record + 1}`
                      : type === 'article'
                        ? 'Umrah Season Packages'
                        : type === 'hotel'
                          ? `${tenantName} ${cities[(record + 1) % cities.length]}`
                          : website.name,
            };
            yield event(
              config.record,
              `${actor.name}'s ${config.job} job ${resource === 'translation' ? 'translated' : 'processed'} ${target.name} for ${tenantName}.`,
              { type: 'worker', id: `${config.queue}-worker`, name: `${config.queue} worker`, jobId: `job_${op}`, attempt },
              job.id,
              'success',
              [
                {
                  field:
                    resource === 'campaign'
                      ? 'status'
                      : type === 'invoice'
                        ? 'status'
                        : type === 'guest'
                          ? 'locale'
                          : type === 'booking'
                            ? 'status'
                            : type === 'hotel'
                              ? 'isPublished'
                              : type === 'article'
                                ? 'title'
                                : 'screenshot',
                  before:
                    resource === 'campaign'
                      ? 'SENT'
                      : type === 'invoice'
                        ? 'PENDING_APPROVAL'
                        : type === 'guest'
                          ? 'en'
                          : type === 'booking'
                            ? 'PENDING'
                            : type === 'hotel'
                              ? false
                              : null,
                  after:
                    resource === 'campaign'
                      ? 'DELIVERED'
                      : type === 'invoice'
                        ? 'APPROVED'
                        : type === 'guest'
                          ? 'ar'
                          : type === 'booking'
                            ? 'CONFIRMED'
                            : type === 'hotel'
                              ? true
                              : type === 'article'
                                ? '\u0628\u0627\u0642\u0627\u062a \u0645\u0648\u0633\u0645 \u0627\u0644\u0639\u0645\u0631\u0629'
                                : 'https://assets.example.com/home.webp',
                },
              ],
              type === 'website' ? [website] : [target, website],
            );
          }
        }
      }
    } else {
      const spec: Action = provider
        ? provider === 'meta-whatsapp'
          ? (hospitalityActions.find((a) => a.action === (outage ? 'whatsapp.message.failed' : 'whatsapp.message.delivered')) as Action)
          : provider === 'staybook'
            ? (hospitalityActions.find((a) => a.action === 'booking.created') as Action)
            : {
                action: 'webhook.received',
                verb: 'received a payment notification for',
                field: 'providerStatus',
                before: 'pending',
                after: 'settled',
              }
        : pick(vocabulary);
      const type = spec.action.split('.')[0] as string;
      const record = Math.floor(random() * 40) + 1;
      const name =
        type === 'hotel'
          ? `${tenantName} ${cities[record % cities.length]}`
          : type === 'room' || type === 'rate_plan'
            ? rooms[record % rooms.length]
            : type === 'booking'
              ? `BK-${58_213 + biz * 100 + record}`
              : type === 'guest'
                ? `Guest G-${biz + 1}-${record} (masked)`
                : type === 'campaign'
                  ? campaigns[record % campaigns.length]
                  : type === 'article'
                    ? 'Umrah Season Packages'
                    : ledger
                      ? `${type.toUpperCase()}-${8400 + record}`
                      : website.name;
      const denied = !provider && random() < 0.008;
      const outcome = denied ? 'denied' : spec.action.endsWith('.failed') ? 'failure' : 'success';
      if (spec.action.startsWith('impersonation.')) base.impersonator = { type: 'user', id: `support_${(biz % 3) + 1}`, name: support[biz % 3] };
      const after =
        spec.field === 'domain'
          ? website.name
          : spec.action === 'hotel.created'
            ? name
            : spec.action === 'booking.hotel.linked'
              ? `hotel_${biz + 1}_1`
              : spec.action === 'guest.merged'
                ? `guest_${biz + 1}_27`
                : spec.after;
      const result = event(
        spec.action,
        denied
          ? `${actor.name} was denied permission to ${spec.verb} ${name}.`
          : `${actor.name} ${spec.verb} ${name}${spec.action === 'hotel.policy.updated' ? ' from 24h to 48h' : ''}.`,
        {
          type: provider ? 'webhook' : 'api',
          id: provider ? `${provider}-webhook` : 'api-server',
          name: provider ? `${provider} webhook` : 'API server',
        },
        undefined,
        outcome,
        denied ? [] : [{ field: spec.field, before: spec.before, after }],
        [{ type, id: `${type}_${biz + 1}_${record}`, name: name as string }, website],
      );
      if (['auth.otp.failed', 'integration.credential.rotated', 'member.role.changed', 'vendor.bank_details.changed'].includes(spec.action))
        result.severity = 'critical';
      yield result;
    }
    if (scheduled) {
      scheduledResource++;
      if (scheduledResource === 2) {
        scheduledResource = 0;
        scheduledBusiness++;
      }
      if (scheduledBusiness === 12) {
        scheduledBusiness = 0;
        tick += HOUR;
      }
    }
  }
}
