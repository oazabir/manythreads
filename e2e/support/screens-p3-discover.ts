// Screenshots of the screens that have no prototype plate (search results, notifications popover, DM, welcome card, guest shell), from
// the REAL server on a seed v3 stack, for docs/retro/screens/phase-3/:
//   pnpm --filter @manythreads/web build && pnpm -C e2e exec tsx support/screens-p3-discover.ts <out dir>
import { mkdirSync } from 'node:fs';
import { chromium, request, type BrowserContext, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { personaEmail, type PersonaKey } from './env.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: screens-p3-discover.ts <out dir>');
mkdirSync(out, { recursive: true });
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const stack: Stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
const browser = await chromium.launch();

async function openAs(key: PersonaKey, viewport: typeof DESKTOP, mobile = false): Promise<{ context: BrowserContext; page: Page }> {
  const api = await request.newContext({ baseURL: stack.origin });
  await api.post('/api/test/session', { data: { email: personaEmail(key) }, headers: { 'x-test-auth': stack.testAuthToken } });
  const storageState = await api.storageState();
  await api.dispose();
  const context = await browser.newContext({ baseURL: stack.origin, viewport, storageState, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  return { context, page: await context.newPage() };
}
const settle = async (page: Page): Promise<void> => {
  await page.locator('[data-testid="app-frame"]').waitFor();
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(700);
};

{
  // search results: Nadia looks for the rollback, with a typo
  const { context, page } = await openAs('nadia', DESKTOP);
  await page.goto('/t/engineering/c/dev');
  await page.locator('[data-testid="message"]').first().waitFor();
  const box = page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill('rolback');
  await box.press('Enter');
  await page.getByTestId('search-results').getByTestId('search-hit').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/search-results.png` });
  await context.close();
}
{
  // notifications popover: Rafi, with unread items
  const { context, page } = await openAs('rafi', DESKTOP);
  await page.goto('/t/engineering/c/dev');
  await page.locator('[data-testid="message"]').first().waitFor();
  await page.getByTestId('bell').click();
  await page.getByTestId('notification').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/notifications-popover.png` });
  await context.close();
}
{
  // direct message: Nadia and Rafi
  const { context, page } = await openAs('nadia', DESKTOP);
  await page.goto('/t/engineering/threads');
  await page.locator('[data-slot="direct-messages"] a.it').first().click();
  await page.locator('[data-testid="message"]').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/dm.png` });
  await context.close();
}
{
  // welcome card: Priya's first day
  const { context, page } = await openAs('priya', DESKTOP);
  await page.goto('/t/engineering/threads');
  await page.getByTestId('welcome-card').waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/welcome-card.png` });
  await context.close();
}
for (const [name, viewport, mobile] of [['guest-lena', DESKTOP, false], ['guest-lena-390', MOBILE, true]] as const) {
  const { context, page } = await openAs('lena', viewport, mobile);
  await page.goto('/');
  await page.getByTestId('read-only').waitFor();
  await page.locator('[data-testid="message"]').first().waitFor();
  await settle(page);
  await page.screenshot({ path: `${out}/${name}.png` });
  await context.close();
}

await browser.close();
await stack.stop();
console.log(`screenshots written to ${out}`);
