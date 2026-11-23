import { createFileRoute, Link } from '@tanstack/react-router';
import { LegalDocument, LegalList, type LegalSection } from '../components/marketing/legal-document';
import { Rich } from '../components/marketing/rich';
import { legalPrivacy } from '../content/legal-privacy';
import { PrivacyContact, PrivacyRequestHow } from '../lib/legal-facts';
import { pageHead } from '../lib/seo';

// Words: content/legal-privacy.ts (owner-approved; marketing/copy/legal-privacy.md lists the code facts behind every
// statement). This file is layout only (content-modules.test.ts).
export const Route = createFileRoute('/legal/privacy')({ head: () => pageHead('/legal/privacy'), component: PrivacyPage });

const { who, website, form, accounts, customerData, sharing, transfers, retention, rights, security, children, changes } = legalPrivacy;

/** A list item with a bold lead-in; only items whose text has inline code go through Rich. */
function LeadItems({ items }: { items: readonly ({ lead: string; text: string } | { lead: string; rich: string })[] }) {
  return (
    <LegalList>
      {items.map((item) => (
        <li key={item.lead}>
          <strong>{item.lead}</strong>
          {'rich' in item ? <Rich text={item.rich} /> : item.text}
        </li>
      ))}
    </LegalList>
  );
}

const sections: LegalSection[] = [
  {
    id: who.id,
    title: who.title,
    body: (
      <>
        <p>
          {who.controller.before}
          <PrivacyContact />
          {who.controller.after}
        </p>
        <p>{who.scope}</p>
      </>
    ),
  },
  {
    id: website.id,
    title: website.title,
    body: (
      <>
        <p>{website.cookies}</p>
        <p>
          <Rich text={website.requestsRich} />
        </p>
        <p>{website.basis}</p>
      </>
    ),
  },
  {
    id: form.id,
    title: form.title,
    body: (
      <>
        <p>{form.stored}</p>
        <p>{form.use}</p>
        <p>
          {form.basis.before}
          <PrivacyContact />
          {form.basis.after}
        </p>
      </>
    ),
  },
  {
    id: accounts.id,
    title: accounts.title,
    body: (
      <>
        <p>{accounts.intro}</p>
        <LeadItems items={accounts.items} />
        <p>{accounts.basis}</p>
      </>
    ),
  },
  {
    id: customerData.id,
    title: customerData.title,
    body: (
      <>
        <p>{customerData.what}</p>
        <p>{customerData.roles}</p>
      </>
    ),
  },
  {
    id: sharing.id,
    title: sharing.title,
    body: (
      <>
        <p>{sharing.intro}</p>
        <LeadItems items={sharing.items} />
        <p>
          {sharing.github.before}
          {sharing.github.repo.href ? (
            <>
              {sharing.github.repo.before}
              <a className="text-link" href={sharing.github.repo.href}>
                {sharing.github.repo.label}
              </a>
              {sharing.github.repo.after}
            </>
          ) : null}
          {sharing.github.after}
        </p>
        <p>{sharing.disclosure}</p>
      </>
    ),
  },
  {
    id: transfers.id,
    title: transfers.title,
    body: <p>{transfers.body}</p>,
  },
  {
    id: retention.id,
    title: retention.title,
    body: (
      <LegalList>
        {retention.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </LegalList>
    ),
  },
  {
    id: rights.id,
    title: rights.title,
    body: (
      <>
        <p>{rights.what}</p>
        <p>
          {rights.how.before}
          <PrivacyRequestHow />
          {rights.how.after}
        </p>
      </>
    ),
  },
  {
    id: security.id,
    title: security.title,
    body: (
      <p>
        {security.body.before}
        <Link className="text-link" to="/security">
          {security.body.label}
        </Link>
        {security.body.after}
      </p>
    ),
  },
  {
    id: children.id,
    title: children.title,
    body: <p>{children.body}</p>,
  },
  {
    id: changes.id,
    title: changes.title,
    body: (
      <p>
        {changes.body.before}
        <PrivacyContact />
        {changes.body.after}
      </p>
    ),
  },
];

function PrivacyPage() {
  return <LegalDocument lead={legalPrivacy.lead} sections={sections} title={legalPrivacy.title} />;
}
