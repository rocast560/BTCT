import { describe, expect, it } from 'vitest';
import { tokenizeChatCode } from '@/lib/chat-highlighting';

describe('shared chat highlighting', () => {
  it.each([
    ['javascript', 'const value = "<script>";\nconsole.log(value);'],
    ['bash', 'echo "hello"\nnmap -sV 127.0.0.1'],
    ['powershell', 'Get-Process | Select-Object Name'],
    ['python', 'def scan(host):\n    return host'],
  ])('preserves every character while highlighting %s', async (lang, source) => {
    const tokens = await tokenizeChatCode(source, lang);
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    expect(tokens.some((t) => t.className)).toBe(true);
  });
  it('keeps unknown languages and large outputs as plain text', async () => {
    expect(await tokenizeChatCode('<script>alert(1)</script>', 'unknown-language')).toEqual([{ text: '<script>alert(1)</script>' }]);
    const large = 'const value = 1;\n'.repeat(4000);
    expect(await tokenizeChatCode(large, 'javascript')).toEqual([{ text: large }]);
  });
});
