import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

/**
 * Bots on the host Hermes gateway, driven on the live site as real users: Coder answers an @mention in #dev, the Engineering Brain,
 * Support responder and Content drafter answer in their 1:1 conversations, and Engineer tags Plan reviewer (bot to bot). Then the sidebar
 * bot roster (no "agent not set up" / "agent not working") and no console error or error banner on the way.
 * Credentials come from the environment only (NADIA_EMAIL/NADIA_PASSWORD, OMAR_EMAIL/OMAR_PASSWORD; `source ~/manythreads.passwords.env`).
 * It POSTS real messages on the live site. Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.host-bots.shots.ts --retries=0
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/hb-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const T = { timeout: 20_000 };

type Who = { email: string; password: string };
const who = (key: 'NADIA' | 'OMAR'): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});

/** Console errors and page errors of every page this file opened, per test. */
const problems: string[] = [];

async function signIn(browser: Browser, user: Who): Promise<Page> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
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
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

/** The messages of the open thread panel/view written by `author` (display name), with their text. */
async function repliesBy(thread: Locator, author: string): Promise<string[]> {
  const rows = thread.getByTestId('message').filter({ has: thread.page().locator('.who b', { hasText: new RegExp(`^${author}$`, 'i') }) });
  const out: string[] = [];
  for (const row of await rows.all()) {
    const txt = (await row.locator('.txt, .answer, .msg-main').first().innerText()).replace(/\s+/g, ' ').trim();
    out.push(txt);
  }
  return out;
}

/** Wait until `author` has a non-empty reply in the thread (polls, since replies arrive by push); returns the text. */
async function waitReply(page: Page, thread: Locator, author: string, ms: number): Promise<string> {
  let last = '';
  await expect
    .poll(
      async () => {
        const texts = (await repliesBy(thread, author)).map((t) => t.replace(/^.*?\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, '').trim()).filter((t) => t.length > 0);
        last = texts.at(-1) ?? '';
        return last.length;
      },
      { timeout: ms, intervals: [2_000], message: `no reply from ${author} within ${ms / 1000} s` },
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(3_000); // a reply may still be edited or streamed in
  const texts = (await repliesBy(thread, author)).map((t) => t.replace(/^.*?\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, '').trim());
  return texts.at(-1) ?? last;
}

/** Post `body` in a channel's main composer, open the thread of the message just posted, and return the thread panel. */
async function postInChannel(page: Page, team: string, channel: string, body: string): Promise<Locator> {
  await page.goto(`/t/${team}/c/${channel}`);
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await box.fill(body);
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send' }).click();
  const mine = page.getByTestId('message').filter({ hasText: body.slice(0, 40) }).last();
  await expect(mine).toBeVisible(T);
  // the reply link appears once any bot has answered; before that, open the thread from the message's own action
  const link = mine.getByText(/\d+ repl(y|ies)/);
  await expect(link.first()).toBeVisible({ timeout: 120_000 });
  await link.first().click();
  const panel = page.getByTestId('thread-view').first();
  await expect(panel).toBeVisible(T);
  return panel;
}

/** Open a bot's 1:1 conversation by its Talk button on the roster, send `question`, return the thread view. */
async function askBot(page: Page, team: string, bot: string, question: string): Promise<Locator> {
  await page.goto(`/t/${team}/bots`);
  await page.locator(`[data-testid="bot-row"][data-bot="${bot}"]`).getByTestId('bot-talk').click();
  const refused = page.getByText('You cannot talk to this bot');
  await expect(page.getByTestId('conversation-view').or(refused).first()).toBeVisible(T);
  if (await refused.count()) {
    await shoot(page, `hb-refused-${team}-${bot}`);
    throw new Error(`the roster's Talk button for ${team}/${bot} opens "You cannot talk to this bot" (this user is not on the team; add them to it)`);
  }
  const box = page.getByRole('textbox', { name: /^Message / }).first();
  await expect(box).toBeVisible(T);
  await box.fill(question);
  await page.getByTestId('conversation-view').getByRole('button', { name: 'Send' }).click();
  const view = page.getByTestId('thread-view').first();
  await expect(view).toBeVisible(T);
  return view;
}

test('hb-01 Coder answers an @mention in #dev', async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await signIn(browser, who('NADIA'));
  try {
    const panel = await postInChannel(page, 'engineering', 'dev', '@coder reply with the single word pong and nothing else.');
    const reply = await waitReply(page, panel, 'Coder', 120_000);
    console.log(`[hb] 1 Coder replied: ${reply.slice(0, 200)}`);
    expect(reply.toLowerCase()).toContain('pong');
    await shoot(page, 'hb-01-dev-channel-and-thread');
    await panel.screenshot({ path: join(OUT, 'hb-01-dev-thread-panel.png'), animations: 'disabled', mask: [page.locator('[data-vt-mask]')] });
  } finally {
    await page.context().close();
  }
});

test('hb-02 Engineering Brain answers in a 1:1 conversation', async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await signIn(browser, who('NADIA'));
  try {
    const view = await askBot(page, 'engineering', 'brain', 'In one sentence, what is this team for?');
    const reply = await waitReply(page, view, 'Brain', 150_000);
    console.log(`[hb] 2 Brain replied: ${reply.slice(0, 300)}`);
    expect(reply.length).toBeGreaterThan(15);
    expect(reply).not.toMatch(/not set up|not working|could not|something went wrong/i);
    await shoot(page, 'hb-02-brain-conversation');
  } finally {
    await page.context().close();
  }
});

for (const [n, team, bot, name, question] of [
  ['03', 'customer-support', 'support-responder', 'Support responder', 'How do I reset my password?'],
  ['04', 'marketing', 'content-drafter', 'Content drafter', 'Draft a one-line tagline for a note-taking app.'],
] as const) {
  test(`hb-${n} ${name} answers omar in a 1:1 conversation`, async ({ browser }) => {
    test.setTimeout(240_000);
    const page = await signIn(browser, who('OMAR'));
    try {
      const view = await askBot(page, team, bot, question);
      const reply = await waitReply(page, view, name, 150_000);
      console.log(`[hb] ${n} ${name} replied: ${reply.slice(0, 300)}`);
      expect(reply.length).toBeGreaterThan(10);
      expect(reply).not.toMatch(/not set up|not working|something went wrong/i);
      await shoot(page, `hb-${n}-${bot}-conversation`);
    } finally {
      await page.context().close();
    }
  });
}

test('hb-05 Engineer tags Plan reviewer (bot to bot)', async ({ browser }) => {
  test.setTimeout(660_000);
  const page = await signIn(browser, who('NADIA'));
  try {
    const panel = await postInChannel(
      page,
      'engineering',
      'dev',
      '@engineer no code changes please: ask @plan-reviewer for a one-sentence introduction of itself and relay it here.',
    );
    const engineer = await waitReply(page, panel, 'Engineer', 240_000);
    console.log(`[hb] 5 Engineer replied: ${engineer.slice(0, 300)}`);
    let reviewer = '';
    await expect
      .poll(async () => {
        reviewer = (await repliesBy(panel, 'Plan reviewer')).at(-1) ?? '';
        return reviewer.length;
      }, { timeout: 240_000, intervals: [3_000], message: 'no Plan reviewer message in the thread' })
      .toBeGreaterThan(0);
    await page.waitForTimeout(3_000);
    console.log(`[hb] 5 Plan reviewer replied: ${reviewer.slice(0, 300)}`);
    expect((await repliesBy(panel, 'Engineer')).length).toBeGreaterThan(0);
    expect((await repliesBy(panel, 'Plan reviewer')).length).toBeGreaterThan(0);
    await shoot(page, 'hb-05-bot-to-bot-thread');
    await panel.screenshot({ path: join(OUT, 'hb-05-bot-to-bot-thread-panel.png'), animations: 'disabled', mask: [page.locator('[data-vt-mask]')] });
  } finally {
    await page.context().close();
  }
});

test('hb-06 the bot roster and sidebar say the bots are usable; no console error banner', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await signIn(browser, who('OMAR'));
  try {
    for (const [team, slugs] of [
      ['engineering', ['coder', 'engineer', 'plan-reviewer', 'brain']],
      ['customer-support', ['support-responder', 'brain']],
      ['marketing', ['content-drafter', 'brain']],
    ] as const) {
      await page.goto(`/t/${team}/bots`);
      await expect(page.getByTestId('bots-roster')).toBeVisible(T);
      await expect(page.getByTestId('bot-row').first()).toBeVisible(T);
      const states: string[] = [];
      for (const slug of slugs) {
        const row = page.locator(`[data-testid="bot-row"][data-bot="${slug}"]`);
        await expect(row, `${team}/${slug} in the roster`).toBeVisible(T);
        const state = (await row.getByTestId('bot-state').innerText()).trim();
        states.push(`${slug}=${state}`);
        expect(state, `${team}/${slug} state`).not.toMatch(/not set up|not working|needs a fix|off/i);
        const dot = page.locator(`[data-testid="sidebar-bot"][data-bot="${slug}"] .dot`);
        await expect(dot, `${team}/${slug} in the sidebar`).toHaveCount(1);
        expect((await dot.getAttribute('title')) ?? '', `${team}/${slug} sidebar tooltip`).not.toMatch(/not set up|not working/i);
      }
      console.log(`[hb] 6 ${team} roster: ${states.join(', ')}`);
      await expect(page.locator('[role="alert"]:visible')).toHaveCount(0);
      await shoot(page, `hb-06-roster-${team}`);
    }
    expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
    console.log(`[hb] console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 5).join(' | ') : ''}`);
    expect(problems.filter((p) => !/favicon|Failed to load resource/i.test(p)), 'console errors').toEqual([]);
  } finally {
    await page.context().close();
  }
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
