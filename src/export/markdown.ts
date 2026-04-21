import type { Page } from '@/types';

export function pageToMarkdown(page: Page): string {
  const lines: string[] = [];
  lines.push(`# ${page.icon} ${page.title}`);
  lines.push('');

  if (page.tags.length > 0) {
    lines.push(`Tags: ${page.tags.join(', ')}`);
    lines.push('');
  }

  // Convert BlockNote content to simple markdown
  for (const block of page.content) {
    const b = block as Record<string, unknown>;
    const type = b['type'] as string | undefined;
    const contentArr = b['content'] as Array<Record<string, unknown>> | undefined;

    const text = contentArr
      ?.map((c) => {
        const t = c['text'] as string | undefined;
        const styles = c['styles'] as Record<string, boolean> | undefined;
        if (!t) return '';
        let result = t;
        if (styles?.['bold']) result = `**${result}**`;
        if (styles?.['italic']) result = `*${result}*`;
        if (styles?.['code']) result = `\`${result}\``;
        return result;
      })
      .join('') ?? '';

    switch (type) {
      case 'heading': {
        const level = (b['props'] as Record<string, unknown>)?.['level'] as number | undefined;
        const prefix = '#'.repeat(level ?? 1);
        lines.push(`${prefix} ${text}`);
        break;
      }
      case 'bulletListItem':
        lines.push(`- ${text}`);
        break;
      case 'numberedListItem':
        lines.push(`1. ${text}`);
        break;
      case 'checkListItem': {
        const checked = (b['props'] as Record<string, unknown>)?.['checked'] as boolean | undefined;
        lines.push(`- [${checked ? 'x' : ' '}] ${text}`);
        break;
      }
      case 'codeBlock':
        lines.push('```');
        lines.push(text);
        lines.push('```');
        break;
      case 'paragraph':
      default:
        lines.push(text);
        break;
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function pagesToMarkdownBundle(pages: Page[]): string {
  return pages.map((p) => pageToMarkdown(p)).join('\n---\n\n');
}
