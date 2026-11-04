/**
 * StayDesk-shaped synthetic activity: hotel businesses (tenants) with websites and hotels,
 * staff users, platform admins who impersonate, API keys, schedulers, workers and partner
 * webhooks. Each "scenario" is one operation: a request or trigger plus the jobs it spawned.
 */
import { type EventDraft, type EventDraftBase, normalize, type StoredEvent } from './normalize';
import { Rng, ulid } from './rng';

const BUSINESSES = [
  ['Azure Hotels', 'azurehotels.com'],
  ['Dunes Resort Group', 'dunesresorts.sa'],
  ['Nakheel Stays', 'nakheelstays.com'],
  ['Al Waha Hospitality', 'alwaha.sa'],
  ['Corniche Suites', 'corniche-suites.com'],
  ['Red Sea Retreats', 'redsearetreats.com'],
  ['Makkah Towers Hotel', 'makkahtowers.sa'],
  ['Jeddah Bay Inn', 'jeddahbayinn.com'],
  ['Taif Highlands Lodge', 'taifhighlands.sa'],
  ['Riyadh Grand', 'riyadhgrand.com'],
  ['AlUla Desert Camp', 'aluladesertcamp.com'],
  ['Abha Mountain Hotel', 'abhamountain.sa'],
  ['Medina Gardens', 'medinagardens.sa'],
  ['Khobar Beach Resort', 'khobarbeach.com'],
  ['Yanbu Marina Hotel', 'yanbumarina.com'],
  ['Hail Heritage Inn', 'hailheritage.sa'],
  ['Tabuk Oasis Hotels', 'tabukoasis.com'],
  ['Qassim Palms', 'qassimpalms.sa'],
  ['Najran Gate Hotel', 'najrangate.com'],
  ['Jazan Coral Resort', 'jazancoral.com'],
  ['Dammam Skyline', 'dammamskyline.sa'],
  ['Al Baha Retreat', 'albaharetreat.com'],
  ['Umluj Lagoon Villas', 'umlujlagoon.com'],
  ['Diriyah Courtyard', 'diriyahcourtyard.sa'],
  ['Sunrise Hospitality', 'sunrisehospitality.com'],
  ['Hejaz Rail Hotel', 'hejazrail.sa'],
  ['Farasan Island Stays', 'farasanstays.com'],
  ['Najd Boutique', 'najdboutique.sa'],
] as const;

const HOTEL_NAMES = [
  'Hotel Sunrise',
  'Palm Court',
  'Marina View',
  'Old Town Suites',
  'Garden Residence',
  'Skyline Tower',
  'Coral Bay',
  'Desert Rose',
  'Harbor Lights',
  'Cedar House',
  'Golden Sands',
  'Lantern Inn',
  'Pearl Plaza',
  'Oasis Lodge',
  'Falcon Heights',
];

const FIRST = [
  'Raed',
  'Lina',
  'Omar',
  'Sara',
  'Faisal',
  'Noura',
  'Khalid',
  'Reem',
  'Yousef',
  'Huda',
  'Tariq',
  'Maha',
  'Ahmed',
  'Layla',
  'Hassan',
  'Dana',
  'Saud',
  'Aisha',
  'Majed',
  'Rania',
  'Bilal',
  'Joud',
  'Nasser',
  'Hind',
  'Ziad',
  'Mona',
  'Fahad',
  'Salma',
  'Anas',
  'Lama',
  'Ibrahim',
  'Nada',
  'Waleed',
  'Ghada',
  'Hamza',
  'Shahad',
];
const LAST = [
  'Al-Harbi',
  'Al-Qahtani',
  'Haddad',
  'Al-Otaibi',
  'Nasser',
  'Al-Zahrani',
  'Saleh',
  'Al-Ghamdi',
  'Mansour',
  'Al-Shehri',
  'Khoury',
  'Al-Dosari',
  'Farouk',
  'Al-Mutairi',
  'Rahman',
];

const UA = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'StayDesk-Mobile/4.12 (Android 15; Pixel 8)',
];

export interface Person {
  type: string;
  id: string;
  name: string;
  email: string;
}
interface Business {
  id: string;
  name: string;
  domain: string;
  websiteId: string;
  plan: string;
  hotels: { id: string; name: string; rooms: { id: string; name: string }[] }[];
  staff: Person[];
}

export interface World {
  businesses: Business[];
  admins: Person[];
  rng: Rng;
}

const EXEC = {
  api: { type: 'api', id: 'api-server', name: 'API server' },
  crm: { type: 'worker', id: 'crm-worker', name: 'CRM worker' },
  content: { type: 'worker', id: 'content-worker', name: 'Content worker' },
  bookings: { type: 'worker', id: 'bookings-worker', name: 'Bookings worker' },
  media: { type: 'worker', id: 'media-worker', name: 'Media worker' },
  email: { type: 'worker', id: 'email-worker', name: 'Email worker' },
  ads: { type: 'worker', id: 'ads-worker', name: 'Ads worker' },
  rates: { type: 'scheduler', id: 'nightly-rates', name: 'Nightly rates scheduler' },
  crmSched: { type: 'scheduler', id: 'crm-sync-scheduler', name: 'CRM sync scheduler' },
  jbHook: { type: 'webhook', id: 'staybook-webhook', name: 'StayBook webhook' },
  waHook: { type: 'webhook', id: 'whatsapp-webhook', name: 'Meta WhatsApp webhook' },
  payHook: { type: 'webhook', id: 'payflow-webhook', name: 'PayFlow webhook' },
} as const;

const SYSTEM: Person = { type: 'system', id: 'system', name: 'System', email: '' };
const JB_INTEGRATION: Person = { type: 'integration', id: 'int_staybook', name: 'StayBook', email: '' };
const PAYFLOW: Person = { type: 'integration', id: 'int_payflow', name: 'PayFlow', email: '' };
const WHATSAPP: Person = { type: 'integration', id: 'int_whatsapp', name: 'Meta WhatsApp', email: '' };
const SYNC_KEY: Person = { type: 'api_key', id: 'key_jb_sync', name: 'StayBook sync key', email: '' };

export function buildWorld(seed = 7): World {
  const rng = new Rng(seed);
  let personSeq = 40;
  let hotelSeq = 100;
  let roomSeq = 1000;
  // Reserved for the flagship actor (usr_42) so no generated person shares the name.
  const usedNames = new Set<string>(['Raed Al-Harbi']);
  const person = (): Person => {
    let name = '';
    do {
      name = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
    } while (usedNames.has(name));
    usedNames.add(name);
    const id = `usr_${personSeq++}`;
    const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${rng.pick(['acme.sa', 'gmail.com', 'outlook.com', 'hotelmail.sa'])}`;
    return { type: 'user', id, name, email };
  };
  const businesses: Business[] = BUSINESSES.map(([name, domain], i) => {
    const hotels = Array.from({ length: rng.int(1, 4) }, () => {
      const hotelId = `hotel_${hotelSeq++}`;
      return {
        id: hotelId,
        name: rng.pick(HOTEL_NAMES) + (rng.chance(0.4) ? ` ${rng.pick(['Jeddah', 'Riyadh', 'Makkah', 'Medina', 'Khobar', 'Abha', 'AlUla'])}` : ''),
        rooms: Array.from({ length: rng.int(2, 5) }, () => ({
          id: `room_${roomSeq++}`,
          name: rng.pick(['Deluxe King', 'Twin Classic', 'Family Suite', 'Sea View Double', 'Executive Suite', 'Studio']),
        })),
      };
    });
    return {
      id: `biz_${i + 1}`,
      name,
      domain,
      websiteId: `web_${i + 1}`,
      plan: rng.weighted([
        ['starter', 3],
        ['pro', 5],
        ['business', 2],
      ] as const),
      hotels,
      staff: Array.from({ length: rng.int(2, 6) }, person),
    };
  });
  // The first business is the flagship used in docs examples: Raed changing Hotel Sunrise.
  const flagship = businesses[0];
  if (flagship) {
    flagship.staff[0] = { type: 'user', id: 'usr_42', name: 'Raed Al-Harbi', email: 'raed@azurehotels.com' };
    if (flagship.hotels[0]) flagship.hotels[0] = { ...flagship.hotels[0], id: 'hotel_123', name: 'Hotel Sunrise' };
  }
  const admins: Person[] = [
    { type: 'user', id: 'usr_1', name: 'Lina Haddad (support)', email: 'lina@acme.sa' },
    { type: 'user', id: 'usr_2', name: 'Sami Khoury (platform)', email: 'sami@acme.sa' },
  ];
  return { businesses, admins, rng };
}

type Emit = (draft: Omit<EventDraftBase, 'id' | 'occurredAt'> & { at: number } & Record<string, unknown>) => string;

interface Ctx {
  rng: Rng;
  emit: Emit;
  biz: Business;
  t: number;
  admins: Person[];
  /** Support ticket of the impersonation session this work belongs to. */
  ticket?: string;
}

function req(rng: Rng) {
  return {
    requestId: `req_${rng.alnum(10)}`,
    traceId: rng.hex(32),
    ip: `${rng.pick(['185.38', '51.36', '94.97', '212.71', '203.0'])}.${rng.int(1, 254)}.${rng.int(1, 254)}`,
    userAgent: rng.pick(UA),
  };
}

const POLICY_FIELDS = [
  ['cancellationHours', () => [24, 48, 72], 'the cancellation policy'],
  ['checkInTime', () => ['14:00', '15:00', '16:00'], 'the check-in time'],
  ['checkOutTime', () => ['11:00', '12:00'], 'the check-out time'],
  ['childPolicy', () => ['free under 6', 'free under 12', 'charged'], 'the child policy'],
  ['petsAllowed', () => [false, true], 'the pet policy'],
] as const;

function crmSync(c: Ctx, actor: Person, opId: string, parentId: string, start: number, contacts: number, failFirst: boolean): number {
  const { rng, emit, biz } = c;
  let t = start;
  const jobId = String(rng.int(10_000, 99_999));
  const attempts = failFirst ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failing = failFirst && attempt === 1;
    const started = emit({
      at: t,
      action: 'crm.sync.started',
      description: `CRM worker started syncing ${biz.name} contacts${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
      actor,
      executor: { ...EXEC.crm, jobId, attempt },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'crm_account', id: `crm_${biz.id}`, name: `${biz.name} (HubSpot)` }],
      context: { operationId: opId, parentEventId: parentId },
      metadata: { queue: 'crm', provider: 'hubspot', batchSize: contacts },
    });
    t += rng.int(300, 1800);
    if (failing) {
      emit({
        at: t,
        action: 'crm.sync.failed',
        outcome: 'failure',
        severity: 'warning',
        description: `CRM sync for ${biz.name} failed: HubSpot returned 429 Too Many Requests`,
        actor,
        executor: { ...EXEC.crm, jobId, attempt },
        tenant: { id: biz.id, name: biz.name },
        targets: [{ type: 'crm_account', id: `crm_${biz.id}`, name: `${biz.name} (HubSpot)` }],
        context: { operationId: opId, parentEventId: started },
        metadata: { error: { code: 'RATE_LIMITED', status: 429, retryInMs: 30_000 }, queue: 'crm' },
      });
      t += 30_000 + rng.int(0, 4000);
      continue;
    }
    for (let i = 0; i < contacts; i++) {
      const guest = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
      emit({
        at: t,
        action: 'crm.sync.contact.upserted',
        description: `CRM worker upserted contact ${guest}`,
        actor,
        executor: { ...EXEC.crm, jobId, attempt },
        tenant: { id: biz.id, name: biz.name },
        targets: [{ type: 'guest', id: `guest_${rng.int(10_000, 99_999)}`, name: guest }],
        context: { operationId: opId, parentEventId: started },
        metadata: { provider: 'hubspot', crmId: `hs_${rng.int(1_000_000, 9_999_999)}` },
      });
      t += rng.int(40, 400);
    }
    emit({
      at: t,
      action: 'crm.sync.completed',
      description: `CRM worker synced ${contacts} contact${contacts === 1 ? '' : 's'} for ${biz.name}`,
      actor,
      executor: { ...EXEC.crm, jobId, attempt },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'crm_account', id: `crm_${biz.id}`, name: `${biz.name} (HubSpot)` }],
      context: { operationId: opId, parentEventId: started },
      metadata: { contacts, durationMs: t - start },
    });
  }
  return t;
}

function supportMeta(c: Ctx, impersonator?: Person): Record<string, unknown> {
  return impersonator ? { supportTicket: c.ticket ?? `SUP-${c.rng.int(1000, 9999)}` } : {};
}

function hotelEdit(c: Ctx, actor: Person, impersonator?: Person) {
  const { rng, emit, biz } = c;
  const hotel = rng.pick(biz.hotels);
  const opId = `op_${rng.alnum(10)}`;
  const r = req(rng);
  const kind = rng.weighted([
    ['policy', 4],
    ['rate', 4],
    ['room', 3],
    ['hotel', 2],
    ['publish', 1],
  ] as const);
  const base = {
    actor,
    impersonator: impersonator ? { id: impersonator.id, name: impersonator.name } : undefined,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
  };
  const first = actor.name.split(' ')[0];
  let parent = '';
  if (kind === 'policy') {
    const [field, values, label] = rng.pick(POLICY_FIELDS);
    const options = values() as readonly unknown[];
    const before = rng.pick(options);
    let after = rng.pick(options);
    if (after === before) after = options[(options.indexOf(before) + 1) % options.length];
    parent = emit({
      at: c.t,
      action: 'hotel.policy.updated',
      severity: field === 'cancellationHours' ? 'notice' : 'info',
      description: `${first} changed ${label} of ${hotel.name}`,
      ...base,
      targets: [
        { type: 'hotel', id: hotel.id, name: hotel.name },
        { type: 'website', id: biz.websiteId, name: biz.domain },
      ],
      changes: [{ field, before, after }],
      context: { operationId: opId, ...r },
      metadata: {
        plan: biz.plan,
        channel: rng.pick(['web', 'web', 'mobile']),
        http: { method: 'PATCH', route: '/hotels/:id/policy', status: 200 },
        ...supportMeta(c, impersonator),
      },
    });
  } else if (kind === 'rate') {
    const room = rng.pick(hotel.rooms);
    const before = rng.int(45, 160) * 10;
    const after = before + rng.pick([-100, -50, 50, 100, 150, 200]);
    parent = emit({
      at: c.t,
      action: 'rate.updated',
      description: `${first} changed the ${room.name} rate at ${hotel.name} from SAR ${before} to SAR ${after}`,
      ...base,
      targets: [
        { type: 'rate_plan', id: `rp_${room.id}`, name: `${room.name} · Flexible` },
        { type: 'hotel', id: hotel.id, name: hotel.name },
      ],
      changes: [
        { field: 'price', before, after },
        { field: 'currency', before: 'SAR', after: 'SAR' },
      ],
      context: { operationId: opId, ...r },
      metadata: { plan: biz.plan, channel: 'web', season: rng.pick(['ramadan', 'summer', 'hajj', 'standard']), ...supportMeta(c, impersonator) },
    });
  } else if (kind === 'room') {
    const room = rng.pick(hotel.rooms);
    const action = rng.weighted([
      ['room.updated', 6],
      ['room.created', 2],
      ['room.deleted', 1],
    ] as const);
    const verb = { 'room.updated': 'updated', 'room.created': 'added', 'room.deleted': 'removed' }[action];
    parent = emit({
      at: c.t,
      action,
      severity: action === 'room.deleted' ? 'notice' : 'info',
      description: `${first} ${verb} ${room.name} at ${hotel.name}`,
      ...base,
      targets: [
        { type: 'room', id: room.id, name: room.name },
        { type: 'hotel', id: hotel.id, name: hotel.name },
      ],
      changes:
        action === 'room.updated'
          ? [
              { field: 'maxOccupancy', before: rng.int(2, 3), after: rng.int(3, 5) },
              { field: 'bedType', before: 'queen', after: rng.pick(['king', 'twin']) },
            ]
          : [],
      context: { operationId: opId, ...r },
      metadata: { plan: biz.plan, channel: 'web', ...supportMeta(c, impersonator) },
    });
  } else if (kind === 'hotel') {
    parent = emit({
      at: c.t,
      action: 'hotel.updated',
      description: `${first} updated the details of ${hotel.name}`,
      ...base,
      targets: [{ type: 'hotel', id: hotel.id, name: hotel.name }],
      changes: [
        { field: 'starRating', before: 4, after: 5 },
        { field: 'amenities', before: ['wifi', 'parking'], after: ['wifi', 'parking', 'spa'] },
      ],
      context: { operationId: opId, ...r },
      metadata: { plan: biz.plan, channel: 'web', ...supportMeta(c, impersonator) },
    });
  } else {
    parent = emit({
      at: c.t,
      action: 'hotel.published',
      severity: 'notice',
      description: `${first} published ${hotel.name} to ${biz.domain}`,
      ...base,
      targets: [
        { type: 'hotel', id: hotel.id, name: hotel.name },
        { type: 'website', id: biz.websiteId, name: biz.domain },
      ],
      context: { operationId: opId, ...r },
      metadata: { plan: biz.plan, ...supportMeta(c, impersonator) },
    });
  }
  let t = c.t + rng.int(80, 600);
  if (rng.chance(0.55)) {
    const catalogJob = String(rng.int(10_000, 99_999));
    const started = emit({
      at: t,
      action: 'catalog.sync.started',
      description: `Bookings worker started pushing ${hotel.name} to StayBook`,
      actor,
      executor: { ...EXEC.bookings, jobId: catalogJob, attempt: 1 },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'hotel', id: hotel.id, name: hotel.name }],
      context: { operationId: opId, parentEventId: parent },
      source: 'staybook',
      metadata: { queue: 'catalog', channel: 'staybook', ...supportMeta(c, impersonator) },
    });
    t += rng.int(400, 3000);
    const partial = rng.chance(0.06);
    emit({
      at: t,
      action: partial ? 'catalog.sync.partial' : 'catalog.sync.completed',
      outcome: partial ? 'partial' : 'success',
      severity: partial ? 'warning' : 'info',
      description: partial
        ? `StayBook accepted ${hotel.name} but rejected 2 room types (missing photos)`
        : `StayBook accepted the ${hotel.name} catalog update`,
      actor,
      executor: { ...EXEC.bookings, jobId: catalogJob, attempt: 1 },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'hotel', id: hotel.id, name: hotel.name }],
      context: { operationId: opId, parentEventId: started },
      source: 'staybook',
      metadata: partial ? { rejected: ['room_types.family_suite', 'room_types.studio'], reason: 'missing_photos' } : { accepted: true },
    });
  }
  if (rng.chance(0.3)) crmSync(c, actor, opId, parent, t + rng.int(100, 900), rng.int(1, 3), rng.chance(0.18));
}

function bookingWebhook(c: Ctx) {
  const { rng, emit, biz } = c;
  const hotel = rng.pick(biz.hotels);
  const room = rng.pick(hotel.rooms);
  const opId = `op_${rng.alnum(10)}`;
  const bookingId = `bk_${rng.int(100_000, 999_999)}`;
  const guest = `${rng.pick(FIRST)} ${rng.pick(LAST)}`;
  const guestId = `guest_${rng.int(10_000, 99_999)}`;
  const nights = rng.int(1, 6);
  const amount = nights * rng.int(40, 140) * 10;
  const parent = emit({
    at: c.t,
    action: 'booking.created',
    description: `${guest} booked ${nights} night${nights === 1 ? '' : 's'} in a ${room.name} at ${hotel.name} via StayBook`,
    actor: JB_INTEGRATION,
    executor: EXEC.jbHook,
    tenant: { id: biz.id, name: biz.name },
    source: 'staybook',
    targets: [
      { type: 'booking', id: bookingId, name: `Booking ${bookingId.toUpperCase()}` },
      { type: 'hotel', id: hotel.id, name: hotel.name },
      { type: 'guest', id: guestId, name: guest },
    ],
    context: { operationId: opId, requestId: `req_${rng.alnum(10)}`, traceId: rng.hex(32) },
    metadata: { nights, amount, currency: 'SAR', channel: 'staybook', webhook: { deliveryId: `dlv_${rng.alnum(12)}` } },
  });
  let t = c.t + rng.int(50, 400);
  emit({
    at: t,
    action: rng.chance(0.7) ? 'guest.created' : 'guest.updated',
    description: `Bookings worker saved guest profile ${guest}`,
    actor: JB_INTEGRATION,
    executor: { ...EXEC.bookings, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'guest', id: guestId, name: guest }],
    changes: [{ field: 'phone', before: '[redacted]', after: '[redacted]' }],
    context: { operationId: opId, parentEventId: parent },
    source: 'staybook',
  });
  t += rng.int(200, 2500);
  const bounced = rng.chance(0.03);
  emit({
    at: t,
    action: 'email.sent',
    outcome: bounced ? 'failure' : 'success',
    severity: bounced ? 'warning' : 'info',
    description: bounced ? `Booking confirmation to ${guest} bounced (mailbox full)` : `Email worker sent the booking confirmation to ${guest}`,
    actor: JB_INTEGRATION,
    executor: { ...EXEC.email, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
    tenant: { id: biz.id, name: biz.name },
    targets: [
      { type: 'guest', id: guestId, name: guest },
      { type: 'booking', id: bookingId, name: `Booking ${bookingId.toUpperCase()}` },
    ],
    context: { operationId: opId, parentEventId: parent },
    metadata: { template: 'booking-confirmation', locale: rng.pick(['ar', 'en']), provider: 'ses' },
  });
  if (rng.chance(0.5)) {
    t += rng.int(200, 1500);
    const failed = rng.chance(0.05);
    emit({
      at: t,
      action: failed ? 'booking.payment.failed' : 'booking.payment.captured',
      outcome: failed ? 'failure' : 'success',
      severity: failed ? 'critical' : 'info',
      description: failed
        ? `PayFlow declined SAR ${amount} for ${bookingId.toUpperCase()} (insufficient funds)`
        : `PayFlow captured SAR ${amount} for ${bookingId.toUpperCase()}`,
      actor: PAYFLOW,
      executor: EXEC.payHook,
      tenant: { id: biz.id, name: biz.name },
      source: 'payflow',
      targets: [{ type: 'booking', id: bookingId, name: `Booking ${bookingId.toUpperCase()}` }],
      context: { operationId: opId, parentEventId: parent },
      metadata: {
        amount,
        currency: 'SAR',
        psp: 'payflow',
        card: { brand: rng.pick(['visa', 'mada', 'mastercard']), last4: String(rng.int(1000, 9999)) },
      },
    });
  }
  if (rng.chance(0.25)) crmSync(c, JB_INTEGRATION, opId, parent, t + rng.int(100, 900), 1, rng.chance(0.1));
}

function bookingStaff(c: Ctx, actor: Person, impersonator?: Person) {
  const { rng, emit, biz } = c;
  const hotel = rng.pick(biz.hotels);
  const bookingId = `bk_${rng.int(100_000, 999_999)}`;
  const action = rng.weighted([
    ['booking.confirmed', 4],
    ['booking.modified', 3],
    ['booking.cancelled', 2],
    ['booking.refunded', 1],
  ] as const);
  const first = actor.name.split(' ')[0];
  const verb = {
    'booking.confirmed': 'confirmed',
    'booking.modified': 'changed the dates of',
    'booking.cancelled': 'cancelled',
    'booking.refunded': 'refunded',
  }[action];
  const denied = action === 'booking.refunded' && rng.chance(0.3);
  emit({
    at: c.t,
    action,
    outcome: denied ? 'denied' : 'success',
    severity: denied ? 'notice' : action === 'booking.cancelled' ? 'notice' : 'info',
    description: denied
      ? `${first} tried to refund ${bookingId.toUpperCase()} but lacks the refunds permission`
      : `${first} ${verb} ${bookingId.toUpperCase()} at ${hotel.name}`,
    actor,
    impersonator: impersonator ? { id: impersonator.id, name: impersonator.name } : undefined,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [
      { type: 'booking', id: bookingId, name: `Booking ${bookingId.toUpperCase()}` },
      { type: 'hotel', id: hotel.id, name: hotel.name },
    ],
    changes:
      action === 'booking.modified'
        ? [
            { field: 'checkIn', before: '2026-11-12', after: '2026-11-14' },
            { field: 'checkOut', before: '2026-11-15', after: '2026-11-17' },
          ]
        : action === 'booking.cancelled'
          ? [{ field: 'status', before: 'confirmed', after: 'cancelled' }]
          : [],
    context: { operationId: `op_${rng.alnum(10)}`, ...req(rng) },
    metadata: { ...(denied ? { permission: 'bookings.refund', role: 'front_desk' } : { channel: 'web' }), ...supportMeta(c, impersonator) },
  });
}

function content(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const first = actor.name.split(' ')[0];
  const opId = `op_${rng.alnum(10)}`;
  const r = req(rng);
  const kind = rng.weighted([
    ['article', 4],
    ['page', 3],
    ['website', 2],
    ['theme', 1],
  ] as const);
  const title = rng.pick([
    'Ramadan offers 2026',
    'Top 10 things to do in AlUla',
    'Family weekend packages',
    'Our new rooftop restaurant',
    'Hajj season FAQ',
    'Winter in Abha',
    'Meet our chef',
  ]);
  if (kind === 'article') {
    const action = rng.pick(['article.created', 'article.updated', 'article.published'] as const);
    const verb = { 'article.created': 'drafted', 'article.updated': 'edited', 'article.published': 'published' }[action];
    emit({
      at: c.t,
      action,
      description: `${first} ${verb} the article “${title}” on ${biz.domain}`,
      actor,
      executor: EXEC.api,
      tenant: { id: biz.id, name: biz.name },
      targets: [
        { type: 'article', id: `art_${rng.int(1000, 9999)}`, name: title },
        { type: 'website', id: biz.websiteId, name: biz.domain },
      ],
      changes: action === 'article.updated' ? [{ field: 'title', before: `${title} (draft)`, after: title }] : [],
      context: { operationId: opId, ...r },
      metadata: { locale: rng.pick(['ar', 'en']), words: rng.int(300, 1800) },
    });
  } else if (kind === 'page') {
    const page = rng.pick(['Home', 'Rooms', 'Offers', 'Contact', 'About us', 'Gallery']);
    emit({
      at: c.t,
      action: rng.pick(['page.updated', 'page.published'] as const),
      description: `${first} updated the ${page} page on ${biz.domain}`,
      actor,
      executor: EXEC.api,
      tenant: { id: biz.id, name: biz.name },
      targets: [
        { type: 'page', id: `page_${rng.int(100, 999)}`, name: page },
        { type: 'website', id: biz.websiteId, name: biz.domain },
      ],
      changes: [{ field: 'blocks', before: rng.int(4, 8), after: rng.int(5, 10) }],
      context: { operationId: opId, ...r },
    });
  } else if (kind === 'theme') {
    emit({
      at: c.t,
      action: 'website.theme.updated',
      description: `${first} switched ${biz.domain} to the “${rng.pick(['Sahara', 'Coast', 'Minimal'])}” theme`,
      actor,
      executor: EXEC.api,
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'website', id: biz.websiteId, name: biz.domain }],
      changes: [
        { field: 'theme', before: 'Classic', after: rng.pick(['Sahara', 'Coast', 'Minimal']) },
        { field: 'primaryColor', before: '#0f766e', after: '#b45309' },
      ],
      context: { operationId: opId, ...r },
    });
  } else {
    const parent = emit({
      at: c.t,
      action: 'website.published',
      severity: 'notice',
      description: `${first} published ${biz.domain}`,
      actor,
      executor: EXEC.api,
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'website', id: biz.websiteId, name: biz.domain }],
      context: { operationId: opId, ...r },
      metadata: { pages: 6, build: { id: `bld_${rng.alnum(8)}`, cache: 'purged' } },
    });
    const job = String(rng.int(10_000, 99_999));
    let t = c.t + rng.int(200, 900);
    for (const page of ['Home', 'Rooms', 'Offers', 'Contact'].slice(0, rng.int(2, 4))) {
      emit({
        at: t,
        action: 'page.rendered',
        description: `Content worker rendered the ${page} page of ${biz.domain}`,
        actor,
        executor: { ...EXEC.content, jobId: job, attempt: 1 },
        tenant: { id: biz.id, name: biz.name },
        targets: [{ type: 'page', id: `page_${rng.int(100, 999)}`, name: page }],
        context: { operationId: opId, parentEventId: parent },
        metadata: { durationMs: rng.int(80, 1400), locale: 'ar' },
      });
      t += rng.int(150, 1300);
    }
    const imgs = rng.int(2, 9);
    emit({
      at: t,
      action: 'media.processed',
      description: `Media worker optimized ${imgs} images for ${biz.domain}`,
      actor,
      executor: { ...EXEC.media, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'website', id: biz.websiteId, name: biz.domain }],
      context: { operationId: opId, parentEventId: parent },
      metadata: { images: imgs, savedKb: rng.int(200, 4000) },
    });
  }
}

function auth(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const first = actor.name.split(' ')[0];
  const r = req(rng);
  const kind = rng.weighted([
    ['auth.login', 12],
    ['auth.login.failed', 2],
    ['auth.logout', 3],
    ['auth.mfa.enabled', 0.4],
    ['auth.permission.denied', 1],
  ] as const);
  const map = {
    'auth.login': { outcome: 'success', severity: 'info', d: `${first} signed in` },
    'auth.login.failed': { outcome: 'failure', severity: 'warning', d: `Failed sign-in for ${actor.email} (wrong one-time code)` },
    'auth.logout': { outcome: 'success', severity: 'info', d: `${first} signed out` },
    'auth.mfa.enabled': { outcome: 'success', severity: 'notice', d: `${first} turned on two-factor authentication` },
    'auth.permission.denied': { outcome: 'denied', severity: 'notice', d: `${first} was denied access to billing settings` },
  }[kind];
  emit({
    at: c.t,
    action: kind,
    outcome: map.outcome,
    severity: map.severity,
    description: map.d,
    actor,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'user', id: actor.id, name: actor.name }],
    context: { requestId: r.requestId, traceId: r.traceId, ip: r.ip, userAgent: r.userAgent },
    metadata: { method: 'email_otp', ...(kind === 'auth.permission.denied' ? { permission: 'billing.view' } : {}) },
  });
}

function members(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const first = actor.name.split(' ')[0];
  const other = rng.pick(biz.staff);
  const kind = rng.weighted([
    ['member.invited', 3],
    ['member.role.updated', 3],
    ['member.removed', 1],
    ['role.updated', 1],
  ] as const);
  const before = rng.pick(['editor', 'front_desk', 'viewer']);
  const after = rng.pick(['admin', 'manager', 'editor']);
  const desc = {
    'member.invited': `${first} invited ${rng.pick(FIRST).toLowerCase()}@${biz.domain} as ${after}`,
    'member.role.updated': `${first} changed ${other.name}'s role from ${before} to ${after}`,
    'member.removed': `${first} removed ${other.name} from ${biz.name}`,
    'role.updated': `${first} edited the permissions of the “${after}” role`,
  }[kind];
  emit({
    at: c.t,
    action: kind,
    severity: kind === 'member.removed' || kind === 'role.updated' ? 'notice' : 'info',
    description: desc,
    actor,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: kind === 'role.updated' ? [{ type: 'role', id: `role_${after}`, name: after }] : [{ type: 'user', id: other.id, name: other.name }],
    changes:
      kind === 'member.role.updated'
        ? [{ field: 'role', before, after }]
        : kind === 'role.updated'
          ? [{ field: 'permissions', before: ['bookings.view', 'hotels.edit'], after: ['bookings.view', 'hotels.edit', 'bookings.refund'] }]
          : [],
    context: { operationId: `op_${rng.alnum(10)}`, ...req(rng) },
  });
}

function impersonation(c: Ctx) {
  const { rng, emit, biz, admins } = c;
  const admin = rng.pick(admins);
  const target = rng.pick(biz.staff);
  const opId = `op_${rng.alnum(10)}`;
  const r = req(rng);
  const ticket = `SUP-${rng.int(1000, 9999)}`;
  emit({
    at: c.t,
    action: 'auth.impersonation.started',
    severity: 'notice',
    description: `${admin.name.split(' (')[0]} started impersonating ${target.name} (ticket ${ticket})`,
    actor: admin,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'user', id: target.id, name: target.name }],
    context: { operationId: opId, ...r },
    metadata: { ticket, reason: 'Customer asked support to fix room setup' },
  });
  const inner: Ctx = { ...c, t: c.t + rng.int(20_000, 90_000), ticket };
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    if (rng.chance(0.5)) hotelEdit(inner, target, admin);
    else bookingStaff(inner, target, admin);
    inner.t += rng.int(15_000, 120_000);
  }
  emit({
    at: inner.t,
    action: 'auth.impersonation.ended',
    severity: 'notice',
    description: `${admin.name.split(' (')[0]} stopped impersonating ${target.name}`,
    actor: admin,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'user', id: target.id, name: target.name }],
    context: { operationId: opId, ...r },
    metadata: { ticket, durationMs: inner.t - c.t },
  });
}

function scheduler(c: Ctx, all: Business[]) {
  const { rng, emit } = c;
  if (rng.chance(0.55)) {
    const biz = c.biz;
    const hotel = rng.pick(biz.hotels);
    const opId = `op_${rng.alnum(10)}`;
    const job = String(rng.int(10_000, 99_999));
    const n = Math.min(hotel.rooms.length, rng.int(2, 5));
    const parent = emit({
      at: c.t,
      action: 'rate.bulk_updated',
      description: `Nightly rates scheduler repriced ${n} room types at ${hotel.name}`,
      actor: SYSTEM,
      executor: { ...EXEC.rates, jobId: job, attempt: 1 },
      tenant: { id: biz.id, name: biz.name },
      targets: [{ type: 'hotel', id: hotel.id, name: hotel.name }],
      context: { operationId: opId },
      metadata: { rule: 'occupancy-based', occupancy: rng.int(40, 98) / 100 },
    });
    let t = c.t + rng.int(50, 300);
    for (const room of hotel.rooms.slice(0, n)) {
      const before = rng.int(45, 160) * 10;
      emit({
        at: t,
        action: 'rate.updated',
        description: `Nightly rates scheduler set ${room.name} at ${hotel.name} to SAR ${before + 50}`,
        actor: SYSTEM,
        executor: { ...EXEC.rates, jobId: job, attempt: 1 },
        tenant: { id: biz.id, name: biz.name },
        targets: [
          { type: 'rate_plan', id: `rp_${room.id}`, name: `${room.name} · Flexible` },
          { type: 'hotel', id: hotel.id, name: hotel.name },
        ],
        changes: [{ field: 'price', before, after: before + 50 }],
        context: { operationId: opId, parentEventId: parent },
      });
      t += rng.int(30, 250);
    }
    return;
  }
  const biz = rng.pick(all);
  const opId = `op_${rng.alnum(10)}`;
  const parent = emit({
    at: c.t,
    action: 'crm.sync.scheduled',
    description: `CRM sync scheduler queued the hourly sync for ${biz.name}`,
    actor: SYSTEM,
    executor: { ...EXEC.crmSched, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'crm_account', id: `crm_${biz.id}`, name: `${biz.name} (HubSpot)` }],
    context: { operationId: opId },
  });
  crmSync({ ...c, biz }, SYSTEM, opId, parent, c.t + rng.int(200, 2000), rng.int(1, 4), rng.chance(0.15));
}

function campaign(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const name = rng.pick(['Ramadan nights', 'Summer escape', 'Weekend in AlUla', 'Hajj packages', 'National Day 96']);
  const id = `cmp_${rng.int(100, 999)}`;
  const opId = `op_${rng.alnum(10)}`;
  const parent = emit({
    at: c.t,
    action: rng.pick(['campaign.created', 'campaign.launched'] as const),
    description: `${actor.name.split(' ')[0]} launched the “${name}” campaign for ${biz.name}`,
    actor,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'campaign', id, name }],
    changes: [{ field: 'dailyBudget', before: 0, after: rng.int(2, 20) * 100 }],
    context: { operationId: opId, ...req(rng) },
    metadata: { channel: rng.pick(['meta', 'google', 'snapchat']) },
  });
  const paused = rng.chance(0.15);
  emit({
    at: c.t + rng.int(2000, 20_000),
    action: paused ? 'campaign.paused' : 'campaign.synced',
    outcome: paused ? 'partial' : 'success',
    severity: paused ? 'warning' : 'info',
    description: paused ? `Ads worker paused “${name}”: ad account spending limit reached` : `Ads worker synced “${name}” to the ad platform`,
    actor,
    executor: { ...EXEC.ads, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'campaign', id, name }],
    context: { operationId: opId, parentEventId: parent },
  });
}

function integration(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const which = rng.pick(['StayBook', 'Meta WhatsApp', 'HubSpot', 'Google Analytics']);
  const kind = rng.weighted([
    ['integration.connected', 2],
    ['integration.token.rotated', 2],
    ['integration.disconnected', 1],
  ] as const);
  emit({
    at: c.t,
    action: kind,
    severity: kind === 'integration.disconnected' ? 'warning' : kind === 'integration.token.rotated' ? 'notice' : 'info',
    description: {
      'integration.connected': `${actor.name.split(' ')[0]} connected ${which}`,
      'integration.token.rotated': `${actor.name.split(' ')[0]} rotated the ${which} access token`,
      'integration.disconnected': `${actor.name.split(' ')[0]} disconnected ${which}`,
    }[kind],
    actor,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'integration', id: `int_${which.toLowerCase().replace(/\s+/g, '_')}_${biz.id}`, name: which }],
    changes: kind === 'integration.token.rotated' ? [{ field: 'accessToken', before: '[redacted]', after: '[redacted]' }] : [],
    context: { operationId: `op_${rng.alnum(10)}`, ...req(rng) },
  });
  if (which === 'Meta WhatsApp' && kind !== 'integration.disconnected' && rng.chance(0.5)) {
    emit({
      at: c.t + rng.int(1000, 8000),
      action: 'whatsapp.message.received',
      description: `Meta WhatsApp delivered a guest message to ${biz.name}`,
      actor: WHATSAPP,
      executor: EXEC.waHook,
      tenant: { id: biz.id, name: biz.name },
      source: 'meta_whatsapp',
      targets: [{ type: 'conversation', id: `conv_${rng.int(1000, 9999)}`, name: 'Guest conversation' }],
      context: { requestId: `req_${rng.alnum(10)}` },
    });
  }
}

function exportJob(c: Ctx, actor: Person) {
  const { rng, emit, biz } = c;
  const opId = `op_${rng.alnum(10)}`;
  const what = rng.pick(['guests', 'bookings', 'reviews']);
  const parent = emit({
    at: c.t,
    action: 'export.requested',
    severity: what === 'guests' ? 'notice' : 'info',
    description: `${actor.name.split(' ')[0]} requested a CSV export of ${what}`,
    actor,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'export', id: `exp_${rng.int(1000, 9999)}`, name: `${what}.csv` }],
    context: { operationId: opId, ...req(rng) },
    metadata: { format: 'csv', rows: rng.int(100, 20_000) },
  });
  const failed = rng.chance(0.08);
  emit({
    at: c.t + rng.int(3000, 60_000),
    action: failed ? 'export.failed' : 'export.completed',
    outcome: failed ? 'failure' : 'success',
    severity: failed ? 'warning' : 'info',
    description: failed ? `The ${what} export timed out after 60 s` : `The ${what} export is ready to download`,
    actor,
    executor: { ...EXEC.bookings, jobId: String(rng.int(10_000, 99_999)), attempt: 1 },
    tenant: { id: biz.id, name: biz.name },
    targets: [{ type: 'export', id: `exp_${rng.int(1000, 9999)}`, name: `${what}.csv` }],
    context: { operationId: opId, parentEventId: parent },
  });
}

function apiKeySync(c: Ctx) {
  const { rng, emit, biz } = c;
  const hotel = rng.pick(biz.hotels);
  emit({
    at: c.t,
    action: 'availability.updated',
    description: `StayBook sync key pushed availability for ${hotel.name}`,
    actor: SYNC_KEY,
    executor: EXEC.api,
    tenant: { id: biz.id, name: biz.name },
    source: 'staybook',
    targets: [{ type: 'hotel', id: hotel.id, name: hotel.name }],
    changes: [{ field: 'availableRooms', before: rng.int(0, 10), after: rng.int(0, 10) }],
    context: { requestId: `req_${rng.alnum(10)}` },
    metadata: { http: { method: 'PUT', route: '/v2/availability', status: 200 } },
  });
}

function offStandard(c: Ctx) {
  const { rng, emit, biz } = c;
  const kind = rng.pick(['legacy', 'noactor', 'custom'] as const);
  if (kind === 'legacy') {
    emit({
      at: c.t,
      action: 'legacy.cron.tick',
      outcome: undefined,
      host: `cms-${rng.int(1, 3)}`,
      durationMs: rng.int(20, 900),
      job: 'cleanup-temp-uploads',
    } as never);
  } else if (kind === 'noactor') {
    emit({
      at: c.t,
      action: 'cache.purged',
      description: `CDN cache purged for ${biz.domain}`,
      tenant: { id: biz.id, name: biz.name },
      zone: 'cloudflare',
      paths: ['/*'],
    } as never);
  } else {
    emit({
      at: c.t,
      action: 'review.imported',
      description: `Imported a guest review for ${rng.pick(biz.hotels).name}`,
      tenant: { id: biz.id, name: biz.name },
      rating: rng.int(2, 5),
      reviewSource: rng.pick(['google', 'tripadvisor']),
      x_region: rng.pick(['me-central-1', 'eu-west-1']),
    } as never);
  }
}

/** Hour-of-week activity weight (KSA: Fri/Sat weekend, evening peak). */
function seasonality(ms: number): number {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = (d.getUTCHours() + 3) % 24; // Riyadh time
  const dayW = day === 5 ? 0.55 : day === 6 ? 0.7 : 1;
  const hourW = hour < 6 ? 0.18 : hour < 9 ? 0.6 : hour < 13 ? 1.25 : hour < 17 ? 1 : hour < 23 ? 1.15 : 0.5;
  return dayW * hourW;
}

export interface Generator {
  /** Generate every scenario between the cursor and `untilMs`. */
  advance(untilMs: number): StoredEvent[];
}

export function createJoodGenerator(projectId: string, startMs: number, meanGapMs: number, seed: number): Generator {
  const world = buildWorld(7);
  const rng = new Rng(seed);
  let cursor = startMs;

  return {
    advance(untilMs) {
      const out: StoredEvent[] = [];
      const emit: Emit = ({ at, ...draft }) => {
        const id = ulid(at, rng);
        const env = rng.chance(0.04) ? 'staging' : 'production';
        const full: EventDraft = { id, occurredAt: new Date(at).toISOString(), environment: env, schemaVersion: '1', ...draft, action: draft.action };
        // Real producers often omit defaults: ~35% of successes arrive without an explicit outcome,
        // and some high-volume worker events skip the description (lower conformance, still accepted).
        if (!('outcome' in draft) && rng.chance(0.65)) full.outcome = 'success';
        if (full.outcome === undefined) delete full.outcome;
        if ((draft.action === 'crm.sync.contact.upserted' || draft.action === 'page.rendered') && rng.chance(0.4)) delete full.description;
        if (draft.action === 'availability.updated' && rng.chance(0.5)) delete full.targets;
        const sdk =
          draft.action.startsWith('legacy.') || draft.action === 'cache.purged' || draft.action === 'review.imported'
            ? 'http'
            : '@trailmark/sdk@0.1.0';
        out.push(normalize(full, projectId, rng.int(40, 900), sdk));
        return id;
      };
      while (cursor < untilMs) {
        const gap = rng.exp(meanGapMs / Math.max(0.15, seasonality(cursor)));
        cursor += gap;
        if (cursor >= untilMs) break;
        const biz = rng.pick(world.businesses);
        const staff = rng.pick(biz.staff);
        const c: Ctx = { rng, emit, biz, t: cursor, admins: world.admins };
        const scenario = rng.weighted([
          ['hotel', 18],
          ['bookingHook', 20],
          ['bookingStaff', 9],
          ['content', 11],
          ['auth', 14],
          ['members', 3],
          ['impersonation', 1.3],
          ['scheduler', 6],
          ['campaign', 3.5],
          ['integration', 2],
          ['export', 2],
          ['apiKey', 3],
          ['offStandard', 2],
        ] as const);
        switch (scenario) {
          case 'hotel':
            hotelEdit(c, staff);
            break;
          case 'bookingHook':
            bookingWebhook(c);
            break;
          case 'bookingStaff':
            bookingStaff(c, staff);
            break;
          case 'content':
            content(c, staff);
            break;
          case 'auth':
            auth(c, staff);
            break;
          case 'members':
            members(c, staff);
            break;
          case 'impersonation':
            impersonation(c);
            break;
          case 'scheduler':
            scheduler(c, world.businesses);
            break;
          case 'campaign':
            campaign(c, staff);
            break;
          case 'integration':
            integration(c, staff);
            break;
          case 'export':
            exportJob(c, staff);
            break;
          case 'apiKey':
            apiKeySync(c);
            break;
          default:
            offStandard(c);
        }
      }
      return out;
    },
  };
}

/** A small accounting app with a different vocabulary — proves "accept anything". */
export function createLedgerGenerator(projectId: string, startMs: number, meanGapMs: number, seed: number): Generator {
  const rng = new Rng(seed);
  let cursor = startMs;
  const companies = ['Northwind Trading', 'Fennec Labs', 'Atlas Freight', 'Mira Studio', 'Kestrel Foods', 'Orchid Dental'].map((name, i) => ({
    id: `co_${i + 1}`,
    name,
  }));
  const people = ['Ada Moreau', 'Ben Ito', 'Chloe Park', 'Dev Shah', 'Eva Lind', 'Femi Okoro'].map((name, i) => ({
    type: 'user',
    id: `u_${i + 1}`,
    name,
    email: `${name.split(' ')[0]?.toLowerCase()}@ledger.example`,
  }));
  return {
    advance(untilMs) {
      const out: StoredEvent[] = [];
      while (cursor < untilMs) {
        cursor += rng.exp(meanGapMs / Math.max(0.2, seasonality(cursor)));
        if (cursor >= untilMs) break;
        const co = rng.pick(companies);
        const who = rng.pick(people);
        const inv = `INV-${rng.int(1000, 9999)}`;
        const amount = rng.int(50, 9000);
        const kind = rng.weighted([
          ['invoice.created', 4],
          ['invoice.sent', 3],
          ['invoice.paid', 3],
          ['payment.refunded', 0.5],
          ['ledger.entry.posted', 4],
          ['account.reconciled', 1],
          ['user.signed_in', 3],
        ] as const);
        const draft: EventDraft = {
          id: ulid(cursor, rng),
          action: kind,
          occurredAt: new Date(cursor).toISOString(),
          outcome: kind === 'payment.refunded' && rng.chance(0.3) ? 'failure' : 'success',
          description: {
            'invoice.created': `${who.name} created ${inv} for €${amount}`,
            'invoice.sent': `${who.name} emailed ${inv} to ${co.name}`,
            'invoice.paid': `${co.name} paid ${inv} (€${amount})`,
            'payment.refunded': `${who.name} refunded €${amount} on ${inv}`,
            'ledger.entry.posted': `${who.name} posted a journal entry of €${amount}`,
            'account.reconciled': `${who.name} reconciled the operating account`,
            'user.signed_in': `${who.name} signed in`,
          }[kind],
          actor: who,
          tenant: { id: co.id, name: co.name },
          targets: kind === 'user.signed_in' ? [] : [{ type: kind.startsWith('ledger') ? 'journal_entry' : 'invoice', id: inv, name: inv }],
          metadata: { currency: 'EUR', amount, workspace: { tier: rng.pick(['free', 'team']) } },
          ledgerRegion: rng.pick(['eu', 'uk']),
        };
        out.push(normalize(draft, projectId, rng.int(40, 600)));
      }
      return out;
    },
  };
}
