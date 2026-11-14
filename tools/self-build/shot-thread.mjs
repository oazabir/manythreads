// shot-thread.mjs — screenshot a thread of a live site as a signed-in person (run.mjs `shot` does not sign in).
//
//   MT_BASE=<site address> MT_USER=OMAR node tools/self-build/shot-thread.mjs <rootId> <out-prefix> [--channel dev] [--team engineering]
//
// Signs in with the person's entries of ~/manythreads.passwords.env (read here, never printed), opens `/t/<team>/c/<channel>?panel=thread:<rootId>`, and saves
// `<out-prefix>-panel.png` (the thread panel) and `<out-prefix>-full.png` (the whole window). The panel is scrolled from the top in steps of one window and saved as
// `<out-prefix>-panel-<n>.png` when it is taller than the window (`--steps 4`).
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const BASE = (process.env.MT_BASE ?? '').replace(/\/+$/, '');
const USER = process.env.MT_USER ?? '';
const [rootId, prefix] = process.argv.slice(2);
if (!BASE || !USER || !rootId || !prefix) {
  console.error('usage: MT_BASE=<site address> MT_USER=OMAR node tools/self-build/shot-thread.mjs <rootId> <out-prefix> [--channel dev] [--team engineering] [--steps 4]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const env = {};
for (const l of readFileSync(`${homedir()}/manythreads.passwords.env`, 'utf8').split('\n')) {
  const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { chromium } = createRequire(new URL('../../e2e/package.json', import.meta.url))('@playwright/test');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const res = await context.request.post(`${BASE}/api/auth/password/sign-in`, { data: { email: env[`${USER}_EMAIL`], password: env[`${USER}_PASSWORD`] } });
if (res.status() !== 200) {
  console.error(`sign-in failed: HTTP ${res.status()}`);
  process.exit(1);
}
await page.goto(`${BASE}/t/${flag('team', 'engineering')}/c/${flag('channel', 'dev')}?panel=thread:${rootId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
mkdirSync(dirname(prefix), { recursive: true });
await page.screenshot({ path: `${prefix}-full.png` });
const panel = page.locator('[data-testid="thread-panel"], aside.panel, .thread-panel').first();
if ((await panel.count()) > 0) await panel.screenshot({ path: `${prefix}-panel.png` });
const scroller = page.locator('[data-testid="thread-replies"], .thread-panel .replies, .thread-panel [class*="scroll"]').first();
const steps = Number(flag('steps', '0'));
for (let i = 0; i < steps && (await scroller.count()) > 0; i++) {
  await scroller.evaluate((el, n) => { el.scrollTop = n * el.clientHeight * 0.9; }, i);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${prefix}-panel-${i + 1}.png` });
}
await browser.close();
console.log(`saved ${prefix}-*.png`);
