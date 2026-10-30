import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P7-08 (bot evals) on the live site. Omar (workspace admin) runs Brain's scenario set from the Evals tab (free mode, then once with the model),
 * adds a throwaway bot `verify-p7-08` with a two-case set through Files (propose and apply), sees the on-commit run flag it below the minimum,
 * fixes it with a second proposal and sees it pass. Priya (a plain member) sees the results and no run buttons, and the API refuses her POST.
 * Everything written is a throwaway: the bot's BOT.md and its set file are removed again by proposals; applied proposals stay on record.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p7-08-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P7-08]';
const TEAM = 'engineering';
const SLUG = 'verify-p7-08';
const BOT_PATH = `bots/${SLUG}/BOT.md`;
const SET_PATH = `bots/${SLUG}/evals/scratch.yaml`;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const botMd = (native: string[]): string =>
  [
    '---',
    'schema: 1',
    `name: "${TAG} scratch"`,
    'role: A throwaway bot that a verification run adds and removes again.',
    'kind: agent',
    'runtime: hermes',
    'visibility: team',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    `  native: [${native.join(', ')}]`,
    'model:',
    '  aliases: [smart]',
    'evals:',
    '  set: scratch',
    '  minScore: 1',
    '---',
    '',
    `# ${TAG} scratch`,
    '',
    'You do nothing. This bot exists for one verification run and is removed in the same run.',
    '',
  ].join('\n');

const SET = [
  'schema: 1',
  'set: scratch',
  'cases:',
  '  - id: posts-its-answer',
  '    question: What is the release step?',
  '    expect:',
  '      toolCalls:',
  '        required: [answer.post]',
  '    rationale: The bot has to post its answer.',
  '  - id: closes-the-task',
  '    question: Is the task done?',
  '    expect:',
  '      toolCalls:',
  '        required: [tasks.complete]',
  '    rationale: The bot has to be able to close the task it was given.',
  '  - id: mentions-the-hold',
  '    question: How long do we hold the canary?',
  '    expect:',
  '      mentions: ["30 minutes"]',
  '    rationale: Words only; the free check cannot judge it.',
  '',
].join('\n');

type Res = { status: number; text: string; json: unknown };
type Api = { get: (path: string) => Promise<Res>; post: (path: string, data?: unknown) => Promise<Res> };
type EvalsJson = {
  canRun: boolean;
  latest: { status: string; ok: boolean | null; passed: number; judged: number; total: number; trigger: string; mode: string; error?: string | null } | null;
  recent: Array<{ id: string; status: string; trigger: string; ok: boolean | null; passed: number; judged: number; error?: string | null }>;
};

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
  const call = async (method: 'GET' | 'POST', path: string, data?: unknown): Promise<Res> => {
    const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
    const res = method === 'GET' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: { 'x-csrf-token': csrf } });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status(), text, json };
  };
  return { get: (p) => call('GET', p), post: (p, d) => call('POST', p, d) };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p7-08-${name}.png`), animations: 'disabled' });
}

async function evalsOf(api: Api, bot: string): Promise<EvalsJson | null> {
  const res = await api.get(`/api/teams/${TEAM}/bots/${bot}/evals`);
  return res.status === 200 ? (res.json as EvalsJson) : null;
}

async function blobExists(api: Api, path: string): Promise<boolean> {
  return (await api.get(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(path)}`)).status === 200;
}

/** Waits until the bot has an on-commit run that is no longer running and there are `count` of them; returns the evals JSON. */
async function waitOnCommit(api: Api, count: number): Promise<EvalsJson | null> {
  let e: EvalsJson | null = null;
  for (let i = 0; i < 40; i++) {
    e = await evalsOf(api, SLUG);
    if (e && e.recent.filter((r) => r.trigger === 'on_commit').length >= count && !e.recent.some((r) => r.status === 'running')) return e;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return e;
}

async function waitIdle(api: Api, bot: string): Promise<EvalsJson | null> {
  let e: EvalsJson | null = null;
  for (let i = 0; i < 60; i++) {
    e = await evalsOf(api, bot);
    if (e && !e.recent.some((r) => r.status === 'running')) return e;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return e;
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

/** Files > bots > Propose a file > Propose and apply. */
async function proposeNew(page: Page, path: string, text: string, title: string): Promise<void> {
  await page.goto(`/t/${TEAM}/files?path=bots`);
  await page.getByTestId('propose-new-file').click();
  const dlg = page.getByTestId('dialog-propose');
  await dlg.getByTestId('propose-path').fill(path);
  await dlg.getByTestId('propose-text').fill(text);
  await dlg.getByTestId('propose-title').fill(title);
  await expect(dlg.getByTestId('propose-preview')).toContainText('added', T);
  await dlg.getByTestId('propose-apply').click();
  await expect(page.getByTestId('propose-done-text')).toContainText('proposal', T);
  await page.getByRole('button', { name: 'Done' }).click();
}

/** Files > open the file > Change by proposal > Propose and apply. */
async function proposeChange(page: Page, path: string, text: string, title: string, name: string): Promise<void> {
  await page.goto(`/t/${TEAM}/files?open=${encodeURIComponent(path)}`);
  const view = page.getByTestId('file-view');
  await expect(view.getByTestId('read-only-note')).toContainText('Change by proposal', T);
  await view.getByTestId('change-by-pr').click();
  const dlg = page.getByTestId('dialog-propose');
  await expect(dlg.getByTestId('propose-text')).not.toHaveValue('');
  await dlg.getByTestId('propose-text').fill(text);
  await dlg.getByTestId('propose-title').fill(title);
  await expect(dlg.getByTestId('propose-preview')).toBeVisible(T);
  await shot(page, name);
  await dlg.getByTestId('propose-apply').click();
  await expect(page.getByTestId('propose-done-text')).toContainText('proposal', T);
  await page.getByRole('button', { name: 'Done' }).click();
}

async function removeScratch(api: Api): Promise<string> {
  const notes: string[] = [];
  for (const path of [BOT_PATH, SET_PATH]) {
    if (await blobExists(api, path)) {
      const r = await api.post(`/api/teams/${TEAM}/proposals`, { path, op: 'delete', title: `${TAG} remove ${path}`, applyNow: true });
      notes.push(`${path} -> ${r.status}`);
    }
  }
  const open = ((await api.get(`/api/teams/${TEAM}/proposals?status=open&limit=200`)).json as { proposals?: { id: string; title: string }[] } | null)?.proposals ?? [];
  for (const p of open.filter((x) => x.title.startsWith(TAG))) {
    let r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/withdraw`);
    if (r.status >= 400) r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/reject`, { note: 'verification run cleanup' });
    notes.push(`proposal ${p.id.slice(0, 8)} -> ${r.status}`);
  }
  return notes.join('; ') || 'nothing to remove';
}

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(480_000);

test('Omar and Priya: run the evals, flag a worse definition, fix it, member read-only, phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  console.log('removed before:', await removeScratch(omarApi));
  try {
    // ---- (a) the Evals tab as a lead: Engineering's Brain (the live copy has no eval block), then Delivery's Brain (a block, no set file)
    const brainFile = await omarApi.get(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent('bots/brain/BOT.md')}`);
    console.log('engineering brain BOT.md has an evals block:', /^evals:/m.test((brainFile.json as { content?: string } | null)?.content ?? ''));
    await omar.goto(`/t/${TEAM}/bots/brain?tab=evals`);
    await omar.getByTestId('bot-page').waitFor(T);
    await expect(omar.getByText('No scenario set')).toBeVisible(T);
    await shot(omar, '01-engineering-brain-evals-tab-no-set');
    const dSet = await omarApi.get(`/api/teams/delivery/repo/blob?path=${encodeURIComponent('bots/brain/evals/brain.yaml')}`);
    console.log('delivery brain set file in repo:', dSet.status);
    await omar.goto(`/t/delivery/bots/brain?tab=evals`);
    await expect(omar.getByTestId('eval-panel')).toBeVisible(T);
    console.log('delivery brain minimum shown:', await omar.getByTestId('eval-minscore').inputValue(), '| text:', (await omar.getByTestId('eval-panel').innerText()).replace(/\s+/g, ' ').slice(0, 200));
    await shot(omar, '02-delivery-brain-evals-before-any-run');
    await omar.getByTestId('eval-run').click();
    await expect(omar.getByTestId('eval-summary')).toBeVisible({ timeout: 60_000 });
    await omar.waitForTimeout(3000);
    console.log('delivery brain free run says:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' '));
    await shot(omar, '03-delivery-brain-free-run-result');

    // ---- (b) a throwaway bot whose BOT.md grants one tool less than its set requires
    await proposeNew(omar, SET_PATH, SET, `${TAG} add the scratch scenarios`);
    await proposeNew(omar, BOT_PATH, botMd(['answer.post']), `${TAG} add the scratch bot`);
    console.log('scratch bot after add:', await waitBot(omarApi, true));
    const worse = await waitOnCommit(omarApi, 1);
    console.log('on-commit runs after add:', JSON.stringify(worse?.recent));
    await omar.goto(`/t/${TEAM}/bots/${SLUG}?tab=evals`);
    await expect(omar.getByTestId('eval-panel')).toBeVisible(T);
    await expect(omar.getByTestId('eval-summary')).toBeVisible(T);
    console.log('scratch tab right after the add says:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' '));
    await omar.locator('.b-ev-history summary').click().catch(() => undefined);
    await shot(omar, '03-scratch-tab-right-after-add');
    if ((await omar.getByTestId('eval-score').count()) === 0) {
      console.log('BUG CHECK: the newest run is not the real verdict; running by hand to see the flag');
      await omar.getByTestId('eval-run').click();
      await omar.waitForTimeout(4000);
    }
    await expect(omar.getByTestId('eval-score')).toContainText('Eval 1 of 2 passed', { timeout: 30_000 });
    await expect(omar.getByTestId('eval-flag')).toContainText('Below the minimum', T);
    await omar.getByTestId('eval-view-failures').click();
    await expect(omar.getByTestId('eval-case')).toContainText('tasks.complete', T);
    console.log('scratch flagged:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' '));
    await shot(omar, '04-scratch-flagged-below-minimum');

    await proposeChange(omar, BOT_PATH, botMd(['answer.post', 'tasks.complete']), `${TAG} grant tasks.complete`, '05-fix-proposal-dialog');
    const fixed = await waitOnCommit(omarApi, 2);
    console.log('on-commit runs after fix:', JSON.stringify(fixed?.recent));
    await omar.goto(`/t/${TEAM}/bots/${SLUG}?tab=evals`);
    await expect(omar.getByTestId('eval-score')).toContainText('Eval 2 of 2 passed', { timeout: 30_000 });
    await expect(omar.getByTestId('eval-flag')).toHaveCount(0);
    await omar.locator('.b-ev-history summary').click();
    console.log('scratch fixed:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' '));
    await shot(omar, '06-scratch-fixed-passes-with-history');

    // by hand, free: the banner and the cases that are not checked
    await omar.getByTestId('eval-run').click();
    await expect(omar.getByTestId('eval-score')).toContainText('Eval 2 of 2 passed', { timeout: 60_000 });
    await omar.waitForTimeout(1500);
    await omar.getByTestId('eval-view-failures').click();
    await expect(omar.getByTestId('eval-unchecked')).toContainText('mentions-the-hold', T);
    console.log('scratch free run:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' '), '|', (await omar.getByTestId('eval-unchecked').innerText()).slice(0, 300));
    await shot(omar, '07-scratch-free-run-banner-and-not-checked');

    // ---- (c) Run with the model, once on the scratch bot (alias smart) and once on a real bot (Delivery's Brain)
    await omar.getByTestId('eval-run-model').click();
    await new Promise((r) => setTimeout(r, 3000));
    const aliasRun = await waitIdle(omarApi, SLUG);
    console.log('scratch model run, newest:', JSON.stringify(aliasRun?.recent[0]));
    await omar.goto(`/t/${TEAM}/bots/${SLUG}?tab=evals`);
    await expect(omar.getByTestId('eval-summary')).toBeVisible(T);
    console.log('scratch model run banner:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' ').slice(0, 400));
    await omar.getByTestId('eval-view-failures').click();
    console.log('scratch model run cases:', (await omar.getByTestId('eval-cases').innerText()).replace(/\s+/g, ' ').slice(0, 900));
    await shot(omar, '08-scratch-run-with-the-model');
    // the earlier pass already asked the model once for Delivery's Brain; this pass only reads what that run ended with (no second spend)
    const realRun = await (async () => {
      for (let i = 0; i < 100; i++) {
        const j = (await omarApi.get(`/api/teams/delivery/bots/brain/evals`)).json as EvalsJson | null;
        if (j && !j.recent.some((r) => r.status === 'running')) return j;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return null;
    })();
    console.log('delivery brain newest runs:', JSON.stringify(realRun?.recent.slice(0, 3).map((r) => ({ ...r, results: undefined }))));
    await omar.goto(`/t/delivery/bots/brain?tab=evals`);
    await expect(omar.getByTestId('eval-summary')).toBeVisible(T);
    console.log('delivery brain model banner:', (await omar.getByTestId('eval-summary').innerText()).replace(/\s+/g, ' ').slice(0, 400));
    await shot(omar, '09-delivery-brain-run-with-the-model');

    // ---- (d) Priya: results and no buttons; the API refuses her
    priya = await signIn(browser, 'priya');
    const priyaApi = apiOf(priya);
    await priya.goto(`/t/${TEAM}/bots/${SLUG}?tab=evals`);
    await expect(priya.getByTestId('eval-panel')).toBeVisible(T);
    await expect(priya.getByTestId('eval-score')).toBeVisible(T);
    await expect(priya.getByTestId('eval-run')).toHaveCount(0);
    await expect(priya.getByTestId('eval-run-model')).toHaveCount(0);
    await shot(priya, '10-priya-evals-no-run-buttons');
    const denied = await priyaApi.post(`/api/teams/${TEAM}/bots/brain/evals/run`, {});
    console.log('priya POST brain evals/run:', denied.status, denied.text.slice(0, 200));
    expect(denied.status).toBe(403);
    const deniedScratch = await priyaApi.post(`/api/teams/${TEAM}/bots/${SLUG}/evals/run`, {});
    console.log('priya POST scratch evals/run:', deniedScratch.status, deniedScratch.text.slice(0, 200));
    expect(deniedScratch.status).toBe(403);

    // ---- (e) the phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto(`/t/${TEAM}/bots/${SLUG}?tab=evals`);
    await expect(phone.getByTestId('eval-summary')).toBeVisible(T);
    if ((await phone.getByTestId('eval-view-failures').count()) > 0) await phone.getByTestId('eval-view-failures').click();
    const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    console.log('phone no sideways scroll:', noScroll);
    await shot(phone, '11-phone-evals-tab');
    expect(noScroll).toBe(true);
    await phone.context().close();
    phone = null;
  } finally {
    console.log('removed after:', await removeScratch(omarApi).catch((e: unknown) => `cleanup failed: ${String(e)}`));
    console.log('scratch bot after removal:', await waitBot(omarApi, false).catch(() => 'unknown'));
    console.log('scratch files left:', await blobExists(omarApi, BOT_PATH).catch(() => null), await blobExists(omarApi, SET_PATH).catch(() => null));
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
