# Transactional email setup and acceptance

Status: provider-neutral guidance checked on 2026-11-07. No provider/domain purchase, account,
DNS record, sender key or live email delivery was created or changed. Owner chooses the sending
domain, provider, sender and abuse/security contacts before launch.

## Sender identity and application settings

Prefer an owner-controlled transactional subdomain, for example `notify.example.test`, with
`MAIL_FROM=Logbird <hello@notify.example.test>`. Examples use reserved domains and are **not
publishable production DNS values**. Use the provider's verified sender, envelope/return-path
and DKIM settings. Logbird sends OTP, invitations and membership/role notifications through
`packages/email/src/send.ts`; supplying SMTP does not by itself verify domain authentication.

Store `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` privately, with minimum send-only scope.
For a provider supporting implicit TLS, set `SMTP_PORT=465`, `SMTP_SECURE=true`; validate the
certificate/hostname and provider requirements in staging. Port 587 with `SMTP_SECURE=false`
permits STARTTLS negotiation but the current transport does not set `requireTLS`.
Do not disable certificate verification or deploy 587 as a mandatory-TLS path until
the launch prerequisite below is shipped and verified.
Keep `AUTH_LOG_SIGN_IN_CODES=false` in cloud; log readers must never receive usable login codes.
Preserve existing SMTP credentials unless the owner explicitly authorizes rotation.

## Hetzner launch prerequisite

[Hetzner's Cloud FAQ](https://docs.hetzner.com/cloud/servers/faq/#why-can-i-not-send-any-mails-from-my-server)
states that outbound **25 and 465 are blocked by default**, per account. After one
month and payment of the first invoice, request unblocking in Console Limits with
the transactional use case; approval is case-by-case, not guaranteed. Record the
ticket/approval and test connectivity from the actual data-center/account before
choosing 465. The example cloud ConfigMap requires that approval.

Port **587 is not blocked**, but launch on that path requires [OPS-06 / #59](https://github.com/joodlab/logbird/issues/59):
implement configurable fail-closed Nodemailer `requireTLS`, verify certificate/host,
reject a server that does not offer STARTTLS, and prove actual OTP receipt through
the exact runtime image. Until then, simply setting `SMTP_SECURE=false` is insufficient.
An HTTPS mail-provider API would require a separately implemented/tested transport;
there is no such adapter to configure in the current source.

Retain 465 unblock + TLS/receipt proof **or** shipped 587 requireTLS + downgrade/receipt
proof in the [launch checklist](cloud-operations.md#launch-checklist). SMTP connect
timeouts are an expected first symptom of the Hetzner block: alert before users
repeatedly retry OTP. Never enable sign-in-code logging as a workaround. Recheck
the new account's port policy when moving a server between owners.

## DNS checklist

| Record | Operator action | Evidence to retain |
| --- | --- | --- |
| SPF TXT | Publish one SPF policy per envelope-sender domain, including only the provider's supplied mechanism; merge with an existing policy after inventorying other senders | DNS result and provider validation; no duplicate `v=spf1` records |
| DKIM TXT or CNAME | Publish the provider's exact selector records; keep signing private keys with the provider, use 2048-bit RSA where supported | Selector/domain and successful DKIM result; no private key in Git/tickets |
| DMARC TXT | Publish at `_dmarc.<visible-from-domain>`; begin with monitored `p=none`, then move to `quarantine`/`reject` after every legitimate sender is aligned | Policy, aggregate report destination and observed alignment across OTP/invitations/notifications |
| Custom return-path | Configure provider-supplied MX/TXT/CNAME records as required, without altering unrelated inbound mail | Envelope sender and SPF alignment from a received message |

An SPF shape is `v=spf1 include:<provider-supplied-domain> -all` **only after** all senders are
accounted for; the placeholder is not valid DNS configuration. SPF has a limit of ten
DNS-querying mechanisms/modifiers; nested includes count. Follow [RFC 7208](https://datatracker.ietf.org/doc/html/rfc7208).
DKIM authenticates the signing domain ([RFC 6376](https://datatracker.ietf.org/doc/html/rfc6376));
DMARC needs a passing SPF or DKIM identity aligned with the visible From domain. Use the current
[DMARC specification, RFC 9989](https://datatracker.ietf.org/doc/html/rfc9989) and
[aggregate reporting specification, RFC 9990](https://datatracker.ietf.org/doc/html/rfc9990).
Do not assume an unrelated provider domain authenticating successfully establishes alignment.

Example monitoring-only policy after choosing a real sender domain and report mailbox:

```text
_dmarc.notify.example.test. TXT "v=DMARC1; p=none; rua=mailto:dmarc-reports@example.test"
```

Verify report delivery and authorize external report destinations when required. Aggregate
reports contain sending metadata; restrict access and retention. Do not enable message-level
forensic reports by default. Move to enforcement only after provider validation, real message
headers and aggregate reports cover all legitimate senders; preserve other brands' DNS policies.
[Gmail sender guidance](https://support.google.com/a/answer/81126?hl=en) describes authentication,
alignment and supported DKIM key lengths. Transactional notifications must stay separate from
marketing; evaluate any later marketing sender's unsubscribe and bulk-sender requirements then.

## Delivery acceptance and failure handling

1. Verify public DNS after propagation using `dig TXT <envelope-domain>`,
   `dig TXT <selector>._domainkey.<signing-domain>` (or CNAME) and
   `dig TXT _dmarc.<from-domain>`. Keep only public records in the receipt.
2. Send a real OTP to an owned test mailbox and complete login on the configured HTTPS origin.
   Exercise resend, wrong/expired code and rate-limit behavior with fictional accounts. For local
   QA use `@example.test` and a mail sink; actual inbox acceptance needs an owner-controlled
   deliverable address. Do not publish that address, code or authentication cookie.
3. Send and accept an invitation as the invited address, then verify membership/role notification
   delivery. Inspect received `Authentication-Results`, visible From, envelope sender and DKIM
   domain: SPF pass, DKIM pass and DMARC pass/alignment. Provider API success alone is insufficient.
4. Record message IDs privately, send/receipt times, destination mailbox provider, spam placement,
   expiry/resend results and provider quota/rate behavior. Test at more than one receiving provider
   before claiming general deliverability; no delivery-latency target has been measured here.
5. Simulate SMTP timeout/rejection in staging; prove user-visible retry/error behavior and an
   operator alert without disclosing codes or addresses. Verify provider bounce/suppression
   handling and incident access outside the OTP login dependency. The current app does not
   implement a provider webhook/suppression pipeline; provider-side operation or a separate
   implementation is required. Do not invent successful delivery metrics.

On a sign-in email incident, inspect provider authentication, quota, suppression, DNS and TLS
from the independent operator channel. Preserve sender configuration and credentials; do not
switch on code logging as a cloud recovery shortcut. Announce the sign-in email component's
impact on the status page. Re-run OTP and invitation acceptance after recovery and close the
incident only when actual receipt is confirmed.
