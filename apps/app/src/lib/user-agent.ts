/**
 * A short, recognisable name for the client behind an API key's last request: the SDK or tool and its version when
 * the user agent says so ("@logbird/sdk/0.3.0", "curl/8.4.0", "python-requests/2.32"), "Node.js" for Node's built-in
 * fetch, "a browser" for browser user agents. Null when nothing was recorded.
 */
export function describeUserAgent(ua: string | null | undefined): string | null {
  const value = ua?.trim();
  if (!value) return null;
  const logbird = value.match(/@?logbird[\w./-]*\/v?\d[\w.-]*/i);
  if (logbird) return logbird[0];
  if (/^node$/i.test(value) || /^undici\b/i.test(value)) return 'Node.js';
  if (/^Mozilla\//.test(value)) return 'a browser';
  const first = value.split(/\s+/)[0] ?? value;
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}
