// Disposable Compose acceptance fixture. Never run against a customer instance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const base = process.env.BASE_URL || 'http://localhost:4700';
const project = process.env.COMPOSE_PROJECT_NAME || 'logbird-selfhost-test';
assert.ok(project.startsWith('logbird-selfhost-'), 'Only disposable selfhost test projects');
const envFile = process.env.SELFHOST_ENV || '.env.selfhost-test';
const stateFile = process.env.SELFHOST_STATE || '.tmp/selfhost-state.json';
let cookie = '';
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Origin: base, 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response;
}
for (const path of ['/livez', '/readyz']) assert.equal((await api(path)).status, 200);
if (process.argv.includes('--verify')) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  cookie = state.cookie;
  const session = await (await api('/api/auth/get-session')).json();
  assert.equal(session.user.email, state.email);
  const events = await (await api(`/api/projects/${state.projectId}/events?q=action:selfhost.acceptance`)).json();
  assert.ok(events.data.some((event) => event.id === state.eventId));
  const settings = await (await api(`/api/projects/${state.projectId}`)).json();
  assert.equal(settings.retentionDays, 180);
  assert.equal(settings.description, 'QA persisted self-host settings');
  const read = await fetch(`${base}/v1/events/${state.eventId}`, {
    headers: { Authorization: `Bearer ${state.readKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(read.status, 200, 'Persisted read key authenticates');
  assert.ok(JSON.stringify(await read.json()).includes(state.eventId));
  console.log('PASS persisted user/session, project settings, event and read key; livez/readyz 200');
} else {
  const email = `selfhost-${randomUUID()}@example.test`;
  await api('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' });
  let otp;
  if (process.argv.includes('--smtp')) {
    for (let attempt = 0; attempt < 30 && !otp; attempt++) {
      const mailbox = await (await fetch('http://127.0.0.1:8025/api/v1/messages')).json();
      const message = mailbox.messages.find((item) => item.To.some((to) => to.Address === email));
      if (message) {
        const content = await (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)).json();
        otp = content.Text.match(/\b\d{6}\b/)?.[0];
      }
      if (!otp) await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } else {
    const logs = execFileSync('docker', ['compose', '--env-file', envFile, '-p', project, 'logs', '--no-log-prefix', 'server'], { encoding: 'utf8' });
    for (const line of logs.split('\n')) {
      if (!line.includes('"event":"auth.sign_in_code"')) continue;
      const entry = JSON.parse(line);
      if (entry.email === email) otp = entry.code;
    }
  }
  assert.ok(otp, 'OTP received (never printed)');
  const login = await api('/api/auth/sign-in/email-otp', { email, otp });
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const org = await (await api('/api/auth/organization/create', { name: 'QA Selfhost fixture', slug: `selfhost-${randomUUID()}` })).json();
  await api('/api/auth/organization/set-active', { organizationId: org.id });
  const created = await (await api('/api/projects', { name: 'QA Fictional selfhost acceptance' })).json();
  await api(`/api/projects/${created.project.id}`, { retentionDays: 180, description: 'QA persisted self-host settings' }, 'PATCH');
  const key = await (await api(`/api/projects/${created.project.id}/keys`, { name: 'Fixture ingest', kind: 'ingest' })).json();
  const read = await (await api(`/api/projects/${created.project.id}/keys`, { name: 'Fixture read', kind: 'read' })).json();
  const eventId = randomUUID();
  // Keep bearer credentials out of argv (also keeps them out of spawn errors).
  const output = execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-fsS', '--write-out', '%{http_code}', '--config', '-'], {
    encoding: 'utf8',
    input: `url = "${base}/v1/events"\nheader = "Authorization: Bearer ${key.secret}"\nheader = "Content-Type: application/json"\ndata = ${JSON.stringify(JSON.stringify({ id: eventId, action: 'selfhost.acceptance' }))}\n`,
  });
  assert.equal(output.slice(-3), '202', 'curl ingest acknowledged');
  assert.ok(JSON.parse(output.slice(0, -3)), 'curl ingest returned JSON');
  const events = await (await api(`/api/projects/${created.project.id}/events?q=action:selfhost.acceptance`)).json();
  assert.ok(events.data.some((event) => event.id === eventId));
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ cookie, email, projectId: created.project.id, eventId, ingestKey: key.secret, readKey: read.secret }), {
    mode: 0o600,
  });
  console.log(
    `PASS ${process.argv.includes('--smtp') ? 'SMTP' : 'log'} OTP, login, workspace, project, ingest key, curl ingest, Explorer readback; livez/readyz 200`,
  );
}
