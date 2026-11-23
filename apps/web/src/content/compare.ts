import { ACCESSED, longDate } from './comparisons';

/**
 * The words of the /compare pages around the facts: the index page, the furniture every comparison page shares, and
 * the Bemi page's capture figure. The facts themselves (summary, table rows, sources, what we couldn't verify) are in
 * comparisons.ts. Brief: marketing/copy/compare/README.md and marketing/copy/compare/*.md.
 */
export const compareContent = {
  index: {
    hero: {
      eyebrow: 'Compare',
      title: 'How Logbird compares.',
      lead: `There's more than one good way to keep an audit trail. These pages compare Logbird with other tools, using only facts we could check in their official docs, pricing pages and repositories. Each page says where the other tool is the better fit. We checked every fact about the other tools on ${longDate(ACCESSED)} and list every source. If something has changed, tell us and we'll fix it.`,
    },
    list: {
      eyebrow: 'Which tool fits',
      title: 'Each tool answers a different question.',
      categoryBadge: 'Different category',
      fitsWhen: 'Fits when: ',
      cardLink: (name: string) => `Logbird and ${name} compared`,
      logbird: {
        name: 'Logbird',
        fit: 'your events must stay on your own servers, you want to send any event shape, and your team needs an operator console to answer "what happened?".',
      },
    },
    method: {
      eyebrow: 'How we compare',
      title: 'Our rules for these pages.',
      rules: [
        'Official sources only: product docs, pricing pages, licence files and repositories.',
        'Each claim about another tool lists its sources, with the date we checked them. Logbird cells describe the current release.',
        "Anything we couldn't verify is left out of the tables and listed as unverified.",
        'No logos. Product names are used only to identify the products, as their owners write them.',
        'We say where Logbird has gaps, too.',
      ],
    },
  },
  page: {
    eyebrow: 'Compare',
    figureLabel: (name: string) => `How Logbird and ${name} record history`,
    table: {
      checkedOn: (date: string) => `Checked ${date}`,
      checkedFallback: 'Checked against official sources',
      lead: "Each claim about another product links to its source below. Anything we couldn't verify is left out.",
      title: 'At a glance',
      caption: (name: string) => `Logbird and ${name} compared, with a source for each claim about ${name}`,
      logbirdColumn: 'Logbird',
      topicHeader: 'Topic',
    },
    choose: {
      them: (name: string) => `When to choose ${name}`,
      logbird: 'When to choose Logbird',
    },
    sources: {
      title: 'Sources',
      accessed: (date: string) => `All accessed ${date}. If something has changed, tell us and we'll fix it.`,
      report: 'Report an outdated fact',
      all: 'All comparisons',
      listLabel: (name: string) => `Sources for the ${name} comparison`,
      sourceLabel: (id: string) => `Source ${id}`,
      newTab: ' (opens in a new tab)',
      also: 'Also: ',
      unverifiedTitle: "What we couldn't verify",
      unverifiedLead: 'Left out of the table: ',
    },
  },
  /** The Bemi page's figure: row changes captured from the WAL, versus actions your code reports. No logos. */
  bemiLanes: {
    laneLabel: (title: string) => `${title}: from your app to stored history`,
    lanes: [
      {
        title: 'Bemi',
        nodes: [
          { id: 'app', label: 'Your app' },
          { id: 'postgres', label: 'Postgres' },
          { id: 'wal', label: 'Write-ahead log' },
          { id: 'bemi', label: 'Bemi' },
          { id: 'changes', labelCode: 'changes', label: ' table', detail: 'table, primary_key, operation, before, after, context', accent: true },
        ],
      },
      {
        title: 'Logbird',
        nodes: [
          { id: 'code', label: 'Your app code', detailCode: "audit('booking.cancelled')" },
          { id: 'logbird', label: 'Logbird' },
          { id: 'explorer', label: 'Explorer', detail: 'actor, tenant, executor, targets, changes', accent: true },
        ],
      },
    ],
    caption:
      "Bemi reads every row change from Postgres's write-ahead log. Logbird stores the actions your code reports, including ones that never touch your database.",
  },
} as const;
