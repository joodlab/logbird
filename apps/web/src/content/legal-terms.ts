import { CONTACT_EMAIL, GITHUB_PUBLIC, GITHUB_URL } from '../env';
import { CLOSURE_DELETION_DAYS, FEE_NOTICE_DAYS, GOVERNING_LAW_TEXT, LEGAL_ADDRESS, OPERATOR } from '../lib/legal-facts';

/**
 * Words of /legal/terms, owner-approved: change no word without the owner. marketing/copy/legal-terms.md lists the code
 * facts behind these terms and the owner facts to confirm. Owner facts come from lib/legal-facts.tsx.
 *
 * A sentence around a link, the contact or the privacy contact is split into `before` and `after`; the route renders the
 * element between them.
 */
export const legalTerms = {
  title: 'Terms of service',
  lead: 'The terms for using this website and Logbird Cloud during early access. The open-source Logbird software stays under the MIT licence.',
  /** How to reach us: the contact mailbox once WEB_CONTACT_EMAIL is set, otherwise the contact form. */
  contact: {
    email: CONTACT_EMAIL,
    href: CONTACT_EMAIL ? `mailto:${CONTACT_EMAIL}` : undefined,
    form: { before: 'the ', label: 'contact form' },
  },
  agreement: {
    id: 'agreement',
    title: 'These terms',
    parties: `These terms are an agreement between you and ${OPERATOR} ("we")${LEGAL_ADDRESS ? `, ${LEGAL_ADDRESS}` : ''}. They cover this website and Logbird Cloud, the hosted Logbird console. If you use Logbird Cloud for an organisation, you accept them on its behalf and confirm you may do so. By creating an account or using the service you accept these terms.`,
    /** The repository link only while the repository is public. */
    licence: {
      before: 'The Logbird software itself is open source under the MIT licence',
      repo: { href: GITHUB_PUBLIC && GITHUB_URL ? GITHUB_URL : undefined, before: ', published in ', label: 'its repository' },
      after: ". These terms don't limit anything the MIT licence allows; they only cover the service we run.",
    },
  },
  earlyAccess: {
    id: 'early-access',
    title: 'Early access',
    body: "Logbird Cloud is in early access: we limit sign-ups to invited teams (people with an invitation or an approved email domain). Features, limits and these terms may change as the service develops. Sending the contact form doesn't create an account or a contract.",
  },
  account: {
    id: 'account',
    title: 'Your account',
    items: [
      'You sign in with codes sent to your email address, so keep that mailbox secure and use an address you control.',
      "Workspace owners and admins decide who joins a workspace and what role they have. You're responsible for the people you invite and for what they do in your workspaces.",
      'Keep API keys secret. Anyone with a key can use it until you revoke it.',
      'Tell us promptly if you think someone has gained access to your account or keys.',
    ],
  },
  acceptableUse: {
    id: 'acceptable-use',
    title: 'Acceptable use',
    intro: "Don't use Logbird Cloud to:",
    items: [
      'break the law, or store data you have no right to process;',
      'send secrets such as passwords, keys or full payment card numbers in events;',
      "attack, probe or overload the service, or try to reach other customers' data;",
      'get around rate limits, access restrictions or the sign-up policy;',
      'resell or provide the service to others as your own hosted product without our written agreement.',
    ],
    suspension: 'We may suspend access that puts the service, other customers or the public at risk.',
  },
  yourData: {
    id: 'your-data',
    title: 'Your data',
    /** The link to /legal/privacy sits between the parts. */
    rights: {
      before:
        'You keep all rights to the data you send to Logbird Cloud. You give us permission to store, process and display it only to provide the service to you. For personal data in it, we act as your processor, as the ',
      label: 'privacy policy',
      after: " explains. You're responsible for having a lawful basis to send it and for telling your users.",
    },
    /** Ends with the contact. */
    access: {
      before:
        "You choose each project's retention period, and you can export events from the console at any time if your role allows. We don't look at your data except to operate and secure the service, to help when you ask us to, or when the law requires it. If you need a data processing agreement, contact us through ",
      after: '.',
    },
  },
  availability: {
    id: 'availability',
    title: 'Availability and changes',
    body: "We work to keep Logbird Cloud available and we keep backups, but during early access there is no service level agreement and no guaranteed uptime. We may change or interrupt the service, for example for maintenance or upgrades, and will tell you in advance about changes that remove features you rely on. Keep your own exports of anything you can't afford to lose.",
  },
  fees: {
    id: 'fees',
    title: 'Fees',
    body: `Logbird Cloud is free during early access. Before we introduce any fees we'll tell account holders at least ${FEE_NOTICE_DAYS} days in advance, and you can export your data (if your role allows) and ask us to close your account before they apply.`,
  },
  ending: {
    id: 'ending',
    title: 'Ending the agreement',
    /** The privacy contact sits between the parts. */
    body: {
      before: 'You can stop using Logbird Cloud at any time and ask us, through ',
      after: `, to delete your account and any workspace where you're the only owner. We may suspend your access if you break these terms, and end it if you seriously or repeatedly break them or if we stop offering the service. Unless we must act at once (for example, for abuse or a legal requirement), we'll give you notice and time to export your data before ending your access. Once your account is closed, at your request or ours, we delete it, and each workspace where you were the only owner with its projects and events, within ${CLOSURE_DELETION_DAYS} days. In any other workspace, we only remove you. If others still use a workspace you own alone, make one of them an owner before you close your account. Copies in backups expire on their regular rotation.`,
    },
  },
  liability: {
    id: 'liability',
    title: 'Warranties and liability',
    limits:
      'During early access the service is provided "as is", without warranties of any kind, to the extent the law allows. We aren\'t liable for indirect or consequential losses, such as lost profits or lost data you could have exported, and our total liability for all claims together is limited to the greater of what you paid us in the 12 months before the claim and 100 euros (or the equivalent in your currency).',
    consumer:
      "Nothing in these terms limits liability that the law doesn't allow to be limited, or your rights as a consumer where consumer law applies.",
  },
  changes: {
    id: 'changes',
    title: 'Changes to these terms',
    body: "We may update these terms. We'll change the effective date above and tell account holders about material changes before they apply.",
  },
  law: {
    id: 'law',
    title: 'Governing law',
    /** Ends with the contact. */
    body: {
      before: `These terms are governed by ${GOVERNING_LAW_TEXT}. If any part of them can't be enforced, the rest still applies. Questions go to `,
      after: '.',
    },
  },
} as const;
