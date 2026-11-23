import { GITHUB_PUBLIC, GITHUB_URL, PRIVACY_EMAIL } from '../env';
import {
  CLOSURE_DELETION_DAYS,
  EMAIL_PROVIDER_TEXT,
  FORM_RETENTION,
  FORM_RETENTION_PERIOD,
  HOSTING_PROVIDER_TEXT,
  LEGAL_ADDRESS,
  MAILBOX_PROVIDER_TEXT,
  OPERATOR,
  OPERATOR_SENTENCE_START,
} from '../lib/legal-facts';

/**
 * Words of /legal/privacy, owner-approved: change no word without the owner. marketing/copy/legal-privacy.md lists the
 * code facts behind every statement here and the owner facts to confirm; each claim must stay true to the code, so
 * check the file named in the copy notes before changing a sentence. Owner facts come from lib/legal-facts.tsx (WEB_*
 * settings, with wording that stays true while they are unset).
 *
 * A sentence around a link or the privacy contact is split into `before` and `after`; the route renders the element
 * between them. Inline `code` (components/marketing/rich.tsx) only in `rich` texts. A list item's `lead` is its bold
 * lead-in.
 */
export const legalPrivacy = {
  title: 'Privacy policy',
  lead: `What ${OPERATOR} collects through this website and Logbird Cloud, why, who processes it for us, how long we keep it, and how to exercise your rights.`,
  who: {
    id: 'who',
    title: 'Who we are and what this covers',
    /** Ends with the privacy contact. */
    controller: {
      before: `${OPERATOR_SENTENCE_START} ("we") runs this website and Logbird Cloud, the hosted Logbird console. For the personal data described here, except the data you send to Logbird Cloud (see below), we decide how it is used, so we are its controller.${LEGAL_ADDRESS ? ` Our address: ${LEGAL_ADDRESS}.` : ''} To contact us about privacy, use `,
      after: '.',
    },
    scope:
      "This policy covers the website, the contact and early-access form, and Logbird Cloud accounts. It doesn't cover Logbird installations that other people run on their own servers: whoever runs an installation decides what happens to its data, and the self-hosted software sends no usage data back to us.",
  },
  website: {
    id: 'website',
    title: 'Visiting the website',
    cookies:
      "The website sets no cookies of its own and loads no analytics, advertising or tracking scripts. Cloudflare may set a strictly necessary security cookie to filter bots. The site's fonts are served from our own origin. Your browser stores one preference, your colour theme, in its local storage; it never leaves your device.",
    requestsRich:
      "Every request passes through Cloudflare, our content delivery network, and reaches our servers. Like any web server, they process your IP address, browser details and the page you ask for, to deliver and protect the site; Cloudflare and our server provider may keep access logs of these requests. The request logs of our API record the method, path, status and duration of each request, not your IP address or browser. Logbird Cloud's API reference page (`/docs`) loads its viewer script from jsDelivr, a public content network: on that page your browser connects to jsDelivr directly, which receives your IP address.",
    basis: 'We do this because we have a legitimate interest in running a secure, working website.',
  },
  form: {
    id: 'form',
    title: 'The contact and early-access form',
    stored:
      "Only your email address is required; without it we can't reply. When you send the form we store your email address, the topic you choose, and the name, company, expected monthly event volume, needs and message if you give them, with the time you sent it. We don't store your IP address or browser details with it. To stop the form being flooded, the server keeps a count of submissions per IP address in memory only. The form never writes the address to disk or to its own logs, and each count is dropped after its one-minute window (on a later request) or when the server restarts.",
    use: 'We keep submissions on our server, and our server emails each one to our team\'s mailbox, where we answer them. We use them to reply, to decide on access to Logbird Cloud and, if you chose "Product updates only", to send you product updates.',
    /** The privacy contact sits between the two parts. */
    basis: {
      before:
        'We reply because you asked us to (steps you request before any contract, and our legitimate interest in answering). Product updates rely on your consent, which you can withdraw at any time by replying to any update or through ',
      after: `. Our server deletes its copy of a submission automatically once it is ${FORM_RETENTION_PERIOD} old, within two days. The copy in our mailbox and our emails with you are kept for ${FORM_RETENTION}. We delete any of them sooner if you ask.`,
    },
  },
  accounts: {
    id: 'accounts',
    title: 'Logbird Cloud accounts',
    intro: 'When you use Logbird Cloud we process:',
    items: [
      {
        lead: 'Account details',
        text: ': your email address and display name. We also keep a keyed hash of your email address to link failed sign-in attempts to your workspaces without storing the address you typed.',
      },
      {
        lead: 'Sign-in codes',
        text: ": you sign in with a six-digit code we email to you. We store only a hash of the code; it expires after 10 minutes and allows three attempts. The email shows the device and IP address that asked for it, so you can spot attempts that weren't yours.",
      },
      {
        lead: 'Sessions',
        rich: ': one essential cookie keeps you signed in (`__Secure-logbird.session_token`: HTTP-only, secure, same-site). It lasts 7 days and renews while you use the console. For each session we store its IP address and browser details.',
      },
      {
        lead: 'Workspace activity',
        text: ': sign-ins, sign-outs, failed sign-in attempts on your address and management actions (such as inviting members, changing roles, creating keys or exporting data) are recorded with your name or email, IP address and browser details. Every member of that workspace can see its activity.',
      },
      {
        lead: 'Invitations and notices',
        text: ": when someone invites you we store your email address with the invitation and in that workspace's activity, and we email you sign-in codes, invitations, and notices when someone joins a workspace or your role changes. These emails contain no tracking pixels or tracked links.",
      },
      {
        lead: 'Preferences',
        rich: ": the console keeps your theme, sidebar state, last project, recent queries and similar view settings in your browser's storage and one functional cookie (`sidebar_state`).",
      },
    ],
    basis:
      "We need this to provide the service you signed up for (performance of a contract). For people invited to a workspace, we rely on our and the workspace's legitimate interest in sending the invitation. We keep sign-in, session and activity records because we have a legitimate interest in keeping accounts secure and making changes accountable.",
  },
  customerData: {
    id: 'customer-data',
    title: 'Data you send to Logbird Cloud',
    what: 'Logbird stores the audit events your applications send to it. Those events often contain personal data about your own users, such as names, email addresses, IP addresses and the actions they took. Logbird stores what you send as you send it.',
    roles:
      "For that data you are the controller and we are your processor: we store, search, export and delete it only to provide the service to you, on your instructions, and never use it for our own purposes. You decide what to send (the SDK can redact fields before they leave your servers) and how long to keep it. If you are one of a customer's users, contact that customer about your data; we'll help them answer you.",
  },
  sharing: {
    id: 'sharing',
    title: 'Who processes data for us',
    intro: "We don't sell personal data or share it for advertising. These providers process it on our behalf:",
    items: [
      { lead: 'Cloudflare', text: ': delivers and protects all traffic to this website and to Logbird Cloud.' },
      { lead: 'Server hosting', text: `: ${HOSTING_PROVIDER_TEXT} runs the servers that store Logbird Cloud data and form submissions.` },
      {
        lead: 'Email delivery',
        text: `: ${EMAIL_PROVIDER_TEXT} sends Logbird Cloud's sign-in codes, invitations and notices. Form submissions reach our team's mailbox through our email delivery provider.`,
      },
      { lead: 'Our mailbox', text: `: ${MAILBOX_PROVIDER_TEXT} hosts the team mailbox that receives form submissions and the emails you send us.` },
      { lead: 'Backups', text: ': stored with our server provider or a storage provider we choose.' },
    ],
    /** The repository link, in brackets, only while the repository is public. */
    github: {
      before: 'Our source code and releases are published on GitHub',
      repo: { href: GITHUB_PUBLIC && GITHUB_URL ? GITHUB_URL : undefined, before: ' (', label: 'the repository', after: ')' },
      after:
        ". This website reads public release information from GitHub when it is built; no visitor data is involved. If you open an issue or contribute there, GitHub's own privacy terms apply.",
    },
    disclosure: "We may also disclose data when the law requires it. We don't make decisions about you by automated means alone.",
  },
  transfers: {
    id: 'transfers',
    title: 'International transfers',
    body: 'Cloudflare operates a global network, and our providers may process data outside your country. Where the law requires it, these transfers rely on the safeguards our providers offer, such as standard contractual clauses.',
  },
  retention: {
    id: 'retention',
    title: 'How long we keep data',
    items: [
      `Form submissions on our server: deleted automatically once they are ${FORM_RETENTION_PERIOD} old, within two days. Their copies in our mailbox and our emails with you: ${FORM_RETENTION}. Either sooner if you ask us to delete them.`,
      `Closed accounts: deleted within ${CLOSURE_DELETION_DAYS} days of closing, together with each workspace where the account was the only owner (including its projects and events). Workspaces with other owners stay.`,
      "Account details: while your account exists. Sessions and sign-in codes: they stop working when they expire (7 days and 10 minutes). An hourly cleanup deletes sessions once they've been expired for a day and codes once they've been expired for an hour, usually within the following hour. Invitations: deleted 30 days after they expire, whether or not they were accepted, or earlier with the workspace or the account that sent them.",
      'Workspace activity: activity records are deleted after 10 years at the latest; there is no shorter setting yet. If you close your account, records of what you did in workspaces that still exist stay in their activity, so changes remain accountable, within the same limit. Copies kept to power search filters (names and sample values) and records still waiting to be delivered have no automatic limit yet.',
      "Data you send to Logbird Cloud: as long as each project's retention setting says, from 7 days to 10 years (90 days by default). Expired events, and every event in a deleted project, are permanently deleted from the live database.",
      'Backups: we keep backups of Logbird Cloud. Deleted data can remain in a backup until that backup expires on its regular rotation.',
      'Server logs: only as long as we need them to run and debug the service.',
    ],
  },
  rights: {
    id: 'rights',
    title: 'Your rights',
    what: 'Depending on where you live, you can ask us to access, correct, delete or export your personal data, to restrict or object to how we use it, and to withdraw consent you gave. You can also complain to your data protection authority.',
    /** How to make a request (PrivacyRequestHow) sits between the two parts. */
    how: {
      before:
        "In the console you can change your display name, and, if your role allows, export or delete a project's data. Deleting your account and getting a copy of your personal account data are handled by request for now. To make a request, ",
      after: `. ${PRIVACY_EMAIL ? "If you can't use that address, tell us which one the request is about and we'll check that it's yours. " : ''}We answer within 30 days, and use the details in your request only to handle it (a legal obligation).`,
    },
  },
  security: {
    id: 'security',
    title: 'Security',
    /** The link to /security sits between the parts. */
    body: {
      before:
        "Connections to this website and to Logbird Cloud are encrypted with HTTPS. Session cookies are HTTP-only and secure, sign-in codes are stored as hashes, sign-in and form requests are rate-limited, and every project's data is isolated from other projects. The ",
      label: 'security page',
      after: ' explains these protections and their limits.',
    },
  },
  children: {
    id: 'children',
    title: 'Children',
    body: "The website and Logbird Cloud are for businesses and developers, not for children under 16. We don't knowingly collect their data.",
  },
  changes: {
    id: 'changes',
    title: 'Changes to this policy',
    /** Ends with the privacy contact. */
    body: {
      before:
        "When we change this policy we update the effective date above. If a change matters to how we use account data, we'll email account holders before it takes effect. Questions about this policy go to ",
      after: '.',
    },
  },
} as const;
