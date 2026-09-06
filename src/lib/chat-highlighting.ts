import { languages } from '@codemirror/language-data';
import { LanguageDescription } from '@codemirror/language';
import { classHighlighter, highlightTree } from '@lezer/highlight';

export interface CodeToken { text: string; className?: string }

/** Share the note editor's lazy grammars; no separate highlighter or WASM engine. */
export async function tokenizeChatCode(code: string, language: string): Promise<CodeToken[]> {
  const plain = [{ text: code }];
  // Large command output stays readable without blocking typing on a full parse.
  if (code.length > 50_000) return plain;
  const name = ({ bash: 'shell', docker: 'dockerfile', csharp: 'c#' } as Record<string, string>)[language] ?? language;
  const description = LanguageDescription.matchLanguageName(languages, name, false);
  if (!description) return plain;
  try {
    const support = await description.load();
    const tokens: CodeToken[] = [];
    let end = 0;
    highlightTree(support.language.parser.parse(code), classHighlighter, (from, to, className) => {
      if (from > end) tokens.push({ text: code.slice(end, from) });
      tokens.push({ text: code.slice(from, to), className });
      end = to;
    });
    if (end < code.length) tokens.push({ text: code.slice(end) });
    return tokens;
  } catch { return plain; }
}
