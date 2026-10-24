import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The two Hermes modes on the live site: mode A (a bot on the host's gateway, Hostdev) and mode B (the team's managed pod, the rest),
 * the Talk button rules, the goal threads, the board, team memory and the two deployed apps. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/hm-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled', fullPage });
}

const T = { timeout: 15_000 };

/** Run a step; a failure is logged, not thrown, so the shot is still taken. */
async function soft(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.log(`[hm] ${label}: ${(e as Error).message.split('\n')[0]}`);
  }
}

async function page_(browser: Browser, path: string, ready?: (p: Page) => Promise<unknown>): Promise<Page> {
  const page = await signIn(browser);
  await page.goto(path);
  if (ready) await soft(`ready ${path}`, () => ready(page));
  await page.waitForTimeout(1500);
  return page;
}

/** Shot of the page, then (for threads) full page and the thread panel scrolled by its height each time. */
async function shootParts(page: Page, name: string): Promise<void> {
  await shoot(page, name);
  await shoot(page, `${name}-full`, true);
  const view = page.getByTestId('thread-view').first();
  if (!(await view.count())) return;
  const info = await view.evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && !(n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))) n = n.parentElement;
    if (!n) {
      const inner = Array.from(el.querySelectorAll<HTMLElement>('*')).find((c) => c.scrollHeight > c.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(c).overflowY));
      if (!inner) return null;
      n = inner;
    }
    n.setAttribute('data-hm-scroll', '1');
    return { h: n.clientHeight, total: n.scrollHeight };
  });
  if (!info) return;
  const scroller = page.locator('[data-hm-scroll="1"]');
  const parts = Math.min(8, Math.ceil(info.total / info.h));
  for (let i = 0; i < parts; i++) {
    await scroller.evaluate((el, y) => { el.scrollTop = y; }, i * info.h);
    await page.waitForTimeout(400);
    await shoot(page, `${name}-part${i + 1}`);
  }
  await scroller.evaluate((el) => el.removeAttribute('data-hm-scroll'));
}

async function openThread(page: Page, root: string): Promise<void> {
  const msg = page.locator(`[data-message-id="${root}"]`);
  const own = msg.getByText(/\d+ repl(y|ies)/);
  if (await own.count()) await own.first().click(T);
  else await page.getByText(/\d+ replies/).last().click(T);
  await soft('thread view', () => expect(page.getByTestId('thread-view')).toBeVisible(T));
}

const plain = (name: string, path: string, ready?: (p: Page) => Promise<unknown>, full = false): void => {
  test(name, async ({ browser }) => {
    const page = await page_(browser, path, ready);
    try {
      await shoot(page, name);
      if (full) await shoot(page, `${name}-full`, true);
    } finally {
      await page.context().close();
    }
  });
};

plain('hm-01-roster', '/t/engineering/bots', (p) => expect(p.getByText('Sentinel').first()).toBeVisible(T));
plain('hm-02-bot-hostdev', '/t/engineering/bots/hostdev', (p) => expect(p.getByText('Hostdev').first()).toBeVisible(T));
plain('hm-03-bot-deployer', '/t/engineering/bots/deployer', (p) => expect(p.getByText('Deployer').first()).toBeVisible(T));

test('hm-04-bot-coder', async ({ browser }) => {
  const page = await page_(browser, '/t/engineering/bots/coder', (p) => expect(p.getByText('Coder').first()).toBeVisible(T));
  try {
    await shoot(page, 'hm-04-bot-coder');
    await expect(page.getByRole('button', { name: 'Talk' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Talk' })).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

plain('hm-05-bot-brain', '/t/engineering/bots/brain', (p) => expect(p.getByText('Brain').first()).toBeVisible(T));
plain('hm-06-brain-chat', '/t/engineering/bots/brain/chat', (p) => p.waitForLoadState('networkidle'), true);
plain('hm-07-coder-chat-refused', '/t/engineering/bots/coder/chat', (p) => p.waitForLoadState('networkidle'));

const thread = (name: string, root: string, expectText?: string): void => {
  test(name, async ({ browser }) => {
    const page = await page_(browser, `/t/engineering/c/dev?message=${root}`, (p) => expect(p.locator(`[data-message-id="${root}"]`)).toBeVisible(T));
    try {
      await openThread(page, root);
      if (expectText) await soft('thread text', () => expect(page.getByTestId('thread-view').getByText(expectText).first()).toBeVisible(T));
      await page.waitForTimeout(1000);
      await shootParts(page, name);
    } finally {
      await page.context().close();
    }
  });
};

thread('hm-08-goal-thread', '01a16ff1-1667-70e2-931c-4dfd5b584fa5', 'Deployer');
thread('hm-09-hostdev-thread', '01a1702b-4688-79b5-851e-3ddb3401f70c');
thread('hm-16-pingpong-thread', '01a17031-3c4d-783d-ad5d-3b25ecfe7007');
thread('hm-10-hostdev-memory-thread', '01a16fe8-aae7-76f2-8e36-6e8569acd611');

plain('hm-11-card-demo', '/t/engineering/boards?card=01a16ff2-9e3f-70bb-af31-6ab9974974d2', (p) => expect(p.getByTestId('card-panel')).toBeVisible(T));
plain('hm-12-board', '/t/engineering/boards', (p) => p.waitForLoadState('networkidle'));
plain('hm-13-memory', '/t/engineering/memory', (p) => p.waitForLoadState('networkidle'));

// The public edge does not route *.apps yet, so the apps are reached through the cluster's Traefik at the node IP.
const app = (name: string, url: string): void => {
  test(name, async () => {
    const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP *.apps.manythreads.kahf.to 10.0.2.15'] });
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: DESKTOP });
      const page = await context.newPage();
      let status = 0;
      try {
        const res = await page.goto(url, { timeout: 15_000 });
        status = res?.status() ?? 0;
      } catch (e) {
        console.log(`[hm] ${name}: ${(e as Error).message.split('\n')[0]}`);
      }
      if (status !== 200) {
        console.log(`[hm] ${name}: skipped (status ${status})`);
        return;
      }
      await page.waitForTimeout(1500);
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: join(OUT, `${name}.png`) });
    } finally {
      await browser.close();
    }
  });
};
app('hm-14-app-mode-b', 'https://money.engineering.apps.manythreads.kahf.to/');
app('hm-15-app-mode-a', 'https://money-host.engineering.apps.manythreads.kahf.to/');

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
