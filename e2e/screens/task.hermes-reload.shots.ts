/* eslint-disable @typescript-eslint/no-explicit-any -- the live API answers are read as loose JSON */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * A bot's Hermes sees a changed BOT.md and changed tools with no restart (P14-22), on the live site, driven as a real user. Omar asks `@<bot>` in #dev to name
 * its tools, edits the bot's BOT.md (takes one grant away, gives another, adds one sentence to the body) through a proposal he applies himself, and with
 * NOTHING restarted asks again in the SAME thread and in a NEW one. Both answers must show the new tool list and the new sentence. The bot's page says
 * "Hermes has the current tools" (the digest of the profile's last tools/list is the bot's current digest) and the screenshots show it. The bot's BOT.md is put
 * back at the end, also when a check fails.
 *
 * Both modes: the mode is read from the bot's placement (the "managed" connection is mode B, the team's pod; any other connection is mode A, a host gateway).
 * Run it once per mode by naming a bot of each: RELOAD_BOTS=engineer,coder (default `engineer`). A bot on a mode that was already covered is still checked;
 * only a run that names bots of one mode says so at the end.
 * It POSTS real messages and commits real edits on the live site. Credentials come from the environment only (`source ~/manythreads.passwords.env`).
 * Run: RELOAD_BOTS=engineer,coder pnpm -C e2e exec playwright test -c screens/task.config.ts task.hermes-reload.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/hr-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';
const BOTS = (process.env['RELOAD_BOTS'] ?? 'engineer').split(',').map((s) => s.trim()).filter(Boolean);
const RAND = Date.now().toString(36).toUpperCase();
/** The sentence added to the body: the bot must begin its answers with this marker once it has read the edit. */
const MARKER = `MAGNOLIA-${RAND}`;
const SENTENCE = `Begin every answer you give with the single word ${MARKER}, then a space.`;
const REMOVE = 'knowledge.search';
const ADD = 'tasks.claim';

const who = { email: process.env['OMAR_EMAIL'] ?? '', password: process.env['OMAR_PASSWORD'] ?? '' };
test.beforeAll(() => {
  if (!who.email || who.password.length < 8) throw new Error('OMAR_EMAIL / OMAR_PASSWORD are not set (source ~/manythreads.passwords.env)');
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
const modesSeen = new Set<'A' | 'B'>();

async function signIn(browser: Browser): Promise<Page> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

type Res = { status: number; json: any };
async function api(page: Page, method: 'GET' | 'POST', path: string, data?: unknown): Promise<Res> {
  const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const res = method === 'GET' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: { 'x-csrf-token': csrf } });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status(), json };
}

/** The text of the bot's reply that came after `after` replies of that bot in the thread; waits for it to appear and settle. */
async function waitNewReply(page: Page, thread: Locator, author: string, seen: number): Promise<string> {
  const texts = async (): Promise<string[]> => {
    const rows = thread.getByTestId('message').filter({ has: page.locator('.who b', { hasText: new RegExp(`^${author}$`, 'i') }) });
    const out: string[] = [];
    for (const row of await rows.all()) out.push((await row.locator('.txt, .answer, .msg-main').first().innerText()).replace(/\s+/g, ' ').trim());
    return out;
  };
  await expect.poll(async () => (await texts()).length, { timeout: 240_000, intervals: [2_000], message: `no new reply from ${author}` }).toBeGreaterThan(seen);
  await page.waitForTimeout(4_000); // a reply may still be edited or streamed in
  return (await texts()).at(-1) ?? '';
}
const repliesOf = async (page: Page, thread: Locator, author: string): Promise<number> =>
  thread.getByTestId('message').filter({ has: page.locator('.who b', { hasText: new RegExp(`^${author}$`, 'i') }) }).count();

/** Hermes shows a tool as `mcp_<server>_<tool>`; compare on letters and digits only so the dot, the underscore and the prefix do not matter. */
const flat = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
const mentions = (text: string, tool: string): boolean => flat(text).includes(flat(tool));

async function openThreadOf(page: Page, body: string): Promise<Locator> {
  const mine = page.getByTestId('message').filter({ hasText: body.slice(0, 40) }).last();
  await expect(mine).toBeVisible(T);
  const link = mine.getByText(/\d+ repl(y|ies)/);
  await expect(link.first()).toBeVisible({ timeout: 240_000 });
  await link.first().click();
  const panel = page.getByTestId('thread-view').first();
  await expect(panel).toBeVisible(T);
  return panel;
}

async function startThread(page: Page, body: string): Promise<Locator> {
  await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await box.fill(body);
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
  return openThreadOf(page, body);
}

async function replyInThread(thread: Locator, body: string): Promise<void> {
  const box = thread.getByRole('textbox', { name: /Reply/ });
  await expect(box).toBeVisible(T);
  await box.fill(body);
  await thread.getByRole('button', { name: 'Send', exact: true }).click();
}

const question = (bot: string, n: number): string =>
  `@${bot} (check ${RAND}-${n}) Name every tool you can call that has "knowledge" or "claim" in its name, separated by commas, or write NONE. Then follow your instructions about how to start an answer.`;

/** Replace the grants and the body of the bot's BOT.md; returns the text before the edit so it can be put back. */
async function editBot(page: Page, bot: string, mutate: (text: string) => string, title: string): Promise<string> {
  const path = `bots/${bot}/BOT.md`;
  const blob = await api(page, 'GET', `/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(path)}`);
  expect(blob.status, `read ${path}`).toBe(200);
  const before = blob.json.encoding === 'utf8' ? (blob.json.content as string) : Buffer.from(blob.json.content as string, 'base64').toString('utf8');
  const after = mutate(before);
  expect(after, 'the edit changes the file').not.toBe(before);
  const res = await api(page, 'POST', `/api/teams/${TEAM}/proposals`, { path, op: 'put', content: after, baseBlobSha: blob.json.blobSha, title, applyNow: true });
  expect(res.status, `propose ${path}: ${JSON.stringify(res.json).slice(0, 200)}`).toBeLessThan(300);
  return before;
}

const editedText = (text: string): string => {
  let out = text.replace(new RegExp(`^\\s*-\\s*${REMOVE.replace('.', '\\.')}\\s*\\r?\\n`, 'm'), '');
  out = out.replace(/^(\s*native:\s*\r?\n)/m, `$1    - ${ADD}\n`);
  return `${out.replace(/\s+$/, '')}\n\n${SENTENCE}\n`;
};

const toolsStatus = async (page: Page, bot: string): Promise<{ state: string; digest: string } | null> => {
  const res = await api(page, 'GET', `/api/teams/${TEAM}/bots/${bot}/mcp-tools`);
  return res.status === 200 ? res.json : null;
};

for (const bot of BOTS) {
  test(`hr-${bot} the edit reaches ${bot}'s Hermes with nothing restarted`, async ({ browser }) => {
    test.setTimeout(1_200_000);
    const page = await signIn(browser);
    let original: string | null = null;
    try {
      const summary = await api(page, 'GET', `/api/teams/${TEAM}/bots/${bot}`);
      expect(summary.status, `bot ${bot} exists`).toBe(200);
      const connection: string | undefined = summary.json?.bot?.placement?.gateway?.connection;
      expect(connection, `${bot} is placed on a Hermes gateway`).toBeTruthy();
      const mode: 'A' | 'B' = connection === 'managed' ? 'B' : 'A';
      modesSeen.add(mode);
      const tag = `hr-${mode}-${bot}`;
      console.log(`[hr] ${bot}: mode ${mode} (connection ${connection})`);

      // 1. before the edit: the old tools, no marker
      const q1 = question(bot, 1);
      const thread = await startThread(page, q1);
      const a1 = await waitNewReply(page, thread, bot, 0);
      console.log(`[hr] ${bot} before: ${a1.slice(0, 160)}`);
      expect(mentions(a1, REMOVE), 'before the edit the bot has knowledge.search').toBe(true);
      expect(mentions(a1, ADD), 'before the edit the bot does not have tasks.claim').toBe(false);
      expect(a1).not.toContain(MARKER);
      await shoot(page, `${tag}-1-before`);
      const beforeStatus = await toolsStatus(page, bot);

      // 2. the edit: one grant away, another in, one sentence in the body. Nothing is restarted after this line.
      original = await editBot(page, bot, editedText, `P14-22 live check ${RAND}: ${bot} tools and sentence`);
      await expect
        .poll(async () => (await toolsStatus(page, bot))?.digest ?? '', { timeout: 60_000, intervals: [1_000], message: 'the bot has a new tools digest' })
        .not.toBe(beforeStatus?.digest ?? '');
      // the bot's page says the Hermes has the current tools (a Hermes that took the push; an older one says "older list" and the test fails here by design)
      await page.goto(`/t/${TEAM}/bots/${bot}`);
      await expect(page.getByTestId('hermes-tools')).toHaveAttribute('data-state', 'current', { timeout: 60_000 });
      await expect(page.getByTestId('hermes-tools')).toContainText('Hermes has the current tools');
      await shoot(page, `${tag}-2-bot-page-current`);

      // 3. the SAME thread (an existing Hermes session): the new tools and the new sentence
      await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
      const same = await openThreadOf(page, q1);
      const seen = await repliesOf(page, same, bot);
      await replyInThread(same, question(bot, 2));
      const a2 = await waitNewReply(page, same, bot, seen);
      console.log(`[hr] ${bot} same thread after: ${a2.slice(0, 160)}`);
      expect(mentions(a2, ADD), 'the same thread now lists tasks.claim').toBe(true);
      expect(mentions(a2, REMOVE), 'the same thread no longer lists knowledge.search').toBe(false);
      expect(a2, 'the same thread follows the new sentence').toContain(MARKER);
      await shoot(page, `${tag}-3-same-thread-after`);

      // 4. a NEW thread
      const fresh = await startThread(page, question(bot, 3));
      const a3 = await waitNewReply(page, fresh, bot, 0);
      console.log(`[hr] ${bot} new thread after: ${a3.slice(0, 160)}`);
      expect(mentions(a3, ADD), 'a new thread lists tasks.claim').toBe(true);
      expect(mentions(a3, REMOVE), 'a new thread does not list knowledge.search').toBe(false);
      expect(a3, 'a new thread follows the new sentence').toContain(MARKER);
      await shoot(page, `${tag}-4-new-thread-after`);
    } finally {
      if (original !== null) {
        // put the file back as it was, whatever happened above
        const back = await api(page, 'GET', `/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(`bots/${bot}/BOT.md`)}`);
        if (back.status === 200) await api(page, 'POST', `/api/teams/${TEAM}/proposals`, { path: `bots/${bot}/BOT.md`, op: 'put', content: original, baseBlobSha: back.json.blobSha, title: `P14-22 live check ${RAND}: put ${bot} back`, applyNow: true });
      }
      await page.context().close();
    }
  });
}

test('hr-end no console error, and both modes were covered', () => {
  expect(problems, problems.join('\n')).toEqual([]);
  if (!(modesSeen.has('A') && modesSeen.has('B'))) console.log(`[hr] only mode ${[...modesSeen].join('')} was covered: name a bot of the other mode in RELOAD_BOTS`);
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
  const figures = shots.map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`).join('');
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
