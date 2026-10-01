import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { MOCKUPS_PATH } from '../../../tools/plates/src/index.ts';


// PLAN §5 Tokens: the 14 colour tokens, compared exactly (computed value, not pixels).
const COLOUR_TOKENS = [
  'paper', 'surface', 'shell', 'ink', 'mute', 'faint', 'rule',
  'human', 'agent', 'agent-wash', 'ok', 'warn', 'alert', 'alert-wash',
].map((n) => `--${n}`);

function protoRoot(): Record<string, string> {
  const html = readFileSync(MOCKUPS_PATH, 'utf8');
  const m = /:root\s*\{([^}]*)\}/.exec(html);
  if (!m) throw new Error('no :root block in mockups-all.html');
  const out: Record<string, string> = {};
  for (const decl of (m[1] as string).split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
  }
  return out;
}

test('/dev/tokens :root colour tokens equal the prototype', async ({ page }) => {
  const proto = protoRoot();
  await page.goto('/dev/tokens');
  const live = await page.evaluate((names) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, COLOUR_TOKENS);
  const norm = (v: string | undefined) => (v ?? '').toLowerCase().replace(/\s+/g, '');
  for (const n of COLOUR_TOKENS) {
    expect(proto[n], `prototype defines ${n}`).toBeTruthy();
    expect(norm(live[n]), n).toBe(norm(proto[n]));
  }
});
