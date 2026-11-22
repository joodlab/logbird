import { highlight } from '@logbird/ui/lib/highlight';
import { describe, expect, it } from 'vitest';
import { curlSnippet, dotnetSnippet } from './snippets';

describe('the C# (.NET) first-event snippet', () => {
  it('posts the same event as curl with plain HttpClient, using the session key', () => {
    const code = dotnetSnippet('lb_ingest_example');
    expect(code).toContain('new("Bearer", "lb_ingest_example")');
    expect(code).toContain('/v1/events');
    for (const field of ['action = "hotel.policy.updated"', 'tenant = new { id = "biz_7"', 'field = "cancellationHours", before = 24, after = 48'])
      expect(code).toContain(field);
    // The same event as the curl tab.
    expect(curlSnippet('k')).toContain('"cancellationHours", "before": 24, "after": 48');
  });
  it('reads the key from the environment when the session has none', () => {
    expect(dotnetSnippet()).toContain('Environment.GetEnvironmentVariable("LOGBIRD_INGEST_KEY")');
  });
  it('names no package until the .NET package is published', () => {
    const code = dotnetSnippet('k');
    expect(code).not.toMatch(/dotnet add|PackageReference|using Logbird/);
  });
  it('is highlighted as C#', () => {
    const tokens = highlight('var response = await http.PostAsJsonAsync("x", new { action = "a" });', 'csharp');
    expect(tokens.filter((t) => t.type === 'keyword').map((t) => t.text)).toEqual(['var', 'await', 'new']);
    // No context-free way to tell `action = …` (a member) from `response = …` (a variable): neither is coloured as a key.
    expect(tokens.some((t) => t.type === 'key')).toBe(false);
    expect(tokens.filter((t) => t.type === 'string').map((t) => t.text)).toEqual(['"x"', '"a"']);
  });
});
