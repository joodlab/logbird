import { expect, it, vi } from 'vitest';
import { isAllowedWebhookAddress, validateWebhookUrl, WebhookUrlError } from './webhook-address';

const blockedV4 = [
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.0',
  '100.127.255.255',
  '127.0.0.1',
  '127.255.255.255',
  '169.254.0.1',
  '169.254.169.254',
  '172.16.0.0',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.0.1',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.1',
  '203.0.113.1',
  '224.0.0.1',
  '239.255.255.255',
  '240.0.0.1',
  '255.255.255.255',
];
it.each(blockedV4)('rejects special-use IPv4 %s and its mapped/NAT64 forms', (address) => {
  expect(isAllowedWebhookAddress(address)).toBe(false);
  expect(isAllowedWebhookAddress(`::ffff:${address}`)).toBe(false);
  expect(isAllowedWebhookAddress(`64:ff9b::${address}`)).toBe(false);
});
it.each([
  '::',
  '::1',
  '100::1',
  '100:0:0:1::1',
  '::127.0.0.1',
  '::ffff:0:127.0.0.1',
  'fc00::1',
  'fdff::1',
  'fd00:ec2::254',
  'fe80::1',
  'febf::1',
  'ff02::1',
  '2001:db8::1',
  '2001:2::1',
  '2001::1',
  '2002:7f00:1::',
  '3fff::1',
  '64:ff9b:1::a00:1',
  '2130706433',
  '0x7f000001',
  '0177.0.0.1',
  '127.1',
  '0x0a.0.0.1',
  '2852039166',
  '0xa9fea9fe',
  'localhost',
  'garbage',
  '8.8.8.8/extra',
  '8.8.8.8@1.1.1.1',
  '::ffff:127.0.0.1%eth0',
])('rejects IPv6, encoded and invalid addresses: %s', (address) => {
  expect(isAllowedWebhookAddress(address)).toBe(false);
});
it.each([
  '8.8.8.8',
  '1.1.1.1',
  '100.63.255.255',
  '100.128.0.0',
  '172.15.255.255',
  '172.32.0.0',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '::ffff:8.8.8.8',
  '64:ff9b::8.8.8.8',
])('allows public unicast %s', (address) => {
  expect(isAllowedWebhookAddress(address)).toBe(true);
});
const publicLookup = vi.fn(async () => [
  { address: '8.8.8.8', family: 4 },
  { address: '2606:4700::1111', family: 6 },
]);
it('resolves all DNS answers, preserves the query, and normalizes URLs', async () => {
  expect(await validateWebhookUrl('https://Receiver.example.test/events?token=qa', false, publicLookup)).toBe(
    'https://receiver.example.test/events?token=qa',
  );
  expect(publicLookup).toHaveBeenCalledWith('receiver.example.test', { all: true });
});
it.each([
  'http://receiver.example.test',
  'ftp://receiver.example.test',
  'https://user:password@receiver.example.test',
  'https://receiver.example.test/#fragment',
  'https://receiver.example.test/#',
  'not a URL',
  'https://127.0.0.1',
  'https://[::1]',
  'https://2130706433',
  'https://0x7f000001',
  'https://[::ffff:169.254.169.254]',
  `https://receiver.example.test/${'a'.repeat(2048)}`,
])('rejects disallowed URL %s', async (url) => {
  await expect(validateWebhookUrl(url, false, publicLookup)).rejects.toMatchObject({ code: 'webhook_url_not_allowed' });
});
it('permits explicit HTTP but keeps the address policy', async () => {
  expect(await validateWebhookUrl('http://8.8.8.8/events', true)).toBe('http://8.8.8.8/events');
  await expect(validateWebhookUrl('http://127.0.0.1', true)).rejects.toBeInstanceOf(WebhookUrlError);
});
it('fails closed on mixed DNS answers, no answers and DNS failure', async () => {
  for (const addresses of [
    [],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
  ])
    await expect(validateWebhookUrl('https://receiver.example.test', false, async () => addresses)).rejects.toBeInstanceOf(WebhookUrlError);
  await expect(
    validateWebhookUrl('https://receiver.example.test', false, async () => {
      throw new Error('DNS unavailable');
    }),
  ).rejects.toBeInstanceOf(WebhookUrlError);
});
