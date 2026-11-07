/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live verification of Bundle A (P20 spaces, Personal files, Chat, personal memory / knowledge / inbox, bot consents, routines in words,
 * action items, the workspace Brain) on the deployed site.
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts verify-bundle-a
 * Personas sign in through the sign-in form (EMAIL / PASSWORD variables of the environment, never printed). Everything the probe makes (a test file,
 * a test routine, test chats) is removed again in the last test. Screens at 1440 and 390, light and dark, under MANYTHREADS_SHOTS_DIR.
 */
const BASE = (process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/verify-a';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

type Who = 'OMAR' | 'NADIA' | 'SAMEERA' | 'LENA';
type Vp = 'd' | 'm';
type Scheme = 'light' | 'dark';
const VIEW = { d: { width: 1440, height: 900 }, m: { width: 390, height: 844 } } as const;
const states = new Map<Who, any>();
const findings: string[] = [];
const note = (s: string): void => {
  findings.push(s);
  log(`NOTE ${s}`);
};
const fivexx: string[] = [];

async function signIn(browser: Browser, who: Who): Promise<any> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: VIEW.d, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `sign in ${who}`).not.toHaveURL(/\/sign-in/, T);
  const st = await ctx.storageState();
  await ctx.close();
  return st;
}

async function open(browser: Browser, who: Who, vp: Vp = 'd', scheme: Scheme = 'light'): Promise<{ ctx: BrowserContext; page: Page }> {
  if (!states.has(who)) states.set(who, await signIn(browser, who));
  const ctx = await browser.newContext({
    baseURL: BASE,
    storageState: states.get(who),
    viewport: VIEW[vp],
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    isMobile: vp === 'm',
    hasTouch: vp === 'm',
  });
  const page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => note(`PAGEERROR ${e.message.slice(0, 200)}`));
  return { ctx, page };
}

const csrf = async (ctx: BrowserContext): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const settle = async (page: Page): Promise<void> => {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(700);
};
/** Screenshot, then flag horizontal scroll and the forbidden old product name in the visible text. */
async function shoot(page: Page, name: string, vp: Vp, scheme: Scheme): Promise<void> {
  await settle(page);
  const file = `${name}.${vp === 'd' ? '1440' : '390'}.${scheme}.png`;
  await page.screenshot({ path: join(OUT, file) });
  const info = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, text: document.body.innerText }));
  if (info.sw > info.cw + 1) note(`${file}: sideways scroll ${info.sw} > ${info.cw}`);
  if (/[مجلس]{3,}|مجلس/.test(info.text)) note(`${file}: the old product name appears`);
  log(`shot ${file}`);
}
/** Every screen, in the four combinations. `act` runs before each shot (navigate). */
async function sweep(browser: Browser, who: Who, name: string, path: string, act?: (page: Page, vp: Vp) => Promise<void>, combos: Array<[Vp, Scheme]> = [['d', 'light'], ['d', 'dark'], ['m', 'light'], ['m', 'dark']]): Promise<void> {
  for (const [vp, scheme] of combos) {
    const { ctx, page } = await open(browser, who, vp, scheme);
    try {
      await page.goto(path);
      await settle(page);
      if (act) await act(page, vp);
      await shoot(page, name, vp, scheme);
    } finally {
      await ctx.close();
    }
  }
}

test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length} ${fivexx.slice(0, 10).join(' | ')}`);
  writeFileSync(join(OUT, 'findings.txt'), findings.join('\n') + '\n');
});

test('01 Nadia: /files shows Personal and Teams; Notes folder', async ({ browser }) => {
  await sweep(browser, 'NADIA', '01-files', '/files');
  await sweep(browser, 'NADIA', '02-files-notes', '/files?path=Notes', undefined, [['d', 'light'], ['m', 'light']]);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/files');
    await settle(page);
    log(`files body: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 600)}`);
    log(`roots: ${await page.getByTestId('tree-root').allTextContents()} teams: ${await page.getByTestId('tree-teams').allTextContents()}`);
  } finally {
    await ctx.close();
  }
});

const NOTE = `verify-a-${sfx}.md`;
const rowAt = (page: Page, path: string) => page.locator(`[data-testid="file-row"][data-path="${path}"]`);
let noteMade = false;
const meNode = (page: Page, path: string) => page.locator(`[data-testid="tree-node"][data-space="~me"][data-path="${path}"]`);

test('02 Nadia: upload to Notes, edit twice, versions, restore, delete', async ({ browser }) => {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('upload')).toBeEnabled(T);
    await page.getByTestId('upload-input').setInputFiles({ name: NOTE, mimeType: 'text/markdown', buffer: Buffer.from('# Verify A\n\nVersion one.\n') });
    noteMade = true;
    await expect(rowAt(page, `Notes/${NOTE}`)).toBeVisible(T);
    await shoot(page, '03-files-notes-uploaded', 'd', 'light');
    await meNode(page, `Notes/${NOTE}`).click();
    await expect(page.getByTestId('file-view')).toBeVisible(T);
    await shoot(page, '04-note-open', 'd', 'light');
    const edit = async (sentence: string): Promise<void> => {
      const md = page.getByTestId('file-view').getByTestId('viewer-markdown');
      if ((await md.getAttribute('data-mode')) !== 'raw') await md.getByRole('button', { name: 'Raw', exact: true }).click();
      const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
      await raw.fill(`${(await raw.inputValue()).trimEnd()}\n\n${sentence}\n`);
      await md.getByRole('button', { name: 'Save' }).click();
      await expect(md.getByRole('status')).toContainText('Saved', T);
    };
    await edit('Edit one.');
    await edit('Edit two.');
    await shoot(page, '05-note-edited', 'd', 'light');
    await page.getByTestId('file-view').getByTestId('open-history').click();
    const history = page.getByTestId('history');
    await expect(history).toBeVisible(T);
    const rows = history.getByTestId('commit-row');
    await expect(rows).toHaveCount(3, T);
    await shoot(page, '06-note-history', 'd', 'light');
    await shoot(page, '06-note-history', 'd', 'dark');
    await rows.last().getByRole('button').first().click();
    await history.getByTestId('restore-version').click();
    const dialog = page.getByTestId('dialog-restore');
    await expect(dialog).toBeVisible();
    await shoot(page, '07-note-restore-dialog', 'd', 'light');
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(history.getByRole('status')).toContainText('Restored', T);
    await expect(rows).toHaveCount(4, T);
    await shoot(page, '08-note-restored', 'd', 'light');
    // the open editor is not refreshed by a restore (the existing spec reloads); record what it shows, then reload and check the restored text
    const stale = await page.getByTestId('file-view').getByTestId('viewer-markdown').innerText();
    if (/Edit two/.test(stale)) note('Files: after Restore the open note keeps showing the replaced text until a reload (the editor is not refreshed; a Save would overwrite the restore)');
    await page.reload();
    await settle(page);
    const viewer = page.getByTestId('file-view').getByTestId('viewer-markdown');
    await expect(viewer).toContainText('Version one', T);
    await expect(viewer).not.toContainText('Edit two');
    await shoot(page, '08b-note-restored-reloaded', 'd', 'light');
  } finally {
    await ctx.close();
  }
  // the phone sees the same list
  const m = await open(browser, 'NADIA', 'm');
  try {
    await m.page.goto('/files?path=Notes');
    await expect(rowAt(m.page, `Notes/${NOTE}`)).toBeVisible(T);
    await shoot(m.page, '09-files-notes', 'm', 'light');
    await rowAt(m.page, `Notes/${NOTE}`).click();
    await settle(m.page);
    await shoot(m.page, '10-note-open', 'm', 'light');
  } finally {
    await m.ctx.close();
  }
});

/** The probe added action items; the list is one file in Nadia's "Action items" folder, which was empty before. It is deleted with Delete in the row menu. */
async function removeActionFiles(browser: Browser): Promise<void> {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/files?path=Action%20items');
    await settle(page);
    for (let i = 0; i < 6; i += 1) {
      const row = page.locator('[data-testid="file-row"][data-kind="file"]').first();
      if ((await row.count()) === 0) break;
      log(`action items file: ${await row.getAttribute('data-path')}`);
      await row.hover();
      await row.getByTestId('row-menu').click();
      await page.getByTestId('row-action-delete').click();
      await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForTimeout(1200);
    }
    await shoot(page, '12-action-items-folder-after', 'd', 'light');
  } finally {
    await ctx.close();
  }
}

/** Removes the probe's note (Delete in the row menu); safe to call when it is not there. */
async function removeNote(browser: Browser): Promise<boolean> {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/files?path=Notes');
    await settle(page);
    // every note this probe made (its name starts with verify-a-), also left by an earlier failed run
    for (let i = 0; i < 6; i += 1) {
      const row = page.locator('[data-testid="file-row"][data-path^="Notes/verify-a-"]').first();
      if ((await row.count()) === 0) break;
      await row.hover();
      await row.getByTestId('row-menu').click();
      await page.getByTestId('row-action-delete').click();
      if (i === 0) await shoot(page, '11-note-delete-dialog', 'd', 'light');
      await page.getByTestId('dialog-delete').getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForTimeout(1200);
    }
    await expect(page.locator('[data-testid="file-row"][data-path^="Notes/verify-a-"]')).toHaveCount(0, T);
    return true;
  } finally {
    await ctx.close();
  }
}

test('03 Nadia: Chat empty state, personal memory, knowledge, inbox, consents, Brain', async ({ browser }) => {
  await sweep(browser, 'NADIA', '20-chat-empty', '/t/engineering/chat?bot=brain');
  await sweep(browser, 'NADIA', '21-memory', '/memory');
  await sweep(browser, 'NADIA', '22-knowledge', '/knowledge');
  await sweep(browser, 'NADIA', '23-inbox-folder', '/files?path=Inbox', undefined, [['d', 'light'], ['m', 'light']]);
  await sweep(browser, 'NADIA', '24-account', '/account');
  await sweep(browser, 'NADIA', '25-account-bots', '/account/bots');
  await sweep(browser, 'NADIA', '26-account-routines', '/account/routines');
  await sweep(browser, 'NADIA', '27-account-action-items', '/account/action-items');
  await sweep(browser, 'NADIA', '28-team-memory', '/t/engineering/memory', undefined, [['d', 'light']]);
});

test('04 Nadia inbox tab; Omar Brain settings, Members, admin space open (view only)', async ({ browser }) => {
  await sweep(browser, 'NADIA', '23-memory-inbox-tab', '/memory', async (page) => {
    await page.getByRole('tab', { name: 'Inbox' }).click().catch(async () => page.getByText('Inbox', { exact: true }).first().click());
  });
  await sweep(browser, 'OMAR', '30-settings-brain', '/settings/workspace/brain');
  await sweep(browser, 'OMAR', '31-members', '/settings/workspace/members', undefined, [['d', 'light']]);
});

const chatRoots: string[] = [];
const bubbles = (page: Page, role: 'person' | 'bot') => page.locator(`[data-testid="chat-message"][data-role="${role}"]`);
const chatBox = (page: Page) => page.getByTestId('chat-main').getByRole('textbox', { name: 'Message Brain' });

test('05 Nadia: Chat - stream, Stop, answer, regenerate, model switch, shortcuts, phone', async ({ browser }) => {
  test.setTimeout(600_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/t/engineering/chat?bot=brain');
    await expect(page.getByTestId('chat-screen')).toBeVisible(T);
    // composer shortcuts in the empty box
    const box = chatBox(page);
    await box.click();
    await box.fill('shortcut test');
    await box.press('Control+a');
    await box.press('Control+b');
    const afterB = await box.inputValue();
    log(`after Ctrl+B: ${JSON.stringify(afterB)}`);
    if (!/\*\*shortcut test\*\*/.test(afterB)) note(`Chat composer: Ctrl+B did not wrap the selection in bold (got ${JSON.stringify(afterB)})`);
    await box.press('Control+b');
    await box.press('Control+a');
    await box.press('Control+i');
    log(`after Ctrl+I: ${JSON.stringify(await box.inputValue())}`);
    await box.fill('');
    await box.pressSequentially(':smi');
    await page.waitForTimeout(600);
    await shoot(page, '40-chat-composer-emoji', 'd', 'light');
    await box.press('Escape');
    await box.fill('');
    await box.pressSequentially('@');
    await page.waitForTimeout(600);
    await shoot(page, '41-chat-composer-mention', 'd', 'light');
    await box.press('Escape');
    await box.fill('');
    await box.hover();
    for (const label of ['Bold', 'Italic']) {
      const b = page.getByTestId('chat-main').getByRole('button', { name: new RegExp(`^${label}`) }).first();
      log(`toolbar ${label}: title=${await b.getAttribute('title').catch(() => 'n/a')}`);
    }
    // the shortcut sheet
    await page.getByText('Shortcuts', { exact: true }).first().click();
    await expect(page.getByTestId('chat-shortcuts-dialog')).toBeVisible(T);
    await shoot(page, '42-chat-shortcuts', 'd', 'light');
    await page.keyboard.press('Escape');

    // a long answer, so there is time to Stop it
    await box.click();
    await box.fill('Verification run, please ignore: write a long, detailed essay of at least 700 words on the history of tea, in eight paragraphs. Do not use any tools.');
    await box.press('Enter');
    await expect(page).toHaveURL(/[?&]c=[0-9a-f-]{36}/, T);
    chatRoots.push(new URL(page.url()).searchParams.get('c') ?? '');
    await expect(bubbles(page, 'person').first()).toContainText('history of tea', T);
    await shoot(page, '43-chat-sent', 'd', 'light');
    const stop = page.getByTestId('chat-stop');
    let streamed = true;
    await expect(page.getByTestId('chat-streaming').or(stop)).toBeVisible({ timeout: 90_000 }).catch(() => {
      streamed = false;
    });
    if (!streamed) note('Chat: no streaming block or Stop button appeared within 90 s of a long question');
    await page.waitForTimeout(4000);
    await shoot(page, '44-chat-streaming', 'd', 'light');
    await shoot(page, '44-chat-streaming', 'd', 'dark');
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      await expect(page.getByTestId('chat-stopped')).toBeVisible({ timeout: 40_000 }).catch(() => note('Chat: after Stop, "You stopped this answer." did not appear within 40 s'));
      await shoot(page, '45-chat-stopped', 'd', 'light');
    } else {
      note('Chat: Stop was not visible while the answer was still being written (answer finished first or run never started)');
      await expect(page.getByTestId('chat-reply-actions')).toBeVisible({ timeout: 120_000 }).catch(() => undefined);
      await shoot(page, '45-chat-answered-early', 'd', 'light');
    }

    // a short question and a normal answer
    await box.click();
    await box.fill('Verification run: reply with exactly one short sentence saying pong.');
    await box.press('Enter');
    await expect(page.getByTestId('chat-reply-actions').last()).toBeVisible({ timeout: 150_000 }).catch(() => note('Chat: no answer with reply actions within 150 s for a short question'));
    await shoot(page, '46-chat-answered', 'd', 'light');
    await shoot(page, '46-chat-answered', 'd', 'dark');

    // regenerate
    const regen = page.getByTestId('chat-regenerate');
    if (await regen.isVisible().catch(() => false)) {
      await regen.click();
      await expect(page.getByTestId('chat-variant-pos')).toHaveText('2 / 2', { timeout: 150_000 }).catch(() => note('Chat: Regenerate did not produce a second variant "2 / 2" within 150 s'));
      await shoot(page, '47-chat-regenerated', 'd', 'light');
      await page.getByTestId('chat-variant-prev').click().catch(() => undefined);
      await shoot(page, '48-chat-variant-1', 'd', 'light');
    } else note('Chat: no Regenerate button on the last answer');

    // the model menu
    await page.getByTestId('chat-model').click();
    const items = page.getByTestId('chat-model-item');
    log(`model items: ${(await items.allTextContents()).map((t) => t.replace(/\s+/g, ' ')).join(' | ')}`);
    await shoot(page, '49-chat-model-menu', 'd', 'light');
    if ((await items.count()) > 1) {
      await items.nth(1).click();
      log(`model now: ${(await page.getByTestId('chat-model').innerText()).replace(/\s+/g, ' ')}`);
    } else await page.keyboard.press('Escape');
    await shoot(page, '50-chat-model-switched', 'd', 'light');
    await box.click();
    await box.fill('Verification run: reply with one short sentence saying ping.');
    await box.press('Enter');
    await expect(page.getByTestId('chat-reply-actions').last()).toBeVisible({ timeout: 150_000 }).catch(() => note('Chat: no answer within 150 s after the model switch'));
    await shoot(page, '51-chat-after-model-switch', 'd', 'light');
    // the rail row
    await expect(page.getByTestId('chat-row').first()).toBeVisible(T);
    await shoot(page, '52-chat-rail', 'd', 'light');
  } finally {
    await ctx.close();
  }
  // the same chat on the phone
  const m = await open(browser, 'NADIA', 'm');
  try {
    await m.page.goto(`/t/engineering/chat?bot=brain&c=${chatRoots[0]}`);
    await settle(m.page);
    await shoot(m.page, '53-chat-conversation', 'm', 'light');
    await shoot(m.page, '53-chat-conversation', 'm', 'dark');
    await m.page.getByTestId('chat-rail-toggle').click().catch(() => undefined);
    await shoot(m.page, '54-chat-rail-drawer', 'm', 'light');
  } finally {
    await m.ctx.close();
  }
});

/** Deletes every chat of the probe through the rail menu (a soft delete with an Undo window). */
async function removeChats(browser: Browser): Promise<void> {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    for (const root of chatRoots.filter(Boolean)) {
      await page.goto(`/t/engineering/chat?bot=brain&c=${root}`);
      await settle(page);
      // only a chat the probe made (its first words are "Verification run"): never another of the person's chats
      const any = page.getByTestId('chat-row').filter({ hasText: 'Verification run' }).first();
      if ((await any.count()) === 0) continue;
      await any.hover();
      await any.getByTestId('chat-row-menu').click();
      await page.getByTestId('chat-menu-delete').click();
      await page.waitForTimeout(800);
      await shoot(page, '55-chat-deleted', 'd', 'light');
    }
  } finally {
    chatRoots.length = 0;
    await ctx.close();
  }
}

let routineName = '';
let routinesRemoved = false;
let actionAdded = false;

test('06 Nadia: New routine in words (draft, then a test routine that is deleted), action items', async ({ browser }) => {
  test.setTimeout(540_000);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await expect(page.getByTestId('routine-new')).toBeVisible(T);
    await page.getByTestId('routine-new').click();
    await expect(page.getByTestId('dialog-new-routine')).toBeVisible(T);
    await shoot(page, '60-routine-new-dialog', 'd', 'light');
    await expect(page.getByTestId('routine-propose')).toBeDisabled();
    await page.getByTestId('routine-sentence').fill('Every weekday at 8:00 AM tell me which threads are waiting on me');
    await shoot(page, '61-routine-sentence', 'd', 'light');
    await page.getByTestId('routine-propose').click();
    const plan = page.getByTestId('dialog-routine-plan');
    const err = page.getByTestId('routine-propose-error');
    await expect(plan.or(err)).toBeVisible({ timeout: 90_000 });
    if (await err.isVisible().catch(() => false)) note(`Routines: proposing a routine from a sentence failed: ${(await err.innerText()).slice(0, 200)}`);
    await shoot(page, '62-routine-plan', 'd', 'light');
    await shoot(page, '62-routine-plan', 'd', 'dark');
    if (await plan.isVisible().catch(() => false)) {
      log(`plan: ${(await plan.innerText()).replace(/\s+/g, ' ').slice(0, 700)}`);
      // a draft only: back to the sentence (kept), then forward again with the plan that was made
      await page.getByTestId('routine-back').click();
      await expect(page.getByTestId('routine-sentence')).toBeVisible();
      await expect(page.getByTestId('routine-sentence')).toHaveValue(/Every weekday at 8:00 AM/);
      await page.getByTestId('routine-propose').click();
      await expect(plan).toBeVisible({ timeout: 150_000 });
      routineName = `Verify A ${sfx}`;
      await page.getByTestId('routine-name').fill(routineName);
      // a test routine for Nadia's own account; it is deleted again below
      await page.getByTestId('routine-confirm').click();
      await expect(plan).toHaveCount(0, T);
      const row = page.locator('[data-testid="routine"]').filter({ hasText: routineName });
      await expect(row).toHaveCount(1, T);
      // keep it from firing: pause it at once
      const pause = row.getByTestId('routine-pause');
      if (await pause.isVisible().catch(() => false)) await pause.click();
      await shoot(page, '63-routine-created', 'd', 'light');
      await shoot(page, '63-routine-created', 'd', 'dark');
      log(`routine row: ${(await row.innerText()).replace(/\s+/g, ' ')}`);
    }
  } finally {
    await ctx.close();
  }
  // the phone: the dialog and the list
  const m = await open(browser, 'NADIA', 'm');
  try {
    await m.page.goto('/account/routines');
    await settle(m.page);
    await shoot(m.page, '64-routines-list', 'm', 'light');
    await m.page.getByTestId('routine-new').click();
    await shoot(m.page, '65-routine-new-dialog', 'm', 'light');
  } finally {
    await m.ctx.close();
  }
  // action items: add one, tick it, look at it
  const a = await open(browser, 'NADIA');
  try {
    await a.page.goto('/account/action-items');
    await expect(a.page.getByTestId('action-item-add')).toBeVisible(T);
    await a.page.getByTestId('action-item-what').fill(`Verify A ${sfx}: check the live probe`);
    await a.page.getByTestId('action-item-add-button').click();
    actionAdded = true;
    const item = a.page.locator('[data-testid="action-item"]').filter({ hasText: `Verify A ${sfx}` });
    await expect(item).toHaveCount(1, T);
    await shoot(a.page, '66-action-item-added', 'd', 'light');
    const calls: string[] = [];
    a.page.on('response', (r) => {
      if (/action-items|actions/.test(r.url()) && r.request().method() !== 'GET') calls.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
    });
    await item.locator('input[type="checkbox"]').click();
    await settle(a.page);
    log(`tick calls: ${calls.join(' | ') || 'none'}; checked now: ${await item.locator('input[type="checkbox"]').isChecked()}; alert: ${(await a.page.getByTestId('action-items-error').allInnerTexts()).join('/')}`);
    if (!(await item.locator('input[type="checkbox"]').isChecked())) note('Action items: ticking an item did not keep it ticked');
    await shoot(a.page, '67-action-item-ticked', 'd', 'light');
    await shoot(a.page, '67-action-item-ticked', 'd', 'dark');
    await item.getByTestId('action-item-to-board').click({ timeout: 3000 }).catch(() => undefined);
    await shoot(a.page, '68-action-item-board-form', 'd', 'light');
  } finally {
    await a.ctx.close();
  }
});

async function removeRoutine(browser: Browser): Promise<void> {
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/account/routines');
    await settle(page);
    for (let i = 0; i < 5; i += 1) {
      const row = page.locator('[data-testid="routine"]').filter({ hasText: 'Verify A ' }).first();
      if ((await row.count()) === 0) break;
      await row.getByTestId('routine-delete').click();
      await row.getByTestId('routine-delete-yes').click();
      await page.waitForTimeout(1200);
    }
    await expect(page.locator('[data-testid="routine"]').filter({ hasText: 'Verify A ' })).toHaveCount(0, T);
    routinesRemoved = true;
  } finally {
    await ctx.close();
  }
}

test('07 Lena (guest) sees no Chat or Personal; Sameera cannot reach Nadia\'s Personal files', async ({ browser }) => {
  // guest
  const g = await open(browser, 'LENA');
  try {
    await g.page.goto('/');
    await settle(g.page);
    await shoot(g.page, '70-guest-home', 'd', 'light');
    const side = await g.page.locator('body').innerText();
    for (const word of ['Chat', 'Memory', 'Knowledge']) {
      const hit = (await g.page.getByRole('link', { name: word, exact: true }).count()) > 0;
      log(`guest sidebar link ${word}: ${hit}`);
      if (hit) note(`Guest: a "${word}" link is in the sidebar`);
    }
    log(`guest body has Personal: ${/Personal/.test(side)}`);
    const st: Record<string, number> = {};
    for (const path of ['/api/me/files/tree', '/api/me/memory/concepts', '/api/me/inbox/items', '/api/me/bot-consents', '/api/teams/engineering/bots/brain/conversations?scope=mine&limit=5']) {
      st[path] = (await g.page.request.get(path)).status();
    }
    log(`guest API statuses: ${JSON.stringify(st)}`);
    log(`guest bot-consents body: ${(await (await g.page.request.get('/api/me/bot-consents')).text()).slice(0, 300)}`);
    for (const [path, status] of Object.entries(st)) if (![401, 403, 404].includes(status) && !path.includes('bot-consents')) note(`Guest: GET ${path} answered ${status}, not a refusal`);
  } finally {
    await g.ctx.close();
  }
  await sweep(browser, 'LENA', '71-guest-files', '/files', undefined, [['d', 'light'], ['m', 'light']]);
  await sweep(browser, 'LENA', '72-guest-chat-url', '/t/engineering/chat?bot=brain', undefined, [['d', 'light'], ['m', 'light']]);
  await sweep(browser, 'LENA', '73-guest-memory-url', '/memory', undefined, [['d', 'light']]);
  await sweep(browser, 'LENA', '74-guest-account-bots', '/account/bots', undefined, [['d', 'light']]);

  // Sameera against a file of Nadia's
  const n = await open(browser, 'NADIA');
  let fileId = '';
  let versionId = '';
  let personId = '';
  try {
    const up = await n.page.request.post('/api/me/files?folderPath=Notes&conflict=rename', {
      headers: { ...(await csrf(n.ctx)), 'content-type': 'text/markdown', 'x-file-name': encodeURIComponent(`verify-a-private-${sfx}.md`) },
      data: Buffer.from('Nadia private note\n'),
    });
    expect(up.status()).toBeLessThan(300);
    const j = (await up.json()) as any;
    fileId = j.fileId ?? j.id;
    noteMade = true;
    const vs = (await (await n.page.request.get(`/api/me/files/${fileId}/versions`)).json()) as any;
    log(`version item keys: ${Object.keys(vs.items?.[0] ?? {}).join(',')}`);
    versionId = vs.items?.[0]?.id ?? vs.items?.[0]?.versionId ?? '';
    log(`nadia file id set: ${Boolean(fileId)} version id set: ${Boolean(versionId)}`);
    for (const cand of ['/api/auth/session', '/api/session', '/api/me', '/api/auth/me']) {
      const r = await n.page.request.get(cand);
      if (r.status() === 200) {
        const body = (await r.json().catch(() => ({}))) as any;
        personId = body.personId ?? body.person?.id ?? body.user?.id ?? body.id ?? '';
        log(`session at ${cand}: keys ${Object.keys(body).join(',')} personId found: ${Boolean(personId)}`);
        if (personId) break;
      }
    }
  } finally {
    await n.ctx.close();
  }
  const s = await open(browser, 'SAMEERA');
  try {
    expect(fileId).not.toBe('');
    const h = await csrf(s.ctx);
    const results: Record<string, number> = {
      'GET versions': (await s.page.request.get(`/api/me/files/${fileId}/versions`)).status(),
      'GET content': (await s.page.request.get(`/api/me/files/${fileId}/versions/${versionId}/content`)).status(),
      'PATCH file': (await s.page.request.patch(`/api/me/files/${fileId}`, { headers: h, data: { name: 'x.md' } })).status(),
      'POST restore': (await s.page.request.post(`/api/me/files/${fileId}/versions/${versionId}/restore`, { headers: h })).status(),
      'POST share-check': (await s.page.request.post(`/api/me/files/${fileId}/share-check`, { headers: h, data: {} })).status(),
      'DELETE file': (await s.page.request.delete(`/api/me/files/${fileId}`, { headers: h })).status(),
    };
    log(`Sameera on Nadia's file: ${JSON.stringify(results)}`);
    for (const [k, v] of Object.entries(results)) if (![401, 403, 404].includes(v)) note(`Isolation: Sameera ${k} on Nadia's file answered ${v}`);
    const tree = (await (await s.page.request.get('/api/me/files/tree?path=Notes')).json().catch(() => ({}))) as any;
    log(`Sameera's own Notes entries: ${JSON.stringify((tree.items ?? tree.entries ?? []).map((e: any) => e.name))}`);
    if (JSON.stringify(tree).includes(`verify-a-private-${sfx}`)) note("Isolation: Nadia's file is listed in Sameera's own Notes");
    // the admin-only look by URL
    await s.page.goto(`/files/person/${personId || '00000000-0000-4000-8000-000000000000'}`);
    await settle(s.page);
    log(`Sameera at /files/person/<nadia>: url ${new URL(s.page.url()).pathname}`);
    await shoot(s.page, '75-member-person-url', 'd', 'light');
    await shoot(s.page, '75-member-person-url', 'm', 'light').catch(() => undefined);
    const body = await s.page.locator('body').innerText();
    if (/verify-a-private/.test(body)) note("Isolation: Nadia's file name shows for Sameera at /files/person/<nadia>");
  } finally {
    await s.ctx.close();
  }
});

test('08 Omar: runners, the member menu and the Personal open dialog (viewed, never submitted)', async ({ browser }) => {
  await sweep(browser, 'OMAR', '32-runners', '/settings/workspace/runners', undefined, [['d', 'light']]);
  const { ctx, page } = await open(browser, 'OMAR');
  try {
    await page.goto('/settings/workspace/members');
    await settle(page);
    const row = page.locator('tr, [role="row"], li').filter({ hasText: 'nadia@kahf.example' }).first();
    await row.getByRole('button').last().click();
    await page.waitForTimeout(500);
    const items = await page.getByRole('menuitem').allInnerTexts();
    log(`member menu items: ${items.join(' | ')}`);
    await shoot(page, '33-members-menu', 'd', 'light');
    const open = page.getByRole('menuitem', { name: /Personal/i }).first();
    if (await open.count()) {
      await open.click();
      await page.waitForTimeout(600);
      await shoot(page, '34-members-open-personal-dialog', 'd', 'light');
      await shoot(page, '34-members-open-personal-dialog', 'd', 'dark');
      const cancel = page.getByRole('button', { name: /Cancel|Close/ }).first();
      if (await cancel.count()) await cancel.click();
      else await page.keyboard.press('Escape');
    } else note('Members: no "Personal" item in the member menu');
  } finally {
    await ctx.close();
  }
  const m = await open(browser, 'OMAR', 'm');
  try {
    await m.page.goto('/settings/workspace/members');
    await shoot(m.page, '35-members', 'm', 'light');
  } finally {
    await m.ctx.close();
  }
});

test('09 final state: Nadia\'s Notes, Routines, Action items are clean again', async ({ browser }) => {
  await sweep(browser, 'NADIA', '80-final-notes', '/files?path=Notes', undefined, [['d', 'light']]);
  await sweep(browser, 'NADIA', '81-final-routines', '/account/routines', undefined, [['d', 'light']]);
  await sweep(browser, 'NADIA', '82-final-action-items', '/account/action-items', undefined, [['d', 'light']]);
  const { ctx, page } = await open(browser, 'NADIA');
  try {
    await page.goto('/files?path=Notes');
    await expect(page.getByTestId('upload')).toBeEnabled(T);
    await expect(page.locator('[data-testid="file-row"][data-path^="Notes/verify-a"]')).toHaveCount(0);
    await page.goto('/account/routines');
    await expect(page.getByTestId('routine-new')).toBeVisible(T);
    await expect(page.locator('[data-testid="routine"]').filter({ hasText: 'Verify A ' })).toHaveCount(0);
    await page.goto('/account/action-items');
    await expect(page.getByTestId('action-item-add')).toBeVisible(T);
    await expect(page.locator('[data-testid="action-item"]')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('99 cleanup: the probe note is removed', async ({ browser }) => {
  await removeRoutine(browser);
  await removeActionFiles(browser);
  await removeChats(browser).catch((e: Error) => log(`chat cleanup: ${e.message.slice(0, 120)}`));
  expect(await removeNote(browser)).toBe(true);
});
test.afterAll(async ({ browser }) => {
  // also when a test above failed half way: no probe note stays in Nadia's Notes
  if (chatRoots.length > 0) await removeChats(browser).catch((e: Error) => log(`CHAT CLEANUP FAILED ${e.message.slice(0, 200)}`));
  if (routineName && !routinesRemoved) await removeRoutine(browser).catch((e: Error) => log(`ROUTINE CLEANUP FAILED ${e.message.slice(0, 200)}`));
  if (actionAdded) await removeActionFiles(browser).catch((e: Error) => log(`ACTION CLEANUP FAILED ${e.message.slice(0, 200)}`));
  if (noteMade) await removeNote(browser).catch((e: Error) => log(`CLEANUP FAILED ${e.message.slice(0, 200)}`));
});
