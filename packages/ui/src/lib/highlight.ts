/**
 * A tiny, dependency-free highlighter for the handful of languages the console shows
 * (JSON payloads, shell/curl, TypeScript SDK snippets). Tokens map to theme-aware
 * `--syntax-*` colors so code reads well in light and dark.
 */
export type CodeLanguage = 'json' | 'bash' | 'ts' | 'text';
export type TokenType = 'key' | 'string' | 'number' | 'keyword' | 'comment' | 'punct' | 'plain';
export interface CodeToken {
  type: TokenType;
  text: string;
}

const TS_KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'const',
  'let',
  'await',
  'async',
  'new',
  'return',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'if',
  'else',
  'type',
  'interface',
]);

const RULES: Record<Exclude<CodeLanguage, 'text'>, [RegExp, TokenType | ((m: string) => TokenType)][]> = {
  json: [
    [/^"(?:[^"\\]|\\.)*"(?=\s*:)/, 'key'],
    [/^"(?:[^"\\]|\\.)*"/, 'string'],
    [/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
    [/^(?:true|false|null)\b/, 'keyword'],
    [/^[{}[\],:]/, 'punct'],
    [/^\s+/, 'plain'],
    [/^[^\s"{}[\],:]+/, 'plain'],
  ],
  bash: [
    [/^#[^\n]*/, 'comment'],
    [/^'(?:[^'\\]|\\.)*'/, 'string'],
    [/^"(?:[^"\\]|\\.)*"/, 'string'],
    [/^(?:curl|npm|pnpm|yarn|bun|export|echo)\b/, 'keyword'],
    [/^-{1,2}[A-Za-z][\w-]*/, 'key'],
    [/^\\\n/, 'punct'],
    [/^\s+/, 'plain'],
    [/^[^\s'"#\\]+/, 'plain'],
    [/^./, 'plain'],
  ],
  ts: [
    [/^\/\/[^\n]*/, 'comment'],
    [/^\/\*[\s\S]*?\*\//, 'comment'],
    [/^'(?:[^'\\]|\\.)*'/, 'string'],
    [/^"(?:[^"\\]|\\.)*"/, 'string'],
    [/^`(?:[^`\\]|\\.)*`/, 'string'],
    [/^\d+(?:\.\d+)?/, 'number'],
    [/^[A-Za-z_$][\w$]*(?=\s*:)/, 'key'],
    [/^[A-Za-z_$][\w$]*/, (m) => (TS_KEYWORDS.has(m) ? 'keyword' : 'plain')],
    [/^[{}()[\];,.:=<>+\-*/!?&|]/, 'punct'],
    [/^\s+/, 'plain'],
    [/^./, 'plain'],
  ],
};

export function highlight(code: string, language: CodeLanguage): CodeToken[] {
  if (language === 'text') return [{ type: 'plain', text: code }];
  const rules = RULES[language];
  const tokens: CodeToken[] = [];
  let rest = code;
  while (rest.length > 0) {
    let matched = false;
    for (const [re, type] of rules) {
      const m = re.exec(rest);
      if (m?.[0]) {
        const text = m[0];
        const t = typeof type === 'function' ? type(text) : type;
        const last = tokens.at(-1);
        if (last && last.type === t && t === 'plain') last.text += text;
        else tokens.push({ type: t, text });
        rest = rest.slice(text.length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      tokens.push({ type: 'plain', text: rest[0] ?? '' });
      rest = rest.slice(1);
    }
  }
  return tokens;
}

export const TOKEN_CLASS: Record<TokenType, string> = {
  key: 'text-syntax-key',
  string: 'text-syntax-string',
  number: 'text-syntax-number',
  keyword: 'text-syntax-keyword',
  comment: 'text-syntax-comment italic',
  punct: 'text-syntax-punct',
  plain: '',
};
