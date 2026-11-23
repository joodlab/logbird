import { createFileRoute, Link } from '@tanstack/react-router';
import { LegalDocument, LegalList, type LegalSection } from '../components/marketing/legal-document';
import { legalTerms } from '../content/legal-terms';
import { PrivacyContact } from '../lib/legal-facts';
import { pageHead } from '../lib/seo';

// Words: content/legal-terms.ts (owner-approved; marketing/copy/legal-terms.md lists the code facts behind these terms).
// This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/legal/terms')({ head: () => pageHead('/legal/terms'), component: TermsPage });

const { contact, agreement, earlyAccess, account, acceptableUse, yourData, availability, fees, ending, liability, changes, law } = legalTerms;

function Contact() {
  return contact.href ? (
    <a className="text-link" href={contact.href}>
      {contact.email}
    </a>
  ) : (
    <>
      {contact.form.before}
      <Link className="text-link" to="/contact">
        {contact.form.label}
      </Link>
    </>
  );
}

function Items({ items }: { items: readonly string[] }) {
  return (
    <LegalList>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </LegalList>
  );
}

const sections: LegalSection[] = [
  {
    id: agreement.id,
    title: agreement.title,
    body: (
      <>
        <p>{agreement.parties}</p>
        <p>
          {agreement.licence.before}
          {agreement.licence.repo.href ? (
            <>
              {agreement.licence.repo.before}
              <a className="text-link" href={agreement.licence.repo.href}>
                {agreement.licence.repo.label}
              </a>
            </>
          ) : null}
          {agreement.licence.after}
        </p>
      </>
    ),
  },
  {
    id: earlyAccess.id,
    title: earlyAccess.title,
    body: <p>{earlyAccess.body}</p>,
  },
  {
    id: account.id,
    title: account.title,
    body: <Items items={account.items} />,
  },
  {
    id: acceptableUse.id,
    title: acceptableUse.title,
    body: (
      <>
        <p>{acceptableUse.intro}</p>
        <Items items={acceptableUse.items} />
        <p>{acceptableUse.suspension}</p>
      </>
    ),
  },
  {
    id: yourData.id,
    title: yourData.title,
    body: (
      <>
        <p>
          {yourData.rights.before}
          <Link className="text-link" to="/legal/privacy">
            {yourData.rights.label}
          </Link>
          {yourData.rights.after}
        </p>
        <p>
          {yourData.access.before}
          <Contact />
          {yourData.access.after}
        </p>
      </>
    ),
  },
  {
    id: availability.id,
    title: availability.title,
    body: <p>{availability.body}</p>,
  },
  {
    id: fees.id,
    title: fees.title,
    body: <p>{fees.body}</p>,
  },
  {
    id: ending.id,
    title: ending.title,
    body: (
      <p>
        {ending.body.before}
        <PrivacyContact />
        {ending.body.after}
      </p>
    ),
  },
  {
    id: liability.id,
    title: liability.title,
    body: (
      <>
        <p>{liability.limits}</p>
        <p>{liability.consumer}</p>
      </>
    ),
  },
  {
    id: changes.id,
    title: changes.title,
    body: <p>{changes.body}</p>,
  },
  {
    id: law.id,
    title: law.title,
    body: (
      <p>
        {law.body.before}
        <Contact />
        {law.body.after}
      </p>
    ),
  },
];

function TermsPage() {
  return <LegalDocument lead={legalTerms.lead} sections={sections} title={legalTerms.title} />;
}
