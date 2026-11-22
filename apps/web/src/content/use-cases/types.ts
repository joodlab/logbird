import type { CodeLanguage } from '@logbird/ui/lib/highlight';
import type { Limit } from '../home';
import type { Cta, Item, Marked } from '../site';

/**
 * The shape every use-case page module fills (content/use-cases/*.ts), rendered by components/marketing/use-case.tsx.
 * A page is a hero and an ordered list of sections; each section uses only the parts it needs. Every claim has its
 * source in the page's brief (marketing/copy/use-cases/*.md).
 */
export interface UseCaseStep {
  title: string;
  body: Marked;
  code?: { title: string; code: string; language: CodeLanguage };
}

export interface UseCaseSection {
  id: string;
  eyebrow: string;
  title: string;
  lead?: Marked;
  /** Titled points, each a title and the sentence that proves it. */
  points?: Item[];
  /** Numbered steps, optionally with a code sample each. */
  steps?: UseCaseStep[];
  /** A visible limit, as its own line beside the points or steps. */
  limit?: { label: string; text: Marked };
  /** A promise/limit table (components/marketing/guarantees.tsx). */
  /** A promise/limit table, or (`questions`) a question/answer table without check and dash icons. */
  limits?: { headers: { promise: string; limit: string }; rows: Limit[]; questions?: boolean };
  /** A real console capture from lib/media-manifest.ts, cropped to what the section proves. */
  visual?: { id: string; label: string; caption: string };
  cta?: Cta;
}

export interface UseCase {
  meta: { title: string; description: string };
  hero: { eyebrow: string; title: string; lead: Marked };
  sections: UseCaseSection[];
}
