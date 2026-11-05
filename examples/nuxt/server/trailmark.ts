export default {
  // Demo is localhost-only. Replace with a real session/record policy.
  authorize: () => ({ q: 'tenant:"demo-tenant" AND target:"demo-record"' }),
  actor: () => ({ type: 'user', id: 'demo-user' }),
  tenant: () => ({ id: 'demo-tenant' }),
  onError: console.error,
};
