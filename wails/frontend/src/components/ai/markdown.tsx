/**
 * Tiny, dependency-free markdown renderer for the assistant chat. Renders a
 * useful GFM subset (headings, bold/italic/strikethrough, inline code, code
 * fences, links, ordered/unordered lists, blockquotes, horizontal rules, and
 * pipe tables) directly to React elements — no dangerouslySetInnerHTML, no
 * extra bundle weight. Memoized on the source string so, while streaming, only
 * the message currently being written re-parses.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import { codeToHtml } from 'shiki';

// Map common fence aliases Claude emits to shiki's grammar names. shiki resolves
// most aliases itself; this covers the few it doesn't, and unknown langs fall
// back to plaintext highlighting.
const LANG_ALIAS: Record<string, string> = {
  '': 'text', text: 'text', txt: 'text', plaintext: 'text', plain: 'text',
  console: 'bash', shell: 'bash', sh: 'bash', zsh: 'bash', shellsession: 'bash',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  py: 'python', rb: 'ruby', js: 'javascript', ts: 'typescript', md: 'markdown',
  yml: 'yaml', 'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', golang: 'go',
  rs: 'rust', kt: 'kotlin', htm: 'html', dockerfile: 'docker', tf: 'terraform',
};

/**
 * A syntax-highlighted code block. Highlights the code with shiki (github-dark,
 * lazy-loading the grammar for the given language). Highlighting is debounced so
 * a code block that's still streaming re-highlights after it settles rather than
 * on every token; until the first highlight resolves it renders as plain text.
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const language = LANG_ALIAS[lang.toLowerCase()] ?? lang.toLowerCase() ?? 'text';
    const t = setTimeout(() => {
      const run = (l: string) => codeToHtml(code, { lang: l, theme: 'github-dark' });
      run(language)
        .catch(() => run('text')) // unknown grammar → plaintext
        .then((h) => { if (!cancelled) setHtml(h); })
        .catch(() => { if (!cancelled) setHtml(null); });
    }, 120);
    return () => { cancelled = true; clearTimeout(t); };
  }, [code, lang]);

  if (html) {
    return <div className="ai-code my-1 text-[11px] leading-snug" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre className="ai-blk my-1 overflow-x-auto rounded-lg bg-black/35 p-2 text-[11px] leading-snug">
      <code className="font-mono">{code}</code>
    </pre>
  );
}

// ── Inline: bold / italic / code / strikethrough / links ──
const INLINE = [
  { re: /`([^`]+)`/, node: (m: RegExpExecArray, k: number) => <code key={k} className="rounded bg-black/30 px-1 py-0.5 font-mono text-[0.85em]">{m[1] ?? ''}</code> },
  { re: /\*\*([^*]+)\*\*/, node: (m: RegExpExecArray, k: number) => <strong key={k}>{renderInline(m[1] ?? '')}</strong> },
  { re: /__([^_]+)__/, node: (m: RegExpExecArray, k: number) => <strong key={k}>{renderInline(m[1] ?? '')}</strong> },
  { re: /~~([^~]+)~~/, node: (m: RegExpExecArray, k: number) => <del key={k}>{renderInline(m[1] ?? '')}</del> },
  { re: /\*([^*]+)\*/, node: (m: RegExpExecArray, k: number) => <em key={k}>{renderInline(m[1] ?? '')}</em> },
  { re: /\[([^\]]+)\]\(([^)\s]+)\)/, node: (m: RegExpExecArray, k: number) => <a key={k} href={m[2] ?? '#'} target="_blank" rel="noreferrer" className="text-[hsl(var(--primary))] underline">{m[1] ?? ''}</a> },
];

function renderInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    let best: RegExpExecArray | null = null;
    let bestAt = Infinity;
    let bestPat: (typeof INLINE)[number] | null = null;
    for (const p of INLINE) {
      const m = p.re.exec(rest);
      if (m && m.index < bestAt) { best = m; bestAt = m.index; bestPat = p; }
    }
    if (!best || !bestPat) { out.push(rest); break; }
    if (bestAt > 0) out.push(rest.slice(0, bestAt));
    out.push(bestPat.node(best, key++));
    rest = rest.slice(bestAt + best[0].length);
  }
  return out;
}

// ── Block-level ──
function isTableSep(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const at = (j: number): string => lines[j] ?? '';
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = at(i);

    // Fenced code block
    const fence = line.match(/^```([\w+#.-]*)\s*$/);
    if (fence) {
      const flang = fence[1] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(at(i))) { buf.push(at(i)); i++; }
      i++; // closing fence
      blocks.push(<CodeBlock key={key++} code={buf.join('\n')} lang={flang} />);
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    // Horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={key++} className="my-2 border-white/10" />); i++; continue; }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = (h[1] ?? '#').length;
      const size = lvl <= 1 ? 'text-sm' : lvl === 2 ? 'text-[13px]' : 'text-xs';
      blocks.push(<div key={key++} className={`${size} mt-1 font-bold`}>{renderInline(h[2] ?? '')}</div>);
      i++;
      continue;
    }

    // Table (header row + separator)
    if (line.includes('|') && i + 1 < lines.length && isTableSep(at(i + 1))) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && at(i).includes('|') && !/^\s*$/.test(at(i))) { rows.push(splitRow(at(i))); i++; }
      blocks.push(
        <div key={key++} className="overflow-x-auto">
          <table className="my-1 w-full border-collapse text-[11px]">
            <thead>
              <tr>{header.map((c, ci) => <th key={ci} className="border border-white/10 px-1.5 py-0.5 text-left font-semibold">{renderInline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-white/10 px-1.5 py-0.5">{renderInline(c)}</td>)}</tr>)}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(at(i))) { buf.push(at(i).replace(/^\s*>\s?/, '')); i++; }
      blocks.push(<blockquote key={key++} className="ai-blk border-l-2 border-white/20 pl-2 text-white/70">{renderBlocks(buf.join('\n'))}</blockquote>);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(at(i))) { items.push(at(i).replace(/^\s*[-*+]\s+/, '')); i++; }
      blocks.push(
        <ul key={key++} className="my-1 list-disc space-y-0.5 pl-4">
          {items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i))) { items.push(at(i).replace(/^\s*\d+\.\s+/, '')); i++; }
      blocks.push(
        <ol key={key++} className="my-1 list-decimal space-y-0.5 pl-4">
          {items.map((it, ii) => <li key={ii}>{renderInline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    // Paragraph (accumulate consecutive plain lines)
    const para: string[] = [];
    while (i < lines.length) {
      const l = at(i);
      if (/^\s*$/.test(l) || /^```/.test(l) || /^(#{1,6})\s/.test(l) ||
        /^\s*[-*+]\s/.test(l) || /^\s*\d+\.\s/.test(l) || /^\s*>\s?/.test(l)) break;
      para.push(l);
      i++;
    }
    if (para.length) blocks.push(<p key={key++} className="my-1">{renderInline(para.join('\n'))}</p>);
  }

  return blocks;
}

function MarkdownImpl({ text }: { text: string }) {
  return <div className="ai-md break-words">{renderBlocks(text)}</div>;
}

/** Memoized so streaming re-renders only re-parse the message being written. */
export const Markdown = memo(MarkdownImpl, (a, b) => a.text === b.text);
