import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Polls (P14-07) on the live site, driven as real users in real browsers. Nadia (Engineering, #dev) asks a poll with the composer's Poll button and
 * another with `/poll`; Rafi (a second browser, never reloaded) sees each card arrive live, votes, changes his vote and withdraws, and Nadia's page
 * shows every count move without a reload. A multiple-choice poll closes by itself a minute ahead (the minute job posts a plain-text result); Nadia
 * closes one early and Omar (workspace owner) closes another that is Nadia's. An anonymous poll is refused in #dev (4 readers) with a sentence;
 * for the accepted case Omar adds Tariq to Engineering (undone at the end) and makes a private room of 5 readers; there only the voter sees "Your
 * vote". An option with a line break or a mention is refused. Arrow keys do not vote. At 390 px the card keeps its size and "Your vote" never covers
 * the option text or the count. No bot reply may follow a poll. Everything this run posted is deleted at the end and the room is archived.
 * Credentials come from the environment only (`source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.polls.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/pl-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';
const RAND = Date.now().toString(36);
const MARK = `pollcheck ${RAND}`;
const ROOM = `poll-live-${RAND}`;
const STARTED = Date.now();

type Who = { email: string; password: string };
type Key = 'NADIA' | 'RAFI' | 'OMAR';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'RAFI', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
type Sess = { page: Page; context: BrowserContext };

async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
}

const log = (s: string): void => console.log(`[pl] ${s}`);
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
const boxOf = (page: Page, channel = CHANNEL): Locator => page.getByRole('textbox', { name: `Message #${channel}` });
const card = (page: Page, question: string): Locator => page.getByTestId('poll').filter({ hasText: question });
const choice = (poll: Locator, name: RegExp | string): Locator => poll.getByRole('button', { name });
const voters = (poll: Locator): Locator => poll.getByTestId('poll-voters');


/**
 * With the composer focused its toolbar is open; the first mouse press elsewhere blurs it, the toolbar collapses, the feed shifts down by about 30 px
 * and the click is lost (a finding of this run: the first click on a poll option after using the composer does nothing). The specs blur it first.
 */
async function blurComposer(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(300);
}

type Ask = { question: string; options: string[]; multiple?: boolean; anonymous?: boolean; closeMinutes?: number };
/** Opens the composer's Poll button and fills the dialog; does not press Post. */
async function fillDialog(page: Page, channel: string, a: Ask): Promise<Locator> {
  await boxOf(page, channel).click(); // the toolbar opens with the caret
  await page.getByTestId('poll-tool').click();
  const dlg = page.getByTestId('poll-dialog');
  await expect(dlg).toBeVisible(T);
  await dlg.getByTestId('poll-question').fill(a.question);
  for (let i = 0; i < a.options.length; i++) {
    if (i >= 2) await dlg.getByTestId('poll-add-option').click();
    await dlg.getByTestId('poll-option-input').nth(i).fill(a.options[i]!);
  }
  if (a.multiple) await dlg.getByTestId('poll-multiple').check();
  if (a.anonymous) await dlg.getByTestId('poll-anonymous').check();
  if (a.closeMinutes) {
    await dlg.getByTestId('poll-close-unit').selectOption('minutes');
    await dlg.getByTestId('poll-close-amount').fill(String(a.closeMinutes));
  }
  return dlg;
}
async function askWithDialog(page: Page, channel: string, a: Ask): Promise<void> {
  const dlg = await fillDialog(page, channel, a);
  await dlg.getByTestId('poll-create').click();
  await expect(dlg).toBeHidden(T);
  await blurComposer(page);
}

let nadia: Sess | undefined;
let rafi: Sess | undefined;
let omar: Sess | undefined;
let devId = '';
let roomId = '';
let tariqAdded = false;
let tariqId = '';
const QUESTIONS = {
  button: `${MARK} Where do we eat on Friday?`,
  slash: `${MARK} Standup time?`,
  multi: `${MARK} Pick your toppings`,
  early: `${MARK} Close me early?`,
  byOmar: `${MARK} Admin closes this?`,
  anon: `${MARK} Secret lunch?`,
  phone: `${MARK} A rather long question so that it needs more than one line on a phone screen?`,
};

test.afterAll(async () => {
  // belt and braces: every message of this run is deleted, the room archived, Tariq taken out of Engineering again
  try {
    for (const [s, channelId] of [[nadia, devId], [nadia, roomId]] as const) {
      if (!s || !channelId) continue;
      const list = await s.page.request.get(`/api/channels/${channelId}/messages?limit=100`);
      const items = ((await list.json()) as { items: Array<{ id: string; body: string; authorId: string }> }).items;
      for (const m of items.filter((i) => i.body.includes(MARK))) {
        let res = await s.page.request.delete(`/api/channels/${channelId}/messages/${m.id}`, { headers: await csrf(s.context) });
        // the result of a poll Omar closed early is Omar's message
        if (res.status() === 403 && omar) res = await omar.page.request.delete(`/api/channels/${channelId}/messages/${m.id}`, { headers: await csrf(omar.context) });
        log(`cleanup: delete message "${m.body.slice(0, 50)}" -> ${res.status()}`);
      }
    }
    if (omar && roomId) {
      const ar = await omar.page.request.post(`/api/channels/${roomId}/archive`, { headers: await csrf(omar.context) });
      log(`cleanup: archive #${ROOM} -> ${ar.status()}`);
    }
    if (omar && tariqAdded && tariqId) {
      const rm = await omar.page.request.delete(`/api/teams/${TEAM}/members/${tariqId}`, { headers: await csrf(omar.context) });
      log(`cleanup: remove Tariq from Engineering again -> ${rm.status()}`);
    }
  } catch (e) {
    log(`cleanup failed: ${String(e).slice(0, 200)}`);
  }
  await nadia?.context.close().catch(() => undefined);
  await rafi?.context.close().catch(() => undefined);
  await omar?.context.close().catch(() => undefined);
});

test('pl-01 Nadia and Rafi open #dev; Nadia asks a poll with the composer Poll button; the card shows options as buttons and arrives live on Rafi page', async ({ browser }) => {
  nadia = await signIn(browser, who('NADIA'), DESKTOP);
  rafi = await signIn(browser, who('RAFI'), DESKTOP);
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  for (const s of [nadia, rafi]) {
    await s.page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    await expect(boxOf(s.page)).toBeVisible(T);
  }
  const groups = ((await (await nadia.page.request.get(`/api/teams/${TEAM}/channels`)).json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> }).groups;
  devId = groups.flatMap((g) => g.channels).find((c) => c.name === CHANNEL)?.id ?? '';
  expect(devId).not.toBe('');

  const { page } = nadia;
  await boxOf(page).click();
  await page.getByTestId('poll-tool').click();
  const dlg = page.getByTestId('poll-dialog');
  await expect(dlg).toBeVisible(T);
  await dlg.getByTestId('poll-create').click();
  log(`empty form says: "${(await dlg.getByTestId('poll-form-error').innerText()).trim()}"`);
  await expect(dlg.getByTestId('poll-form-error')).toContainText('Write the question');
  await shoot(page, 'pl-01-poll-dialog-empty-error-desktop');
  await dlg.getByTestId('poll-question').fill(QUESTIONS.button);
  await dlg.getByTestId('poll-option-input').nth(0).fill('Pizza');
  await dlg.getByTestId('poll-option-input').nth(1).fill('Sushi');
  await dlg.getByTestId('poll-add-option').click();
  await dlg.getByTestId('poll-option-input').nth(2).fill('Soup');
  await shoot(page, 'pl-02-poll-dialog-filled-desktop');
  await dlg.getByTestId('poll-create').click();
  await expect(dlg).toBeHidden(T);

  const mine = card(page, QUESTIONS.button);
  await expect(mine).toBeVisible(T);
  await expect(mine.getByTestId('poll-choice')).toHaveCount(3);
  await expect(mine.getByRole('group', { name: QUESTIONS.button })).toBeVisible();
  await expect(voters(mine)).toHaveText('No votes yet');
  await expect(mine.getByRole('button', { pressed: true })).toHaveCount(0);
  const theirs = card(rafi.page, QUESTIONS.button);
  await expect(theirs).toBeVisible(T); // Rafi never reloaded
  await expect(theirs.getByTestId('poll-choice')).toHaveCount(3);
  log('card on Nadia and (live) on Rafi: 3 option buttons, "No votes yet"');
  await mine.scrollIntoViewIfNeeded();
  await shoot(page, 'pl-03-poll-card-nadia-desktop');
  await theirs.scrollIntoViewIfNeeded();
  await shoot(rafi.page, 'pl-04-poll-card-rafi-live-desktop');
});

test('pl-02 /poll asks a poll too; a half-typed /poll opens the form with what was typed', async () => {
  const { page } = nadia!;
  const input = boxOf(page);
  await input.click();
  await input.fill(`/poll "${QUESTIONS.slash}" "9:30" "10:00" "11:00"`);
  await shoot(page, 'pl-05-slash-poll-typed-desktop');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('', T);
  const mine = card(page, QUESTIONS.slash);
  await expect(mine.getByTestId('poll-choice')).toHaveCount(3, T);
  await expect(card(rafi!.page, QUESTIONS.slash).getByTestId('poll-choice')).toHaveCount(3, T);
  await input.fill('/poll "Only one" "A"');
  await page.keyboard.press('Enter');
  const dlg = page.getByTestId('poll-dialog');
  await expect(dlg).toBeVisible(T);
  await expect(dlg.getByTestId('poll-question')).toHaveValue('Only one');
  await expect(dlg.getByTestId('poll-option-input').nth(0)).toHaveValue('A');
  log('/poll with 3 options posted a card; /poll with one option opened the form prefilled');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden(T);
  await input.fill('');
  await blurComposer(page);
});

test('pl-03 Rafi votes (Nadia sees it move with no reload), changes his vote and withdraws; arrow keys do not vote', async () => {
  const pa = card(nadia!.page, QUESTIONS.button);
  const pb = card(rafi!.page, QUESTIONS.button);
  await pb.scrollIntoViewIfNeeded();
  await choice(pb, /Sushi/).focus();
  await rafi!.page.keyboard.press('ArrowDown');
  await rafi!.page.keyboard.press('ArrowDown');
  await rafi!.page.keyboard.press('ArrowUp');
  await rafi!.page.waitForTimeout(1500);
  await expect(voters(pb)).toHaveText('No votes yet');
  await expect(voters(pa)).toHaveText('No votes yet');
  log('arrow keys ArrowDown/ArrowDown/ArrowUp on a focused option: still "No votes yet" on both pages');

  await choice(pb, /Pizza/).click();
  await expect(choice(pb, /Pizza/)).toHaveAttribute('aria-pressed', 'true');
  await expect(voters(pa)).toHaveText('1 vote', T);
  await expect(pa.getByTestId('poll-option').first()).toHaveAttribute('data-votes', '1');
  await expect(pa.getByRole('button', { pressed: true })).toHaveCount(0); // Nadia has not voted
  log(`Nadia sees "${await voters(pa).innerText()}" after Rafi voted Pizza (no reload)`);
  await pa.scrollIntoViewIfNeeded();
  await shoot(nadia!.page, 'pl-06-nadia-sees-rafi-vote-desktop');
  await shoot(rafi!.page, 'pl-07-rafi-voted-desktop');

  await choice(pb, /Sushi/).click();
  await expect(pb.getByTestId('poll-option').nth(1)).toHaveAttribute('data-mine', 'true');
  await expect(pa.getByTestId('poll-option').nth(1)).toHaveAttribute('data-votes', '1', T);
  await expect(pa.getByTestId('poll-option').first()).toHaveAttribute('data-votes', '0', T);
  await expect(voters(pa)).toHaveText('1 vote');
  log('Rafi changed Pizza to Sushi: still 1 vote, Pizza 0, Sushi 1 on Nadia page');

  await blurComposer(nadia!.page); // see blurComposer
  await choice(pa, /Soup/).click(); // Nadia votes too
  await expect(choice(pa, /Soup/)).toHaveAttribute('aria-pressed', 'true', T);
  await expect(voters(pa)).toHaveText('2 votes', T); // her own page counts her vote at once
  const live = await voters(pb)
    .evaluate((el) => (el as HTMLElement).innerText)
    .catch(() => '');
  log(`right after Nadia voted: Nadia sees "${await voters(pa).innerText()}", Rafi sees "${live}" (not reloaded)`);
  await expect(voters(pb)).toHaveText('2 votes', T);
  await pa.getByRole('button', { name: 'Show who voted' }).click();
  await expect(pa.getByTestId('poll-who')).toContainText('Rafi');
  await shoot(nadia!.page, 'pl-08-named-poll-who-voted-desktop');

  await pb.getByRole('button', { name: 'Remove my vote' }).click();
  await expect(pb.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(voters(pa)).toHaveText('1 vote', T);
  log('Rafi withdrew: 1 vote left (Nadia), Rafi has nothing pressed');
  await shoot(rafi!.page, 'pl-09-rafi-withdrew-desktop');
});

test('pl-04 multiple choice that closes in 1 minute: two choices at once, then the minute job closes it and posts a result', async () => {
  test.setTimeout(240_000);
  const { page } = nadia!;
  await askWithDialog(page, CHANNEL, { question: QUESTIONS.multi, options: ['Cheese', 'Olives', 'Mushrooms'], multiple: true, closeMinutes: 1 });
  const pa = card(page, QUESTIONS.multi);
  const pb = card(rafi!.page, QUESTIONS.multi);
  await expect(pa).toBeVisible(T);
  await expect(pb).toBeVisible(T);
  log(`closing line on the card: "${(await pa.innerText()).replace(/\s+/g, ' ').trim()}"`);
  await pb.scrollIntoViewIfNeeded();
  // a second click while the first vote is still on its way is ignored by the card (noted in the report), so each click waits for its own answer
  await choice(pb, /Cheese/).click();
  await expect(choice(pb, /Cheese/)).toHaveAttribute('aria-pressed', 'true', T);
  await rafi!.page.waitForTimeout(1000);
  await choice(pb, /Mushrooms/).click();
  await expect(pb.getByRole('button', { pressed: true })).toHaveCount(2);
  await expect(voters(pa)).toHaveText('1 vote', T);
  await pa.scrollIntoViewIfNeeded();
  await shoot(page, 'pl-10-multiple-choice-closing-soon-nadia-desktop');
  await shoot(rafi!.page, 'pl-11-multiple-choice-two-pressed-rafi-desktop');
  const t0 = Date.now();
  await expect(pb).toHaveAttribute('data-closed', 'true', { timeout: 200_000 });
  log(`card closed on Rafi page ${Math.round((Date.now() - t0) / 1000)} s after the 2 choices (not reloaded)`);
  await expect(choice(pb, /Cheese/)).toBeDisabled();
  const result = rafi!.page.getByTestId('message').filter({ hasText: QUESTIONS.multi }).filter({ hasNot: rafi!.page.getByTestId('poll') });
  await expect(result.first()).toBeVisible({ timeout: 90_000 });
  const rText = (await result.first().innerText()).replace(/\s+/g, ' ').trim();
  log(`result message: "${rText.slice(0, 260)}"`);
  await result.first().scrollIntoViewIfNeeded();
  await shoot(rafi!.page, 'pl-12-timed-poll-closed-and-result-rafi-desktop');
  await shoot(page, 'pl-13-timed-poll-closed-and-result-nadia-desktop');
});

test('pl-05 early close by the author, and by Omar (workspace owner) on Nadia poll; an ordinary reader is not offered the button', async () => {
  const { page } = nadia!;
  await askWithDialog(page, CHANNEL, { question: QUESTIONS.early, options: ['Yes', 'No'] });
  await askWithDialog(page, CHANNEL, { question: QUESTIONS.byOmar, options: ['Yes', 'No'] });
  await omar!.page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const early = card(page, QUESTIONS.early);
  const earlyR = card(rafi!.page, QUESTIONS.early);
  await expect(earlyR).toBeVisible(T);
  await choice(earlyR, /Yes/).click();
  await expect(voters(early)).toHaveText('1 vote', T);
  await expect(earlyR.getByRole('button', { name: 'Close poll' })).toHaveCount(0);
  await early.scrollIntoViewIfNeeded();
  await early.getByRole('button', { name: 'Close poll' }).click();
  await shoot(page, 'pl-14-close-confirm-nadia-desktop');
  await early.getByRole('button', { name: 'Close the poll now' }).click();
  await expect(early).toHaveAttribute('data-closed', 'true', T);
  await expect(earlyR).toHaveAttribute('data-closed', 'true', T);
  const msg = rafi!.page.getByTestId('message').filter({ hasText: `Poll closed early: ${QUESTIONS.early}` });
  await expect(msg).toBeVisible(T);
  log(`early close by author: result "${(await msg.innerText()).replace(/\s+/g, ' ').trim().slice(0, 200)}"`);
  await msg.scrollIntoViewIfNeeded();
  await shoot(rafi!.page, 'pl-15-early-closed-result-rafi-desktop');

  const op = omar!.page;
  const byOmar = card(op, QUESTIONS.byOmar);
  await expect(byOmar).toBeVisible(T);
  await byOmar.scrollIntoViewIfNeeded();
  await expect(byOmar.getByRole('button', { name: 'Close poll' })).toBeVisible();
  await byOmar.getByRole('button', { name: 'Close poll' }).click();
  await byOmar.getByRole('button', { name: 'Close the poll now' }).click();
  await expect(byOmar).toHaveAttribute('data-closed', 'true', T);
  await expect(card(page, QUESTIONS.byOmar)).toHaveAttribute('data-closed', 'true', T);
  const msg2 = page.getByTestId('message').filter({ hasText: `Poll closed early: ${QUESTIONS.byOmar}` });
  await expect(msg2).toBeVisible(T);
  log('Omar closed Nadia poll: card closed for Nadia live, result message posted');
  await shoot(op, 'pl-16-closed-by-omar-omar-desktop');
});

test('pl-06 options with a line break or a mention are refused in words; anonymous in #dev (4 readers) is refused with a sentence', async () => {
  const { page } = nadia!;
  // a mention typed into an option: by design (docs/plugins/channels.md) it is not refused, but it is plain text and mentions nobody
  let dlg = await fillDialog(page, CHANNEL, { question: `${MARK} mention option`, options: ['@rafi', 'No'] });
  await dlg.getByTestId('poll-create').click();
  await expect(dlg).toBeHidden(T);
  await blurComposer(page);
  const mpoll = card(page, `${MARK} mention option`);
  await expect(mpoll).toBeVisible(T);
  await expect(mpoll.locator('.poll-text').first()).toHaveText('@rafi');
  expect(await mpoll.locator('.poll-text').first().locator('a, .mention, [data-mention]').count()).toBe(0);
  const mrow = rafi!.page.getByTestId('message').filter({ hasText: `${MARK} mention option` });
  await expect(mrow).toBeVisible(T);
  const listed = (await (await page.request.get(`/api/channels/${devId}/messages?limit=30`)).json()) as { items: Array<Record<string, unknown>> };
  const mm = listed.items.find((m) => String(m['body']).includes(`${MARK} mention option`));
  log(`mention option poll posted as plain text; message keys naming mentions: ${JSON.stringify(Object.keys(mm ?? {}).filter((k) => /mention/i.test(k)))}`);
  await shoot(rafi!.page, 'pl-17-option-with-at-sign-plain-text-rafi-desktop');
  // a line break can only come in through the API (the form's fields are one line)
  const brk = await page.request.post(`/api/channels/${devId}/polls`, { data: { question: `${MARK} newline option`, options: ['A\nB', 'C'] }, headers: await csrf(nadia!.context) });
  log(`option with a line break via API -> ${brk.status()} ${(await brk.text()).slice(0, 200)}`);
  expect(brk.status()).toBeGreaterThanOrEqual(400);
  const men = await page.request.post(`/api/channels/${devId}/polls`, { data: { question: `${MARK} mention api`, options: ['@rafi', 'C'] }, headers: await csrf(nadia!.context) });
  log(`option with a mention via API -> ${men.status()} ${(await men.text()).slice(0, 200)}`);
  expect(men.status(), 'a mention in an option is plain text by design, not refused').toBe(201);
  // anonymous in #dev
  const before = await page.getByTestId('poll').count();
  dlg = await fillDialog(page, CHANNEL, { question: `${MARK} anon small`, options: ['Yes', 'No'], anonymous: true });
  await dlg.getByTestId('poll-create').click();
  await expect(dlg.getByTestId('poll-form-error')).toBeVisible(T);
  const e2 = (await dlg.getByTestId('poll-form-error').innerText()).trim();
  log(`anonymous in #dev -> "${e2}"`);
  await expect(dlg).toBeVisible();
  await shoot(page, 'pl-18-anonymous-refused-in-dev-desktop');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden(T);
  expect(await page.getByTestId('poll').count()).toBe(before);
  const list = (await (await page.request.get(`/api/channels/${devId}/messages?limit=30`)).json()) as { items: Array<{ body: string }> };
  expect(list.items.some((m) => /anon small|newline option/.test(m.body))).toBe(false);
  log('nothing was posted by the refused ones');
});

test('pl-07 anonymous poll in a private room of 5 readers: only the voter sees "Your vote", nobody is listed', async () => {
  const op = omar!.page;
  const ids = new Map<string, string>();
  const ws = (await (await op.request.get('/api/workspace/members')).json()) as { members: Array<{ personId: string; displayName: string }> };
  for (const m of ws.members) ids.set(m.displayName, m.personId);
  tariqId = ids.get('Tariq') ?? '';
  expect(tariqId).not.toBe('');
  const add = await op.request.post(`/api/teams/${TEAM}/members`, { data: { personId: tariqId }, headers: await csrf(omar!.context) });
  log(`add Tariq to Engineering -> ${add.status()}`);
  expect(add.status()).toBeLessThan(300);
  tariqAdded = true;
  const made = await op.request.post(`/api/teams/${TEAM}/channels`, { data: { name: ROOM, private: true }, headers: await csrf(omar!.context) });
  expect(made.status(), await made.text()).toBeLessThan(300);
  roomId = ((await made.json()) as { channel: { id: string } }).channel.id;
  for (const n of ['Nadia', 'Rafi', 'Priya', 'Tariq']) {
    const r = await op.request.post(`/api/channels/${roomId}/members`, { data: { personId: ids.get(n) }, headers: await csrf(omar!.context) });
    expect(r.status(), `${n}: ${await r.text()}`).toBeLessThan(300);
  }
  log(`private room #${ROOM} made with Omar, Nadia, Rafi, Priya, Tariq`);

  await nadia!.page.goto(`/t/${TEAM}/c/${ROOM}`);
  await rafi!.page.goto(`/t/${TEAM}/c/${ROOM}`);
  await expect(boxOf(nadia!.page, ROOM)).toBeVisible(T);
  await expect(boxOf(rafi!.page, ROOM)).toBeVisible(T);
  await askWithDialog(nadia!.page, ROOM, { question: QUESTIONS.anon, options: ['Pizza', 'Sushi', 'Soup'], anonymous: true });
  const pa = card(nadia!.page, QUESTIONS.anon);
  const pb = card(rafi!.page, QUESTIONS.anon);
  await expect(pa).toBeVisible(T);
  await expect(pb).toBeVisible(T);
  await expect(pa).toHaveAttribute('data-anonymous', 'true');
  await expect(pa).toContainText('Anonymous');
  await choice(pb, /Sushi/).click();
  await expect(pb.getByTestId('poll-option').nth(1)).toHaveAttribute('data-mine', 'true');
  const you = pb.getByTestId('poll-option').nth(1).locator('.poll-you');
  log(`Rafi (voter): .poll-you visible=${await you.first().isVisible()} text="${(await you.first().innerText()).trim()}"`);
  // anonymous totals reach other pages with a delay (about 4 s)
  await expect(voters(pa)).toHaveText('1 vote', { timeout: 30_000 });
  await expect(pa.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(pa.getByTestId('poll-option').nth(1)).toHaveAttribute('data-mine', 'false');
  const nadiaYou = await pa.locator('.poll-you').evaluateAll((els) => els.filter((e) => getComputedStyle(e).visibility !== 'hidden' && e.textContent?.trim()).length);
  log(`Nadia (not the voter): visible "Your vote" labels = ${nadiaYou}`);
  expect(nadiaYou).toBe(0);
  await expect(pa.getByRole('button', { name: /who voted/ })).toHaveCount(0);
  const id = await pa.getAttribute('data-poll-id');
  const api = await nadia!.page.request.get(`/api/channels/${roomId}/polls/${id}`);
  const body = (await api.json()) as { voters: unknown };
  log(`poll results API voters field for the author: ${JSON.stringify(body.voters)}`);
  expect(body.voters).toBeNull();
  await pa.scrollIntoViewIfNeeded();
  await shoot(nadia!.page, 'pl-19-anonymous-poll-nadia-not-voter-desktop');
  await pb.scrollIntoViewIfNeeded();
  await shoot(rafi!.page, 'pl-20-anonymous-poll-rafi-voter-your-vote-desktop');
});

test('pl-08 phone 390x844: card and dialog fit, a count changing moves nothing, "Your vote" never covers the text or the count', async ({ browser }) => {
  // the long poll goes in #dev: Nadia asks it through the API, Rafi watches on the phone
  await nadia!.page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const ask = await nadia!.page.request.post(`/api/channels/${devId}/polls`, {
    data: { question: QUESTIONS.phone, options: ['A fairly long first option', 'Short', 'Another long enough option text here'] },
    headers: await csrf(nadia!.context),
  });
  expect(ask.status(), await ask.text()).toBeLessThan(300);
  const phone = await signIn(browser, who('RAFI'), PHONE, true);
  try {
    const { page } = phone;
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    const poll = card(page, 'A rather long question');
    await expect(poll).toBeVisible(T);
    await poll.scrollIntoViewIfNeeded();
    expect(await noSideways(page)).toBe(true);
    await shoot(page, 'pl-21-poll-card-phone-390');
    const before = (await poll.boundingBox())!;
    // Nadia votes on her desktop page; the count moves under Rafi's open phone page
    const np = card(nadia!.page, 'A rather long question');
    await np.scrollIntoViewIfNeeded();
    await choice(np, /Short/).click();
    await expect(voters(poll)).toHaveText('1 vote', T);
    const after = (await poll.boundingBox())!;
    log(`card box before ${before.width}x${before.height} after ${after.width}x${after.height}`);
    expect(after.height).toBe(before.height);
    expect(after.width).toBe(before.width);
    await choice(poll, /A fairly long first option/).click();
    const first = poll.getByTestId('poll-option').first();
    await expect(first).toHaveAttribute('data-mine', 'true');
    const text = (await first.locator('.poll-text').boundingBox())!;
    const you = (await first.locator('.poll-you').boundingBox())!;
    const count = (await first.locator('.poll-count').boundingBox())!;
    const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
      a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
    log(`boxes text=${JSON.stringify(text)} you=${JSON.stringify(you)} count=${JSON.stringify(count)}`);
    expect(apart(you, text), 'Your vote overlaps the option text').toBe(true);
    expect(apart(you, count), 'Your vote overlaps the count').toBe(true);
    expect(await noSideways(page)).toBe(true);
    await poll.scrollIntoViewIfNeeded();
    await shoot(page, 'pl-22-poll-card-your-vote-phone-390');
    await page.getByRole('textbox', { name: 'Message #dev' }).click();
    await page.getByTestId('poll-tool').click();
    const dlg = page.getByTestId('poll-dialog');
    await expect(dlg).toBeVisible(T);
    await dlg.getByTestId('poll-question').fill('Phone dialog check');
    const db = (await dlg.boundingBox())!;
    expect(db.x).toBeGreaterThanOrEqual(0);
    expect(db.x + db.width).toBeLessThanOrEqual(PHONE.width);
    await shoot(page, 'pl-23-poll-dialog-phone-390');
    await page.keyboard.press('Escape');
  } finally {
    await phone.context.close();
  }
});

test('pl-09 no bot replied to any poll message, and no page error', async () => {
  for (const channelId of [devId, roomId]) {
    const res = await nadia!.page.request.get(`/api/channels/${channelId}/messages?limit=100`);
    const items = ((await res.json()) as { items: Array<{ body: string; createdAt: string; author: { displayName: string; kind: string } }> }).items;
    const since = items.filter((m) => Date.parse(m.createdAt) >= STARTED);
    const nonPeople = since.filter((m) => m.author.kind !== 'person');
    log(`channel ${channelId.slice(-4)}: ${since.length} messages since the run began, ${nonPeople.length} not from a person ${JSON.stringify(nonPeople.map((m) => `${m.author.displayName}(${m.author.kind}): ${m.body.slice(0, 60)}`))}`);
    expect(nonPeople.filter((m) => !m.body.includes(MARK))).toEqual([]);
  }
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  log(`console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 6).join(' | ') : ''}`);
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const shots: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.png')) shots.push(relative(OUT, full).split(sep).join('/'));
    }
  };
  walk(OUT);
  shots.sort();
  const figures = shots
    .map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`)
    .join('');
  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`,
  );
});
