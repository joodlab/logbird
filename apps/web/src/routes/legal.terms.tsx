import { createFileRoute, Link } from '@tanstack/react-router';
import { LegalDocument, LegalList, type LegalSection } from '../components/marketing/legal-document';
import { CONTACT_EMAIL, GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { FEE_NOTICE_DAYS, GOVERNING_LAW_TEXT, LEGAL_ADDRESS, OPERATOR, OPERATOR_SENTENCE_START } from '../lib/legal-facts';
import { pageHead } from '../lib/seo';

// Copy: marketing/copy/legal-terms.md lists the code facts behind these terms and the owner facts to confirm.
export const Route = createFileRoute('/legal/terms')({ head: () => pageHead('/legal/terms'), component: TermsPage });

function Contact() {
  return CONTACT_EMAIL ? (
    <a className="text-link" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
  ) : (
    <>
      the{' '}
      <Link className="text-link" to="/contact">
        contact form
      </Link>
    </>
  );
}

const sections: LegalSection[] = [
  {
    id: 'agreement',
    title: 'These terms',
    body: (
      <>
        <p>
          These terms are an agreement between you and {OPERATOR} ("we"){LEGAL_ADDRESS ? `, ${LEGAL_ADDRESS}` : ''}. They cover this website and
          Logbird Cloud, the hosted Logbird console. If you use Logbird Cloud for an organisation, you accept them on its behalf and confirm you may
          do so. By creating an account or using the service you accept these terms.
        </p>
        <p>
          The Logbird software itself is open source under the MIT licence
          {GITHUB_PUBLIC && GITHUB_URL ? (
            <>
              , published in{' '}
              <a className="text-link" href={GITHUB_URL}>
                its repository
              </a>
            </>
          ) : null}
          . These terms don't limit anything the MIT licence allows; they only cover the service we run.
        </p>
      </>
    ),
  },
  {
    id: 'early-access',
    title: 'Early access',
    body: (
      <p>
        Logbird Cloud is in early access: we limit sign-ups to invited teams and approved email domains. Features, limits and these terms may change
        as the service develops. Sending the contact form doesn't create an account or a contract.
      </p>
    ),
  },
  {
    id: 'account',
    title: 'Your account',
    body: (
      <LegalList>
        <li>You sign in with codes sent to your email address, so keep that mailbox secure and use an address you control.</li>
        <li>
          Workspace owners and admins decide who joins a workspace and what role they have. You're responsible for the people you invite and for what
          they do in your workspaces.
        </li>
        <li>Keep API keys secret. Anyone with a key can use it until you revoke it.</li>
        <li>Tell us promptly if you think someone has gained access to your account or keys.</li>
      </LegalList>
    ),
  },
  {
    id: 'acceptable-use',
    title: 'Acceptable use',
    body: (
      <>
        <p>Don't use Logbird Cloud to:</p>
        <LegalList>
          <li>break the law, or store data you have no right to process;</li>
          <li>send secrets such as passwords, keys or full payment card numbers in events;</li>
          <li>attack, probe or overload the service, or try to reach other customers' data;</li>
          <li>get around rate limits, access restrictions or the sign-up policy;</li>
          <li>resell or provide the service to others as your own hosted product without our written agreement.</li>
        </LegalList>
        <p>We may suspend access that puts the service, other customers or the public at risk.</p>
      </>
    ),
  },
  {
    id: 'your-data',
    title: 'Your data',
    body: (
      <>
        <p>
          You keep all rights to the data you send to Logbird Cloud. You give us permission to store, process and display it only to provide the
          service to you. For personal data in it, we act as your processor, as the{' '}
          <Link className="text-link" to="/legal/privacy">
            privacy policy
          </Link>{' '}
          explains. You're responsible for having a lawful basis to send it and for telling your users.
        </p>
        <p>
          You choose each project's retention period, and you can export events from the console at any time. We don't look at your data except to
          operate and secure the service, to help when you ask us to, or when the law requires it. If you need a data processing agreement, contact
          us.
        </p>
      </>
    ),
  },
  {
    id: 'availability',
    title: 'Availability and changes',
    body: (
      <p>
        We work to keep Logbird Cloud available and we keep backups, but during early access there is no service level agreement and no guaranteed
        uptime. We may change or interrupt the service, for example for maintenance or upgrades, and will tell you in advance about changes that
        remove features you rely on. Keep your own exports of anything you can't afford to lose.
      </p>
    ),
  },
  {
    id: 'fees',
    title: 'Fees',
    body: (
      <p>
        Logbird Cloud is free during early access. Before we introduce any fees we'll tell account holders at least {FEE_NOTICE_DAYS} days in advance,
        and you can export your data and close your account before they apply.
      </p>
    ),
  },
  {
    id: 'ending',
    title: 'Ending the agreement',
    body: (
      <p>
        You can stop using Logbird Cloud at any time and ask us to delete your account and workspaces by writing to <Contact />. We may end or suspend
        your access if you break these terms or if we stop offering the service. Unless we must act at once (for example, for abuse or a legal
        requirement), we'll give you notice and time to export your data first. After that, we delete your data as the privacy policy describes.
      </p>
    ),
  },
  {
    id: 'liability',
    title: 'Warranties and liability',
    body: (
      <>
        <p>
          During early access the service is provided "as is", without warranties of any kind, to the extent the law allows. We aren't liable for
          indirect or consequential losses, such as lost profits or lost data you could have exported, and our total liability for any claim is
          limited to what you paid us for the service in the 12 months before it (nothing while it is free).
        </p>
        <p>
          Nothing in these terms limits liability that the law doesn't allow to be limited, or your rights as a consumer where consumer law applies.
        </p>
      </>
    ),
  },
  {
    id: 'law',
    title: 'Governing law',
    body: (
      <p>
        These terms are governed by {GOVERNING_LAW_TEXT}. If any part of them can't be enforced, the rest still applies. {OPERATOR_SENTENCE_START} may
        update these terms; we'll change the effective date above and tell account holders about material changes before they apply. Questions go to{' '}
        <Contact />.
      </p>
    ),
  },
];

function TermsPage() {
  return (
    <LegalDocument
      lead="The terms for using this website and Logbird Cloud during early access. The open-source Logbird software stays under the MIT licence."
      sections={sections}
      title="Terms of service"
    />
  );
}
