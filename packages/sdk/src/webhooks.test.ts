import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { generateWebhookSecret, signWebhook, verifyWebhook, WebhookVerificationError, type WebhookVerificationReason } from './index';

// Official fixed signing vector ("sign function works"):
// https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/javascript/src/webhook.test.ts
const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'; // gitleaks:allow -- Official public test vector, not a credential.
const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const timestamp = 1_614_265_330;
const payload = '{"test": 2432232314}';
const signature = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
const newSecret = `whsec_${Buffer.alloc(32, 42).toString('base64')}`;
const wrongSecret = `whsec_${Buffer.alloc(32, 43).toString('base64')}`;

function headers(value = signature, time = String(timestamp)) {
  return { 'webhook-id': id, 'webhook-timestamp': time, 'webhook-signature': value };
}

function independentSignature(key: string, body = payload, time = timestamp) {
  return `v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64'))
    .update(`${id}.${time}.${body}`)
    .digest('base64')}`;
}

async function rejectsWithReason(result: Promise<unknown>, reason: WebhookVerificationReason) {
  await expect(result).rejects.toBeInstanceOf(WebhookVerificationError);
  await expect(result).rejects.toMatchObject({ name: 'WebhookVerificationError', reason });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Standard Webhooks', () => {
  it('signs and verifies the official fixed vector through the SDK entry', async () => {
    expect(await signWebhook({ id, timestamp, payload, secrets: [secret] })).toBe(signature);
    expect(await verifyWebhook({ payload, headers: headers(), secret, now: timestamp })).toEqual({ test: 2_432_232_314 });
    // The body is returned as `unknown` unless the caller names the type it expects.
    expectTypeOf<Awaited<ReturnType<typeof verifyWebhook>>>().toEqualTypeOf<unknown>();
    expectTypeOf(verifyWebhook<{ test: number }>({ payload, headers: headers(), secret, now: timestamp })).resolves.toEqualTypeOf<{ test: number }>();
  });

  it('signs exact UTF-8 body bytes and rotation headers like independent Node crypto', async () => {
    const body = '{ "action": "hotel.updated", "description": "مرحبا ✓" }\n';
    const signed = await signWebhook({ id, timestamp, payload: body, secrets: [secret, newSecret] });
    expect(signed).toBe([independentSignature(secret, body), independentSignature(newSecret, body)].join(' '));
    expect(await verifyWebhook({ payload: body, headers: headers(signed), secret: newSecret, now: timestamp })).toEqual(JSON.parse(body));
  });

  it.each([secret, newSecret])('accepts either receiver secret during sender rotation: %s', async (receiverSecret) => {
    const signed = await signWebhook({ id, timestamp, payload, secrets: [secret, newSecret] });
    expect(await verifyWebhook({ payload, headers: headers(signed), secret: receiverSecret, now: timestamp })).toEqual(JSON.parse(payload));
  });

  it.each([secret, newSecret])('accepts either sender with multiple receiver secrets: %s', async (senderSecret) => {
    expect(
      await verifyWebhook({ payload, headers: headers(independentSignature(senderSecret)), secrets: [secret, newSecret], now: timestamp }),
    ).toEqual(JSON.parse(payload));
  });

  it('rejects a changed body, id, or timestamp and a wrong secret', async () => {
    for (const options of [
      { payload: `${payload}\n`, headers: headers(), secret },
      { payload, headers: { ...headers(), 'webhook-id': 'msg_changed' }, secret },
      { payload, headers: headers(signature, String(timestamp + 1)), secret },
      { payload, headers: headers(), secret: wrongSecret },
    ]) {
      await rejectsWithReason(verifyWebhook({ ...options, now: timestamp }), 'no_matching_signature');
    }
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const)('rejects missing or empty %s', async (name) => {
    for (const value of [undefined, '']) {
      await rejectsWithReason(verifyWebhook({ payload, headers: { ...headers(), [name]: value }, secret, now: timestamp }), 'missing_header');
    }
  });

  it('accepts case-insensitive records and Headers', async () => {
    const mixed = { 'Webhook-ID': id, 'WEBHOOK-TIMESTAMP': String(timestamp), 'Webhook-Signature': signature };
    for (const input of [mixed, new Headers(mixed)]) {
      expect(await verifyWebhook({ payload, headers: input, secret, now: timestamp })).toEqual(JSON.parse(payload));
    }
  });

  it.each(['hello', '1.5', '-1', '1e9', '1614265330junk', ' 1614265330', 'Infinity', '9007199254740992'])(
    'rejects invalid timestamp %s',
    async (time) => {
      await rejectsWithReason(verifyWebhook({ payload, headers: headers(signature, time), secret, now: timestamp }), 'invalid_timestamp');
    },
  );

  it.each([-300, 300])('accepts the inclusive tolerance edge: %s seconds', async (offset) => {
    expect(await verifyWebhook({ payload, headers: headers(), secret, now: timestamp + offset })).toEqual(JSON.parse(payload));
  });

  it.each([-301, 301, -300.001, 300.001])('rejects outside the tolerance: %s seconds', async (offset) => {
    await rejectsWithReason(verifyWebhook({ payload, headers: headers(), secret, now: timestamp + offset }), 'timestamp_out_of_tolerance');
  });

  it('uses the wall clock by default and honors custom and zero tolerance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(timestamp * 1000);
    expect(await verifyWebhook({ payload, headers: headers(), secret })).toEqual(JSON.parse(payload));
    expect(await verifyWebhook({ payload, headers: headers(), secret, toleranceSeconds: 0 })).toEqual(JSON.parse(payload));
    vi.setSystemTime((timestamp + 301) * 1000);
    await rejectsWithReason(verifyWebhook({ payload, headers: headers(), secret }), 'timestamp_out_of_tolerance');
    expect(await verifyWebhook({ payload, headers: headers(), secret, toleranceSeconds: 301 })).toEqual(JSON.parse(payload));
  });

  // A bad clock or tolerance is the receiver's configuration error, not a bad request: a RangeError, not a 400.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('refuses an unsafe tolerance %s as a configuration error', async (toleranceSeconds) => {
    await expect(verifyWebhook({ payload, headers: headers(), secret, now: timestamp, toleranceSeconds })).rejects.toBeInstanceOf(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('refuses an invalid clock %s as a configuration error', async (now) => {
    await expect(verifyWebhook({ payload, headers: headers(), secret, now })).rejects.toBeInstanceOf(RangeError);
  });

  it.each(['', 'whsec_', 'bare-base64', 'whsec_!!!!', 'whsec_YQ==', `whsec_${'A'.repeat(88)}`, `${secret}=`, `${secret} `])(
    'refuses a malformed or out-of-spec secret %s as a configuration error when signing and verifying',
    async (invalidSecret) => {
      await expect(signWebhook({ id, timestamp, payload, secrets: [invalidSecret] })).rejects.toBeInstanceOf(TypeError);
      // Even for a request with no webhook headers at all: a broken secret shows up on the first delivery.
      await expect(verifyWebhook({ payload, headers: {}, secret: invalidSecret, now: timestamp })).rejects.toBeInstanceOf(TypeError);
    },
  );

  it('refuses an empty secret list, an invalid rotation member or a missing secret as configuration errors', async () => {
    for (const secrets of [[], [secret, 'whsec_']]) {
      await expect(signWebhook({ id, timestamp, payload, secrets })).rejects.toBeInstanceOf(TypeError);
      await expect(verifyWebhook({ payload, headers: headers(), secrets, now: timestamp })).rejects.toBeInstanceOf(TypeError);
    }
    // Plain JavaScript callers that pass neither secret nor secrets get the same typed error, not a crash.
    await expect(verifyWebhook({ payload, headers: headers(), now: timestamp } as never)).rejects.toThrow(/webhook secret must be a string/);
  });

  it.each(['v2,AAA=', 'v1', 'v1,', 'v1,not-base64!', 'v1,AA==', `${signature},extra`, signature.slice(0, -4)])(
    'rejects unknown, malformed, or truncated signatures: %s',
    async (value) => {
      await rejectsWithReason(verifyWebhook({ payload, headers: headers(value), secret, now: timestamp }), 'no_matching_signature');
    },
  );

  it('skips malformed and unknown signatures alongside a valid v1', async () => {
    const value = `v1 v1,not-base64! v2,${signature.slice(3)} ${independentSignature(wrongSecret)} ${signature}`;
    expect(await verifyWebhook({ payload, headers: headers(value), secret, now: timestamp })).toEqual(JSON.parse(payload));
  });

  it.each(['not JSON', ''])('rejects an authenticated non-JSON body: %s', async (body) => {
    const signed = independentSignature(secret, body);
    await rejectsWithReason(verifyWebhook({ payload: body, headers: headers(signed), secret, now: timestamp }), 'invalid_payload');
    await rejectsWithReason(verifyWebhook({ payload: body, headers: headers(), secret, now: timestamp }), 'no_matching_signature');
  });

  it('generates distinct 32-byte secrets that round trip', async () => {
    const generated = generateWebhookSecret();
    expect(generated).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(generated.slice(6), 'base64')).toHaveLength(32);
    expect(generateWebhookSecret()).not.toBe(generated);
    const signed = await signWebhook({ id, timestamp, payload, secrets: [generated] });
    expect(signed).toBe(independentSignature(generated));
    expect(await verifyWebhook({ payload, headers: headers(signed), secret: generated, now: timestamp })).toEqual(JSON.parse(payload));
  });

  it.each(['', 'id.with.dot', 'id\r\nheader'])('refuses unsafe signer ids: %s', async (invalidId) => {
    await expect(signWebhook({ id: invalidId, timestamp, payload, secrets: [secret] })).rejects.toBeInstanceOf(TypeError);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('refuses invalid signer timestamps: %s', async (time) => {
    await expect(signWebhook({ id, timestamp: time, payload, secrets: [secret] })).rejects.toBeInstanceOf(RangeError);
  });

  it('checks a bounded number of claimed signatures, with one HMAC of the body per secret', async () => {
    const sign = vi.spyOn(crypto.subtle, 'sign');
    const junk = Array.from({ length: 300 }, (_, index) => `v1,${Buffer.alloc(32, index % 256).toString('base64')}`).join(' ');
    await rejectsWithReason(
      verifyWebhook({ payload, headers: headers(junk), secrets: [secret, newSecret], now: timestamp }),
      'no_matching_signature',
    );
    expect(sign).toHaveBeenCalledTimes(2);
    // A valid signature past the cap isn't looked at: the cap bounds the work for any header.
    const late = `${Array.from({ length: 10 }, () => independentSignature(wrongSecret)).join(' ')} ${signature}`;
    await rejectsWithReason(verifyWebhook({ payload, headers: headers(late), secret, now: timestamp }), 'no_matching_signature');
    sign.mockRestore();
  });

  it("accepts Node's req.headers (array values ignored) and Headers-like objects from another realm", async () => {
    const nodeHeaders: Record<string, string | string[] | undefined> = { ...headers(), 'set-cookie': ['a=1', 'b=2'] };
    expect(await verifyWebhook({ payload, headers: nodeHeaders, secret, now: timestamp })).toEqual(JSON.parse(payload));
    // A webhook header sent twice is ambiguous and counts as missing.
    await rejectsWithReason(verifyWebhook({ payload, headers: { ...headers(), 'webhook-id': [id, id] }, secret, now: timestamp }), 'missing_header');
    const values = new Map<string, string>(Object.entries(headers()));
    const polyfill = { get: (name: string) => values.get(name.toLowerCase()) ?? null };
    expect(await verifyWebhook({ payload, headers: polyfill, secret, now: timestamp })).toEqual(JSON.parse(payload));
  });

  it('uses whole seconds for the default clock, so zero tolerance works within the second', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(timestamp * 1000 + 999);
    expect(await verifyWebhook({ payload, headers: headers(), secret, toleranceSeconds: 0 })).toEqual(JSON.parse(payload));
  });
});
