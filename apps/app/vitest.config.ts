import { configDefaults, defineConfig } from 'vitest/config';

/** The query bar's corpus test: about ten minutes, so CI runs it in its own job (.github/workflows/query-corpus.yml). */
const QUERY_CORPUS = 'src/components/query-input/query-corpus.test.tsx';

/**
 * `LOGBIRD_QUERY_CORPUS` picks the corpus explicitly: `skip` leaves it out (CI's Quality job), `only` runs just it (the
 * corpus job). Unset, everything runs, so a local `pnpm test` still includes it. Any other value is a mistake, not a skip.
 */
const corpus = process.env.LOGBIRD_QUERY_CORPUS;
if (corpus !== undefined && corpus !== 'skip' && corpus !== 'only') {
  throw new Error(`LOGBIRD_QUERY_CORPUS must be "skip", "only" or unset, not "${corpus}"`);
}

/** Unit tests only need path aliases, not the Start/Nitro plugins in vite.config.ts. */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: corpus === 'only' ? [QUERY_CORPUS] : ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
    exclude: corpus === 'skip' ? [...configDefaults.exclude, QUERY_CORPUS] : configDefaults.exclude,
  },
});
