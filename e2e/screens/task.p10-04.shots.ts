import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P10-04 (data-loss policy, per-team hosts, Settings > Workspace > Data protection) on the live site. Omar (workspace admin) opens the page, sees the
 * built-in detectors and the team host lists, adds a throwaway pattern, tries a canary text in the test box (the canary is built from two halves so this
 * file holds no key-shaped string), checks the answer never repeats the text, and removes the pattern again. Priya (a plain member) has no
 * "Data protection" entry and every route answers 403. The phone picture checks there is no sideways scroll.
 * Everything written is a throwaway: the pattern is removed even when a step fails.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p10-04-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = 'verify-p1004';
const TEAM = 'engineering';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// halves of a key-shaped canary: joined only at run time
const CANARY = `AKIA${'IOSFODNN7EXAMPLE'}`;
const SPLIT_CANARY = `AKIA\u200B${'IOSFODNN7'}\u200D${'EXAMPLE'}`;
const CODE = `${TAG}-${'ZQ'}`; // a made-up code word for the throwaway pattern

type Res = { status: number; text: string; json: unknown };
type Api = { get: (path: string) => Promise<Res>; post: (path: string, data?: unknown) => Promise<Res>; del: (path: string) => Promise<Res> };

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`${who}@kahf.example`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password`).not.toHaveURL(/\/sign-in/);
  await page.goto(`/t/${TEAM}/threads`);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

function apiOf(page: Page): Api {
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, data?: unknown): Promise<Res> => {
    const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
    const headers = { 'x-csrf-token': csrf };
    const res = method === 'GET' ? await page.request.get(path) : method === 'DELETE' ? await page.request.delete(path, { headers }) : await page.request.post(path, { data: data ?? {}, headers });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status(), text, json };
  };
  return { get: (p) => call('GET', p), post: (p, d) => call('POST', p, d), del: (p) => call('DELETE', p) };
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p10-04-${name}.png`), animations: 'disabled', fullPage });
}

/** Removes every throwaway pattern this script made (by its name prefix); returns a line for the log. */
async function removeMine(api: Api): Promise<string> {
  const policy = (await api.get('/api/admin/guardrails/dlp')).json as { rules?: { id: string; name: string }[] } | null;
  const mine = (policy?.rules ?? []).filter((r) => r.name.startsWith(TAG));
  const notes: string[] = [];
  for (const r of mine) notes.push(`${r.name} -> ${(await api.del(`/api/admin/guardrails/dlp/rules/${r.id}`)).status}`);
  return notes.join('; ') || 'nothing to remove';
}

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(300_000);
test.use({ actionTimeout: 30_000 });

test('Omar and Priya: the Data protection page, a throwaway pattern, the test box, member refused, phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  console.log('removed before:', await removeMine(omarApi));
  try {
    // ---- (a) the page and its two halves
    await omar.goto('/settings/workspace/guardrails');
    await expect(omar.getByRole('heading', { name: 'Data protection', level: 1 })).toBeVisible(T);
    await expect(omar.getByTestId('gr-dlp')).toBeVisible(T);
    await expect(omar.getByTestId('gr-egress')).toBeVisible(T);
    await expect(omar.getByLabel('What to do with api keys and tokens')).toBeVisible(T);
    await shot(omar, '01-omar-page');
    await shot(omar, '02-omar-page-full', true);

    // ---- (b) add a throwaway pattern through the form
    await omar.getByLabel('Name', { exact: true }).fill(`${TAG}-code`);
    await omar.getByLabel('Pattern', { exact: true }).fill(`${CODE}-[0-9]{4}`);
    await omar.getByRole('button', { name: 'Add pattern' }).click();
    await expect(omar.getByText(`Added ${TAG}-code.`)).toBeVisible(T);
    await shot(omar, '03-omar-pattern-added');

    // ---- (c) the test box: a canary key (split with invisible characters) and the throwaway code. The answer says what was found, never the text.
    const box = omar.getByTestId('gr-test');
    await box.getByLabel('Text to check').fill(`deploy with ${SPLIT_CANARY} and ticket ${CODE}-1234 please`);
    await box.getByRole('button', { name: 'Check' }).click();
    const result = omar.getByTestId('gr-result');
    await expect(result).toBeVisible(T);
    const outcome = await result.getAttribute('data-outcome');
    const words = (await result.innerText()).replace(/\s+/g, ' ');
    console.log('test box outcome:', outcome, '| words:', words.slice(0, 200));
    expect(['redact', 'require_approval', 'block']).toContain(outcome);
    expect(words).toMatch(/api-key/);
    expect(words).toContain(`${TAG}-code`);
    expect(words).not.toContain(CANARY);
    expect(words).not.toContain('IOSFODNN7');
    await shot(omar, '04-omar-test-box');

    // the same through the API: the answer never holds the canary or the code
    const api = await omarApi.post('/api/admin/guardrails/dlp/test', { text: `k ${SPLIT_CANARY} t ${CODE}-1234`, preset: 'standard' });
    console.log('test endpoint status:', api.status);
    expect(api.status).toBe(200);
    expect(api.text).not.toContain('IOSFODNN7EXAMPLE');
    expect(api.text).not.toContain(`${CODE}-1234`);

    // ---- (d) remove the pattern again
    await omar.locator('li', { hasText: `${TAG}-code` }).getByRole('button', { name: 'Remove' }).click();
    await expect(omar.getByText(`Removed ${TAG}-code.`)).toBeVisible(T);
    console.log('removed after the form:', await removeMine(omarApi));

    // ---- (e) Priya: no entry, routes refused
    priya = await signIn(browser, 'priya');
    const priyaApi = apiOf(priya);
    await priya.goto('/settings/workspace/guardrails');
    const nav = (await priya.locator('body').innerText()).replace(/\s+/g, ' ');
    console.log('Priya sees a "Data protection" nav item:', /Data protection/.test(nav));
    expect(nav).not.toMatch(/Data protection/);
    await priya.waitForTimeout(1500);
    console.log('Priya on the URL says:', (await priya.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200));
    await shot(priya, '05-priya-url-refused');
    const g = await priyaApi.get('/api/admin/guardrails/dlp');
    const e = await priyaApi.get('/api/admin/guardrails/egress');
    const t = await priyaApi.post('/api/admin/guardrails/dlp/test', { text: 'hello', preset: 'standard' });
    const r = await priyaApi.post('/api/admin/guardrails/dlp/rules', { name: `${TAG}-no`, pattern: 'abc' });
    console.log('Priya GET dlp / GET egress / POST test / POST rule:', g.status, e.status, t.status, r.status);
    expect([g.status, e.status, t.status, r.status]).toEqual([403, 403, 403, 403]);

    // ---- (f) the phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto('/settings/workspace/guardrails');
    await expect(phone.getByTestId('gr-dlp')).toBeVisible(T);
    await expect(phone.getByTestId('gr-egress')).toBeVisible(T);
    const dims = await phone.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      overflowing: Array.from(document.querySelectorAll('.gr-page *')).filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length,
    }));
    console.log('phone dims:', JSON.stringify(dims));
    await shot(phone, '06-phone-top');
    await phone.getByTestId('gr-test').scrollIntoViewIfNeeded();
    await shot(phone, '07-phone-test-box');
    await phone.getByTestId('gr-egress').scrollIntoViewIfNeeded();
    await shot(phone, '08-phone-hosts');
    expect(dims.sw).toBeLessThanOrEqual(dims.iw + 1);
    expect(dims.overflowing).toBe(0);
    await phone.context().close();
    phone = null;
  } finally {
    console.log('removed after:', await removeMine(omarApi).catch((err: unknown) => `cleanup failed: ${String(err)}`));
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
