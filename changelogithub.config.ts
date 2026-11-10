import { defineConfig } from 'changelogithub';

export default defineConfig({
  types: {
    feat: { title: 'Features' },
    fix: { title: 'Bug fixes' },
    perf: { title: 'Performance' },
    refactor: { title: 'Refactoring' },
    docs: { title: 'Documentation' },
    build: { title: 'Build' },
    ci: { title: 'CI' },
    test: { title: 'Tests' },
    chore: { title: 'Maintenance' },
    revert: { title: 'Reverts' },
    style: { title: 'Style' },
    other: { title: 'Other changes' },
  },
  titles: { breakingChanges: 'Breaking changes' },
  group: true,
  emoji: false,
  capitalize: false,
  contributors: true,
  tagFilter: (tag) => /^v\d+\.\d+\.\d+$/.test(tag),
});
