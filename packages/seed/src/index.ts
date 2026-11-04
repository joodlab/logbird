import type { EventInput } from '@trailmark/sdk';
export interface SeedOptions {
  events: number;
  days: number;
  project: string;
  seed?: number;
  now?: Date;
}
export function* generateEvents(options: SeedOptions): Generator<EventInput> {
  let state = options.seed ?? 42;
  const random = () => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const now = options.now ?? new Date(),
    start = now.getTime() - options.days * 86_400_000;
  const ledger = options.project.toLowerCase().includes('ledger');
  const models = ledger
    ? ['invoice', 'journal', 'account', 'payment', 'reconciliation']
    : [
        'hotel',
        'room',
        'rate',
        'booking',
        'guest',
        'campaign',
        'article',
        'page',
        'website',
        'member',
        'role',
        'integration',
        'media',
        'export',
        'auth',
        'crm.sync',
        'catalog.sync',
      ];
  let emitted = 0,
    operation = 0;
  while (emitted < options.events) {
    let timestamp: number;
    let accepted = false;
    do {
      timestamp = start + random() * (now.getTime() - start - 10_000);
      const d = new Date(timestamp);
      const weight = (d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.45 : 1) * (d.getUTCHours() < 7 || d.getUTCHours() > 20 ? 0.2 : 1);
      accepted = random() < weight;
    } while (!accepted);
    const op = `${options.project}-s${options.seed ?? 42}-op${operation++}`,
      biz = 1 + Math.floor(random() * 30),
      usr = 1 + Math.floor(random() * 150),
      model = models[Math.floor(random() * models.length)] ?? 'hotel';
    const scheduled = random() < 0.18,
      webhook = random() < 0.08,
      apiKey = random() < 0.08,
      off = random() < 0.025;
    const actor = scheduled
      ? { type: 'system', id: 'crm-scheduler', name: 'CRM scheduler' }
      : webhook
        ? { type: 'integration', id: 'staybook', name: 'StayBook' }
        : apiKey
          ? { type: 'api_key', id: `key_${biz}`, name: 'Partner automation' }
          : { type: 'user', id: `usr_${usr}`, name: `Demo operator ${usr}`, email: `operator${usr}@example.test` };
    const queue =
      model.includes('crm') || ['guest', 'booking'].includes(model)
        ? 'business-crm'
        : ['article', 'hotel', 'room', 'page', 'rate'].includes(model)
          ? 'content'
          : model === 'campaign'
            ? 'email'
            : model === 'media'
              ? 'website'
              : 'notifications';
    const jobName =
      queue === 'business-crm'
        ? 'crm:sync:bookings'
        : queue === 'content'
          ? 'content:translate:hotel'
          : queue === 'email'
            ? 'crm:campaign:send'
            : 'website:screenshot';
    const failure = random() < 0.012,
      denied = !scheduled && random() < 0.004,
      retry = failure && random() < 0.7;
    const actorFields = off ? {} : { actor };
    const base: Omit<EventInput, 'action'> = {
      ...actorFields,
      tenant: { id: `biz_${biz}`, name: `Fictional hospitality ${biz}` },
      environment: random() < 0.04 ? 'staging' : 'production',
      source: webhook ? ['staybook', 'meta-whatsapp', 'payment-sandbox'][Math.floor(random() * 3)] : 'staydesk',
      schemaVersion: '1',
      ...(random() < 0.012 && !scheduled ? { impersonator: { id: 'admin_support', name: 'Demo platform support' } } : {}),
      metadata: { role: usr % 5 === 0 ? 'owner' : usr % 3 === 0 ? 'manager' : 'editor', queue, jobName, locale: random() < 0.3 ? 'ar' : 'en' },
      ...(off ? { legacy_label: 'unstructured provider event' } : {}),
    };
    const root = `${op}-0`,
      job = `${op}-1`;
    const treeSize = denied ? 1 : Math.min(options.events - emitted, 3 + Math.floor(random() * 5) + (retry ? 2 : 0));
    for (let i = 0; i < treeSize && emitted < options.events; i++, emitted++) {
      const rootEvent = i === 0,
        jobEvent = i === 1 || (retry && (i === 2 || i === 3)),
        attempt = retry && i >= 2 ? (i === 2 ? 2 : 3) : 1;
      yield {
        ...base,
        id: `${op}-${i}`,
        action: rootEvent
          ? `${model}.requested`
          : jobEvent
            ? `${queue}.job.${retry && i < 3 ? 'failed' : 'completed'}`
            : `${model}.${ledger ? 'posted' : 'updated'}`,
        occurredAt: new Date(timestamp + i * 250).toISOString(),
        outcome: denied
          ? 'denied'
          : retry && jobEvent && i < 3
            ? 'failure'
            : failure && !retry
              ? 'failure'
              : random() < 0.002
                ? 'unknown'
                : 'success',
        severity: failure ? 'warning' : 'info',
        description: `Demo ${rootEvent ? 'requested' : jobEvent ? 'processed' : 'updated'} ${model} for fictional business ${biz}`,
        executor: {
          type: rootEvent ? (scheduled ? 'scheduler' : webhook ? 'webhook' : 'api') : 'worker',
          id: rootEvent ? (scheduled ? 'crm-scheduler' : webhook ? 'provider-webhook' : 'api-server') : `${queue}-worker`,
          name: rootEvent ? 'Request handler' : `${queue} worker`,
          ...(rootEvent ? {} : { jobId: `job_${op}`, attempt }),
        },
        targets: [
          { type: model, id: `${model}_${Math.floor(random() * 5000)}`, name: `Demo ${model}` },
          { type: 'website', id: `web_${biz}_${biz % 3}`, name: `site${biz}.example.test` },
        ],
        changes: rootEvent || jobEvent ? [] : [{ field: ledger ? 'status' : 'preparationStatus', before: 'pending', after: 'ready' }],
        context: { operationId: op, requestId: `req_${op}`, parentEventId: rootEvent ? '' : jobEvent ? root : retry ? `${op}-3` : job },
      };
    }
  }
}
