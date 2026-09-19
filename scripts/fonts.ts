// Puts the 17 fonts typst.ts installs by default under public/fonts, so the
// compiler never touches the CDN (the app must work offline).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FONT_FILES } from '../src/lib/typst-default-fonts';

export const FONT_FILES = DEFAULT_FONT_FILES;
const CDN = 'https://cdn.jsdelivr.net/gh/typst/typst-assets@v0.13.1/files/fonts/';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const out = path.resolve(__dirname, '..', 'public', 'fonts');
  fs.mkdirSync(out, { recursive: true });
  for (const name of FONT_FILES) {
    const target = path.join(out, name);
    if (fs.existsSync(target)) continue;
    const res = await fetch(CDN + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    fs.writeFileSync(target, new Uint8Array(await res.arrayBuffer()));
  }
  console.log(`fonts: ${FONT_FILES.length} files in ${out}`);
}
if (process.argv[1] && /fonts\.ts$/.test(process.argv[1])) void main();
