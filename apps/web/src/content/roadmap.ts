/**
 * The public roadmap as the site states it: only items docs/roadmap.md lists, worded no stronger than it ("candidates,
 * not delivery commitments"), and nothing already built. /product and /pricing render it; roadmap-claims.test.ts holds
 * the approved list and fails if this one drifts from it.
 */
export const roadmap = {
  eyebrow: 'On the roadmap',
  title: "What's on our roadmap.",
  lead: 'These are candidates from our public roadmap, not features or commitments. Order and timing can change.',
  items: [
    'Project-level redaction controls, behind the redaction your client already does.', // § Customer-facing history
    'Alerts on chosen actions.', // § Later candidates: "Action alerts"
    'Signed webhooks and archive exports.', // § Later candidates
    'Single sign-on for the console.', // § Later candidates: "Console SSO"
  ],
};
