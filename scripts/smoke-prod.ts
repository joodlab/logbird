import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? process.argv[2];
assert.ok(base, 'Set BASE_URL or pass it as the first argument');
const origin = new URL(base).origin;
async function request(path: string, options: RequestInit = {}, status = 200) {
  const response = await fetch(new URL(path, base), { ...options, signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, status, `Unexpected status for ${path.split('?')[0]}`);
  return response;
}
await request('/');
for (const path of ['/health', '/livez', '/readyz']) await request(path);
await request('/v1/events', {}, 401);
const ingest = process.env.LOGBIRD_INGEST_KEY;
const read = process.env.LOGBIRD_READ_KEY;
if (ingest && read) {
  const id = randomUUID();
  await request(
    '/v1/events',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${ingest}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'smoke.production', source: 'logbird-smoke' }),
    },
    202,
  );
  const result = await request(`/v1/events/${id}`, { headers: { Authorization: `Bearer ${read}` } });
  assert.ok(JSON.stringify(await result.json()).includes(id), 'Ingested event read back');
  console.log('PASS ingest + read (fictional smoke event retained)');
} else console.log('SKIP ingest/read: provide private ingest and read keys for the same test project');
const cookie = process.env.SMOKE_COOKIE;
const project = process.env.SMOKE_PROJECT_ID;
if (cookie && project) {
  const headers = { cookie };
  await request(`/api/projects/${project}/events?q=action%3Asmoke.production`, { headers });
  await request(`/api/projects/${project}/events?lang=sql&q=action%3D%27smoke.production%27`, { headers });
  await request(`/api/projects/${project}/events?lang=sql&q=SELECT%20*%20FROM%20system.users`, { headers }, 422);
  console.log('PASS console Query + guarded SQL');
} else console.log('SKIP console Query/SQL: provide SMOKE_COOKIE + SMOKE_PROJECT_ID');
if (process.env.SMOKE_EMAIL) {
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  await request('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL, type: 'sign-in' }),
  });
  if (process.env.SMOKE_OTP)
    await request('/api/auth/sign-in/email-otp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: process.env.SMOKE_EMAIL, otp: process.env.SMOKE_OTP }),
    });
  else console.log('SKIP OTP verification: inspect delivery and rerun with SMOKE_OTP');
} else console.log('SKIP OTP: provide SMOKE_EMAIL');
console.log('PASS public listener and unauthorized API check');
