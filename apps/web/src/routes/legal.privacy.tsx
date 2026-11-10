import { createFileRoute, Link } from '@tanstack/react-router';
import { LegalDocument, LegalList, type LegalSection } from '../components/marketing/legal-document';
import { GITHUB_PUBLIC, GITHUB_URL } from '../env';
import {
  EMAIL_PROVIDER_TEXT,
  FORM_RETENTION,
  HOSTING_PROVIDER_TEXT,
  LEGAL_ADDRESS,
  OPERATOR,
  OPERATOR_SENTENCE_START,
  PrivacyContact,
} from '../lib/legal-facts';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/legal-privacy.md lists the code facts behind every statement here and the owner facts to confirm.
// Each claim must stay true to the code: check the file named in the copy notes before changing a sentence.
export const Route = createFileRoute('/legal/privacy')({ head: () => pageHead('/legal/privacy'), component: PrivacyPage });

const sections: LegalSection[] = [
  {
    id: 'who',
    title: 'Who we are and what this covers',
    body: (
      <>
        <p>
          {OPERATOR_SENTENCE_START} ("we") runs this website and Logbird Cloud, the hosted Logbird console. We decide how the personal data described
          here is used, so we are its controller.{LEGAL_ADDRESS ? ` Our address: ${LEGAL_ADDRESS}.` : ''} To contact us about privacy, use{' '}
          <PrivacyContact />.
        </p>
        <p>
          This policy covers the website, the contact and early-access form, and Logbird Cloud accounts. It doesn't cover Logbird installations that
          other people run on their own servers: whoever runs an installation decides what happens to its data, and the self-hosted software sends no
          usage data back to us.
        </p>
      </>
    ),
  },
  {
    id: 'website',
    title: 'Visiting the website',
    body: (
      <>
        <p>
          The website sets no cookies and loads no analytics, advertising or tracking scripts. Its fonts are served from our own origin. Your browser
          stores one preference, your colour theme, in its local storage; it never leaves your device.
        </p>
        <p>
          Every request passes through Cloudflare, our content delivery network, and reaches our servers. Like any web server, they process your IP
          address, browser details and the page you ask for, to deliver and protect the site. Our own request logs record the method, path, status and
          duration of each request, not your IP address or browser. The API reference page (<code>/docs</code>) loads its viewer script from jsDelivr,
          so on that page your browser also connects to jsDelivr.
        </p>
        <p>We do this because we have a legitimate interest in running a secure, working website.</p>
      </>
    ),
  },
  {
    id: 'form',
    title: 'The contact and early-access form',
    body: (
      <>
        <p>
          When you send the form we store your email address, the topic you choose, and the name, company and message if you give them, with the time
          you sent it. We don't store your IP address or browser details with it. Your IP address is held in memory for about a minute to stop the
          form being flooded, then forgotten.
        </p>
        <p>
          We keep submissions on our server and forward them by email to the team that answers them. We use them to reply, to decide on access to
          Logbird Cloud and, if you chose "Product updates only", to send you product updates.
        </p>
        <p>
          We reply because you asked us to (steps you request before any contract, and our legitimate interest in answering). Product updates rely on
          your consent, which you can withdraw at any time. We keep submissions for {FORM_RETENTION}, or delete them sooner if you ask.
        </p>
      </>
    ),
  },
  {
    id: 'accounts',
    title: 'Logbird Cloud accounts',
    body: (
      <>
        <p>When you use Logbird Cloud we process:</p>
        <LegalList>
          <li>
            <strong>Account details</strong>: your email address and display name. We also keep a keyed hash of your email address to link failed
            sign-in attempts to your workspaces without storing the address you typed.
          </li>
          <li>
            <strong>Sign-in codes</strong>: you sign in with a six-digit code we email to you. We store only a hash of the code; it expires after 10
            minutes and allows three attempts. The email shows the device and IP address that asked for it, so you can spot attempts that weren't
            yours.
          </li>
          <li>
            <strong>Sessions</strong>: one essential cookie keeps you signed in (<code>__Secure-logbird.session_token</code>: HTTP-only, secure,
            same-site). It lasts 7 days and renews while you use the console. For each session we store its IP address and browser details.
          </li>
          <li>
            <strong>Workspace activity</strong>: sign-ins, sign-outs, failed sign-in attempts on your address and management actions (such as inviting
            members, changing roles, creating keys or exporting data) are recorded with your name or email, IP address and browser details. Every
            member of that workspace can see its activity.
          </li>
          <li>
            <strong>Invitations and notices</strong>: when someone invites you we store your email address with the invitation, and we email you
            sign-in codes, invitations, and notices when someone joins a workspace or your role changes. These emails contain no tracking pixels or
            tracked links.
          </li>
          <li>
            <strong>Preferences</strong>: the console keeps your theme, sidebar state, last project and recent queries in your browser's storage and
            one functional cookie (<code>sidebar_state</code>).
          </li>
        </LegalList>
        <p>
          We need this to provide the service you signed up for (performance of a contract). We keep sign-in, session and activity records because we
          have a legitimate interest in keeping accounts secure and making changes accountable.
        </p>
      </>
    ),
  },
  {
    id: 'customer-data',
    title: 'Data you send to Logbird Cloud',
    body: (
      <>
        <p>
          Logbird stores the audit events your applications send to it. Those events often contain personal data about your own users, such as names,
          email addresses, IP addresses and the actions they took. Logbird stores what you send as you send it.
        </p>
        <p>
          For that data you are the controller and we are your processor: we store, search, export and delete it only to provide the service to you,
          on your instructions, and never use it for our own purposes. You decide what to send (the SDK can redact fields before they leave your
          servers) and how long to keep it. If you are one of a customer's users, contact that customer about your data; we'll help them answer you.
        </p>
      </>
    ),
  },
  {
    id: 'sharing',
    title: 'Who processes data for us',
    body: (
      <>
        <p>We don't sell personal data or share it for advertising. These providers process it on our behalf:</p>
        <LegalList>
          <li>
            <strong>Cloudflare</strong>: delivers and protects all traffic to this website and to Logbird Cloud.
          </li>
          <li>
            <strong>Server hosting</strong>: {HOSTING_PROVIDER_TEXT} runs the servers that store Logbird Cloud data, form submissions and backups.
          </li>
          <li>
            <strong>Email delivery</strong>: {EMAIL_PROVIDER_TEXT} sends sign-in codes, invitations and notices, and forwards form submissions to our
            team.
          </li>
          <li>
            <strong>jsDelivr</strong>: serves the API reference viewer script to browsers that open <code>/docs</code>.
          </li>
        </LegalList>
        <p>
          Our source code and releases are published on GitHub
          {GITHUB_PUBLIC && GITHUB_URL ? (
            <>
              {' '}
              (
              <a className="text-link" href={GITHUB_URL}>
                the repository
              </a>
              )
            </>
          ) : null}
          . This website reads public release information from GitHub when it is built; no visitor data is involved. If you open an issue or
          contribute there, GitHub's own privacy terms apply.
        </p>
        <p>We may also disclose data when the law requires it.</p>
      </>
    ),
  },
  {
    id: 'transfers',
    title: 'International transfers',
    body: (
      <p>
        Cloudflare operates a global network, and our providers may process data outside your country. Where the law requires it, these transfers rely
        on the safeguards our providers offer, such as standard contractual clauses.
      </p>
    ),
  },
  {
    id: 'retention',
    title: 'How long we keep data',
    body: (
      <LegalList>
        <li>Form submissions: {FORM_RETENTION}, or until you ask us to delete them.</li>
        <li>
          Account details, invitations and session records: while your account exists. Expired sessions and sign-in codes stop working at once but
          stay in the database with your account.
        </li>
        <li>Workspace activity: up to 10 years. There is no shorter setting for it yet.</li>
        <li>
          Data you send to Logbird Cloud: as long as each project's retention setting says, from 7 days to 10 years (90 days by default). Expired
          events, and every event in a deleted project, are permanently deleted from the live database.
        </li>
        <li>Backups: we keep backups of Logbird Cloud. Deleted data can remain in a backup until that backup expires on its regular rotation.</li>
        <li>Server logs: only as long as we need them to run and debug the service.</li>
      </LegalList>
    ),
  },
  {
    id: 'rights',
    title: 'Your rights',
    body: (
      <>
        <p>
          Depending on where you live, you can ask us to access, correct, delete or export your personal data, to restrict or object to how we use it,
          and to withdraw consent you gave. You can also complain to your data protection authority.
        </p>
        <p>
          You can change your display name in the console's account settings. Everything else, including deleting your account, is handled by request
          for now: write to <PrivacyContact /> from the address on your account, or tell us which address the request is about so we can verify it. We
          answer within 30 days.
        </p>
      </>
    ),
  },
  {
    id: 'security',
    title: 'Security',
    body: (
      <p>
        All traffic is encrypted in transit. Session cookies are HTTP-only and secure, sign-in codes are stored as hashes, sign-in and form requests
        are rate-limited, and every project's data is isolated from other projects. The{' '}
        <Link className="text-link" to="/security">
          security page
        </Link>{' '}
        explains these protections and their limits.
      </p>
    ),
  },
  {
    id: 'children',
    title: 'Children',
    body: <p>The website and Logbird Cloud are for businesses and developers, not for children under 16. We don't knowingly collect their data.</p>,
  },
  {
    id: 'changes',
    title: 'Changes to this policy',
    body: (
      <p>
        When we change this policy we update the effective date above. If a change matters to how we use account data, we'll email account holders
        before it takes effect. Questions about this policy go to <PrivacyContact />.
      </p>
    ),
  },
];

function PrivacyPage() {
  return (
    <LegalDocument
      lead={`What ${OPERATOR} collects through this website and Logbird Cloud, why, who processes it for us, how long we keep it, and how to exercise your rights.`}
      sections={sections}
      title="Privacy policy"
    />
  );
}
