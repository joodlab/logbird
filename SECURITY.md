# Security policy

Version 0.1.x is the initial supported line. Run the deployment checklist before accepting customer data.

Report vulnerabilities privately through GitHub Security → Advisories → Report a vulnerability. Never post exploit details or credentials in public issues. If unavailable, request a private channel from maintainers before sharing details.

Before public release, maintainers must enable GitHub private vulnerability reporting and fill **SECURITY_CONTACT_EMAIL (not configured)**.

Include affected version, fictional reproduction and impact. We coordinate remediation and disclosure privately. No response-time SLA is offered yet.

## Authorization threat notes

Workspace membership alone does not authorize administration. The server's explicit
mutation matrix in `apps/server/src/middlewares/require-role.ts` implements SPEC
section 7.1: owner/admin administer projects, keys, retention, sample data, test events
and invite links; members explore/export/read workspace activity and save views.
Members delete only their own views (404 for another author's); admins delete any.
Bearer invitation previews and acceptance have separate token/session constraints;
invite-link listing is admin-only because it exposes invitation capabilities.
Better-auth owns its authentication, self-service and organization ACLs. Unlisted
console mutations default to deny for every role. Roles are read from membership
in the target project's active organization, including comma-separated role grants.
Cross-workspace IDs must never disclose or mutate project data. UI visibility is
only a convenience: API checks enforce the boundary. `/api/me` returns current roles.
Lower retention and project deletion require the project slug, in the PATCH body
or DELETE `confirm` query respectively; confirmation never substitutes for a role check.
