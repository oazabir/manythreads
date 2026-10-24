import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-05 (the BOT.md editor) on the live site. The input: the roster the Bots entry opens, one bot's page with its fourteen
 * tabs, and the red banner a definition that will not load raises. The last test drives the feature for real: a lead commits
 * a broken `bots/coder/BOT.md`, the loader flags the row, the page and the roster show it, and the original definition is
 * committed straight back in the same run (no live side effect survives). Signs in like a person with the screenshot password.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-05-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const DESKTOP = { width: 1440, height: 900 };
const ROSTER_PATH = '/t/engineering/bots';
const BOT_PATH = '/t/engineering/bots/coder';
const BOT_MD = 'bots/coder/BOT.md';

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, 'password sign-in as the lead (is the live password current?)').not.toHaveURL(/\/sign-in/);
  return page;
}

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies(BASE)).find((c) => c.name === 'manythreads_csrf' || c.name === '__Host-manythreads_csrf');
  if (!csrf) throw new Error('no manythreads_csrf cookie after sign-in');
  return { 'x-csrf-token': csrf.value };
}

/** Screenshots `path` into <OUT>/<name>.png, letting `prepare` arrange the screen first (does not close the context). */
async function shootOn(page: Page, name: string, path: string, prepare?: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  if (prepare) await prepare(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

/** One shot in its own signed-in context. */
async function shoot(browser: Browser, name: string, path: string, prepare?: (page: Page) => Promise<void>): Promise<void> {
  const page = await signIn(browser);
  try {
    await shootOn(page, name, path, prepare);
  } finally {
    await page.context().close();
  }
}

const readDefinition = async (page: Page): Promise<{ content: string; blobSha: string }> => {
  const res = await page.request.get('/api/teams/engineering/repo/blob', { params: { path: BOT_MD, ref: 'main' } });
  expect(res.status(), `read ${BOT_MD} on live`).toBe(200);
  return (await res.json()) as { content: string; blobSha: string };
};

const commitDefinition = async (page: Page, headers: Record<string, string>, content: string, blobSha: string, message: string): Promise<void> => {
  const res = await page.request.post('/api/teams/engineering/repo/commit', {
    headers,
    data: { changes: [{ op: 'put', path: BOT_MD, content, baseBlobSha: blobSha }], message },
  });
  expect(res.status(), `commit ${BOT_MD}: ${await res.text()}`).toBe(201);
};

/** Which bots the roster currently marks as needing a fix, straight from the API the page reads. */
const rosterOf = async (page: Page): Promise<Array<{ slug: string; invalid: unknown }>> => {
  const res = await page.request.get('/api/teams/engineering/bots');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { bots: Array<{ slug: string; invalid: unknown }> }).bots;
};

test('p5-05 the roster the Bots entry opens', async ({ browser }) => {
  await shoot(browser, 'p5-05-roster', ROSTER_PATH, async (page) => {
    await expect(page.getByTestId('bot-row').first()).toBeVisible();
    await expect(page.getByTestId('roster-count')).toContainText('bot');
  });
});

test('p5-05 one bot page: Identity, with Save', async ({ browser }) => {
  await shoot(browser, 'p5-05-bot-identity', BOT_PATH, async (page) => {
    await expect(page.getByTestId('bot-page')).toBeVisible();
    await expect(page.getByTestId('bot-name')).toHaveValue(/./);
    await expect(page.getByTestId('save-bot')).toBeVisible();
  });
});

test('p5-05 the Capabilities tab (the one allowlist)', async ({ browser }) => {
  await shoot(browser, 'p5-05-bot-capabilities', `${BOT_PATH}?tab=capabilities`, async (page) => {
    await expect(page.getByTestId('pane-capabilities')).toContainText('Never bot-writable');
  });
});

test('p5-05 the Audit tab', async ({ browser }) => {
  await shoot(browser, 'p5-05-bot-audit', `${BOT_PATH}?tab=audit`, async (page) => {
    await expect(page.getByTestId('pane-audit')).toContainText('Definition');
  });
});

/**
 * The red banner for real: break the definition, let the loader flag the row, photograph the roster and the page, then commit
 * the original bytes back. The restore runs in `finally`, so a failure cannot leave the live bot broken.
 */
test('p5-05 an invalid BOT.md is the red banner, and the restore puts it back', async ({ browser }) => {
  const page = await signIn(browser);
  const original = await readDefinition(page);
  try {
    const headers = await csrfHeaders(page);
    const broken = original.content.replace(/^role: .*$/m, 'role:');
    expect(broken, 'the definition has a role line to break').not.toBe(original.content);
    await commitDefinition(page, headers, broken, original.blobSha, 'Break the coder definition (P5-05 screenshots)');

    // the loader flags the row on the next outbox pass (a few seconds at worst)
    for (let i = 0; i < 10; i += 1) {
      if ((await rosterOf(page)).some((b) => b.slug === 'coder' && b.invalid)) break;
      await page.waitForTimeout(1500);
    }
    expect((await rosterOf(page)).find((b) => b.slug === 'coder')?.invalid, 'the loader flagged the broken definition').toBeTruthy();

    await shootOn(page, 'p5-05-roster-invalid', ROSTER_PATH, async (p) => {
      await expect(p.locator('[data-testid="bot-row"][data-bot="coder"]')).toContainText('needs a fix');
    });
    await shootOn(page, 'p5-05-invalid-banner', BOT_PATH, async (p) => {
      await expect(p.getByTestId('bot-invalid-banner')).toBeVisible();
      await expect(p.getByTestId('definition-unreadable')).toBeVisible();
    });
  } finally {
    const current = await readDefinition(page);
    await commitDefinition(page, await csrfHeaders(page), original.content, current.blobSha, 'Restore the coder definition (P5-05 screenshots)');
    await page.context().close();
  }
});

/** Rebuilds the gallery over the whole output folder, so it shows every task's screenshots, not only this run's. */
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
});
