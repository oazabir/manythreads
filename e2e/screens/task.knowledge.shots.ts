import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Knowledge (P8-07, P8-08, P8-32, P8-33) on the live site. Omar (lead of Engineering) adds a throwaway bot `verify-knowledge` whose BOT.md lists one
 * knowledge base, makes the base from the bot page, uploads a Markdown runbook, a CSV and a file that cannot be read, asks a question, uploads a changed
 * runbook (version 2) and reads the base again. Priya (a plain member of Engineering) sees the same page with nothing to change. Then the phone.
 * Everything written is a throwaway: the base (documents, passages, converted copies and the stored originals) and the bot's BOT.md are removed again;
 * applied proposals and the commits of the converted copies stay on record. Output: <MANYTHREADS_TASK_SHOTS_DIR>/knowledge-*.png.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify knowledge]';
const TEAM = 'engineering';
const SLUG = 'verify-knowledge';
const KB = 'verify-knowledge';
const BOT_PATH = `bots/${SLUG}/BOT.md`;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const botMd = (): string =>
  [
    '---',
    'schema: 1',
    `name: "${TAG} reader"`,
    'role: A throwaway bot that a verification run adds and removes again.',
    'kind: agent',
    'runtime: hermes',
    'visibility: team',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    '  native: [knowledge.search, answer.post]',
    'knowledge:',
    `  - base: ${KB}`,
    '    answer_only_from: true',
    'model:',
    '  aliases: [smart]',
    '---',
    '',
    `# ${TAG} reader`,
    '',
    'You do nothing. This bot exists for one verification run and is removed in the same run.',
    '',
  ].join('\n');

const RUNBOOK_V1 = `# Release runbook\n\nThe canary is held for 30 minutes before the full release.\n\n## Rollback\n\nRoll back with the release tool and tell the team channel.\n`;
const RUNBOOK_V2 = RUNBOOK_V1.replace('30 minutes', '45 minutes');
const PRICES = 'plan,price,seats\nStarter,9 dollars,3\nBusiness,49 dollars,25\n';

type Res = { status: number; text: string; json: unknown };
type Api = { get: (path: string) => Promise<Res>; post: (path: string, data?: unknown) => Promise<Res>; del: (path: string) => Promise<Res> };

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
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

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `knowledge-${name}.png`), animations: 'disabled' });
}

async function waitBot(api: Api, present: boolean): Promise<string | null> {
  let s: string | null = null;
  for (let i = 0; i < 40; i++) {
    const bots = ((await api.get(`/api/teams/${TEAM}/bots`)).json as { bots?: { slug: string; status: string }[] } | null)?.bots ?? [];
    s = bots.find((b) => b.slug === SLUG)?.status ?? null;
    if (present ? s === 'active' : s === null) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
}

async function removeScratch(api: Api): Promise<string> {
  const notes: string[] = [];
  const gone = await api.del(`/api/teams/${TEAM}/knowledge/${KB}`);
  notes.push(`base -> ${gone.status}`);
  if ((await api.get(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(BOT_PATH)}`)).status === 200) {
    const r = await api.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, op: 'delete', title: `${TAG} remove the scratch bot`, applyNow: true });
    notes.push(`${BOT_PATH} -> ${r.status}`);
  }
  return notes.join('; ');
}

const upload = async (page: Page, name: string, mimeType: string, content: string): Promise<void> => {
  await page.getByTestId('knowledge-file').setInputFiles({ name, mimeType, buffer: Buffer.from(content) });
  await expect(page.getByTestId('knowledge-notice')).toBeVisible(T);
};

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(300_000);

test('Omar and Priya: make a base, upload, ask, change a file, member read-only, phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  console.log('removed before:', await removeScratch(omarApi));
  try {
    const added = await omarApi.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, op: 'put', content: botMd(), baseBlobSha: null, title: `${TAG} add the scratch bot`, applyNow: true });
    console.log('scratch bot proposal:', added.status, added.text.slice(0, 160));
    expect(added.status).toBeLessThan(300);
    console.log('scratch bot on the roster:', await waitBot(omarApi, true));

    // ---- the base is named but not made yet
    await omar.goto(`/t/${TEAM}/bots/${SLUG}?tab=knowledge`);
    await expect(omar.getByTestId('knowledge-missing')).toContainText('does not exist yet', T);
    await shot(omar, '01-base-named-not-made');
    await omar.getByRole('button', { name: 'Create it' }).click();
    await expect(omar.getByTestId('knowledge-empty')).toBeVisible(T);
    await shot(omar, '02-empty-base');

    // ---- uploads
    await upload(omar, 'Release runbook.md', 'text/markdown', RUNBOOK_V1);
    await upload(omar, 'Plans.csv', 'text/csv', PRICES);
    await upload(omar, 'Scan.pdf', 'application/pdf', '%PDF-1.4 this is not a pdf');
    await expect(omar.getByTestId('knowledge-doc')).toHaveCount(3, T);
    await expect(omar.getByTestId('knowledge-state')).toContainText('Needs attention', T);
    await shot(omar, '03-three-documents-one-unreadable');

    // ---- a question, with the passage and where it came from
    await omar.getByTestId('knowledge-question').fill('how long is the canary held?');
    await omar.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(omar.getByTestId('knowledge-hits')).toContainText('30 minutes', T);
    await shot(omar, '04-question-finds-the-passage');

    // ---- the same file changed: version 2, and only the new text is found
    await upload(omar, 'Release runbook.md', 'text/markdown', RUNBOOK_V2);
    await expect(omar.getByTestId('knowledge-notice')).toContainText('version 2', T);
    await omar.getByTestId('knowledge-question').fill('how long is the canary held?');
    await omar.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(omar.getByTestId('knowledge-hits')).toContainText('45 minutes', T);
    await shot(omar, '05-changed-file-is-version-2');
    await omar.getByTestId('knowledge-resync').click();
    await expect(omar.getByTestId('knowledge-notice')).toContainText('Read again', T);
    await shot(omar, '06-read-again');

    // ---- a plain member
    priya = await signIn(browser, 'priya');
    await priya.goto(`/t/${TEAM}/bots/${SLUG}?tab=knowledge`);
    await expect(priya.getByTestId('knowledge-base')).toBeVisible(T);
    await expect(priya.getByTestId('knowledge-upload')).toHaveCount(0);
    await shot(priya, '07-priya-member-read-only');
    const denied = await apiOf(priya).post(`/api/teams/${TEAM}/knowledge/${KB}/resync`, {});
    console.log('priya POST resync:', denied.status);
    expect(denied.status).toBe(403);

    // ---- the phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto(`/t/${TEAM}/bots/${SLUG}?tab=knowledge`);
    await expect(phone.getByTestId('knowledge-base')).toBeVisible(T);
    const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    console.log('phone no sideways scroll:', noScroll);
    await shot(phone, '08-phone-knowledge-tab');
    expect(noScroll).toBe(true);
    await phone.context().close();
    phone = null;
  } finally {
    console.log('removed after:', await removeScratch(omarApi).catch((e: unknown) => `cleanup failed: ${String(e)}`));
    console.log('scratch bot after removal:', await waitBot(omarApi, false).catch(() => 'unknown'));
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
