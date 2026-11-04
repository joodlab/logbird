import assert from 'node:assert/strict';
export const endpoint = process.env.SERVER_URL ?? 'http://127.0.0.1:4601';
export async function login(email: string) {
  await fetch(`${endpoint}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
    body: JSON.stringify({ email, type: 'sign-in' }),
  }).then(async (r) => {
    assert.equal(r.status, 200, await r.text());
  });
  let otp: string | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const mailbox = (await fetch('http://127.0.0.1:8025/api/v1/messages').then((r) => r.json())) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const message = mailbox.messages.find((m) => m.To.some((t) => t.Address === email));
    if (message) {
      const content = (await fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`).then((r) => r.json())) as { Text: string };
      otp = content.Text.match(/\b\d{6}\b/)?.[0];
      if (otp) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(otp, 'OTP arrived in Mailpit');
  const result = await fetch(`${endpoint}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
    body: JSON.stringify({ email, otp }),
  });
  assert.equal(result.status, 200, await result.clone().text());
  return result.headers
    .getSetCookie()
    .map((v) => v.split(';')[0])
    .join('; ');
}
export function client(cookie: string) {
  return async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: { cookie, 'Content-Type': 'application/json', Origin: process.env.APP_URL ?? 'http://localhost:4600' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
  };
}
