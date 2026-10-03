import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-04 (loader + pairing) on the live site. The input: `bots/coder/BOT.md` in the Files viewer and its History
 * (the loader is an outbox subscriber on `repo.repo.committed`, so the marker commit the first test makes is what
 * fires it). The output: the pairing round trip as an API story — the first mint answers 404 until the loader has
 * upserted the bot row, then a mint returns the token (shown once, redacted here) and a revoke turns it off.
 * The lead persona signs in like a person (the screenshot password from the environment).
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-04-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const DESKTOP = { width: 1440, height: 900 };
const BOTMD_PATH = '/t/engineering/files?open=bots/coder/BOT.md';
const MINT_URL = '/api/teams/engineering/bots/coder/pairing-tokens';

test.beforeAll(() => {
  if (PASSWORD.length < 12) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});

/** A fresh page signed in as the lead through the form, exactly like a person. */
async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // the form leaves /sign-in once the session exists; a refusal would show an alert instead
  await expect(page, 'password sign-in as the lead (is the live password current?)').not.toHaveURL(/\/sign-in/);
  return page;
}

/** The double-submit header value, read from the readable CSRF cookie like the web client does. */
async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies(BASE)).find((c) => c.name === 'manythreads_csrf');
  if (!csrf) throw new Error('no manythreads_csrf cookie after sign-in');
  return { 'x-csrf-token': csrf.value };
}

type Prepare = (page: Page) => Promise<void>;

/** Opens `path`, lets `prepare` arrange the screen, then saves <OUT>/<name>.png. */
async function shoot(page: Page, name: string, path: string, prepare?: Prepare): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  if (prepare) await prepare(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  // Dynamic regions (times, ids) carry data-vt-mask: painted over so a re-run differs only when the screen does.
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
  await page.context().close();
}

/** A file open in the centre has rendered its viewer. */
const fileOpen: Prepare = async (page) => {
  await expect(page.getByTestId('file-view')).toBeVisible();
  await expect(page.getByTestId('file-view').locator('[data-testid^="viewer-"]').first()).toBeVisible();
};

/** The marker the shot cycle writes into the definition body (replaced on every run, never appended twice; the
 * frontmatter the loader parses is untouched). */
const markerOf = (date: Date): string => `<!-- refreshed ${date.toISOString().slice(0, 19)} -->`;

interface StoryBlock {
  method: string;
  url: string;
  status: number;
  body: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The mint answer carries the raw token: show that a token came back without keeping it in the picture. */
function redact(body: string): string {
  return body.replace(/"token"\s*:\s*"[^"]*"/, '"token": "<redacted: shown once, sha256 stored>"');
}

function blockHtml(b: StoryBlock): string {
  const cls = b.status >= 200 && b.status < 300 ? 's-ok' : b.status === 404 ? 's-warn' : 's-bad';
  return `<div class="req"><div class="line"><span class="m">${escapeHtml(b.method)}</span> <span>${escapeHtml(b.url)}</span></div><div class="line"><span class="${cls}">${b.status}</span> <span>${escapeHtml(redact(b.body))}</span></div></div>`;
}

/** Renders the recorded API round trip as a page and screenshots it. */
async function renderStory(page: Page, name: string, blocks: StoryBlock[]): Promise<void> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pairing round trip on the live site</title><style>
body { font-family: Consolas, 'Courier New', monospace; margin: 40px; background: rgb(250, 250, 249); color: rgb(28, 28, 30); }
h1 { font-family: system-ui, sans-serif; font-size: 20px; margin-bottom: 4px; }
p { font-family: system-ui, sans-serif; font-size: 13px; color: rgb(90, 90, 92); }
.req { background: rgb(255, 255, 255); border: 1px solid rgb(222, 222, 218); border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
.line { margin: 2px 0; }
.m { font-weight: bold; }
.s-ok { color: rgb(20, 110, 50); font-weight: bold; }
.s-warn { color: rgb(150, 85, 0); font-weight: bold; }
.s-bad { color: rgb(170, 30, 30); font-weight: bold; }
</style></head><body><h1>Pairing round trip on the live site</h1><p>The probe before any BOT.md commit, the commit that fires the loader, the mint, the revoke.</p>${blocks.map(blockHtml).join('')}</body></html>`;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}

/**
 * The round trip itself. Runs first: it makes the commit that fires the loader, so the History screenshot shows it.
 * Nothing live keeps a credential the screenshots created: the token is revoked in the same run.
 */
test('p5-04 pairing round trip', async ({ browser }) => {
  const page = await signIn(browser);
  const headers = await csrfHeaders(page);
  const blocks: StoryBlock[] = [];

  // The bot row exists only once the loader has seen a commit to a BOT.md path: on a fresh deploy this first mint
  // is a 404, which is the feature's "not loaded yet" answer rather than a failure.
  let res = await page.request.post(MINT_URL, { headers });
  let status = res.status();
  expect([404, 201], 'first mint on live (404 = nothing loaded yet, 201 = a row already exists)').toContain(status);
  if (status === 404) {
    blocks.push({ method: 'POST', url: MINT_URL, status, body: `no bot row yet: ${(await res.text()).slice(0, 140)}` });
    // Fire the loader: a real commit touching bots/coder/BOT.md (a lead may write guarded paths directly).
    const blobRes = await page.request.get('/api/teams/engineering/repo/blob', { params: { path: 'bots/coder/BOT.md', ref: 'main' } });
    expect(blobRes.status(), 'read bots/coder/BOT.md on live').toBe(200);
    const blob = (await blobRes.json()) as { content: string; blobSha: string };
    const marker = markerOf(new Date());
    const markerRe = /<!-- refreshed [^>]*-->\n?/;
    const next = markerRe.test(blob.content) ? blob.content.replace(markerRe, `${marker}\n`) : `${blob.content.replace(/\s+$/, '')}\n\n${marker}\n`;
    const commitRes = await page.request.post('/api/teams/engineering/repo/commit', {
      headers,
      data: {
        changes: [{ op: 'put', path: 'bots/coder/BOT.md', content: next, baseBlobSha: blob.blobSha }],
        message: 'Refresh the coder definition',
      },
    });
    expect(commitRes.status(), 'the commit that fires the loader').toBe(201);
    const commit = (await commitRes.json()) as { sha: string; noop: boolean };
    expect(commit.noop, 'the marker changed the file, so this is a real commit').toBe(false);
    blocks.push({ method: 'POST', url: '/api/teams/engineering/repo/commit', status: 201, body: JSON.stringify({ sha: commit.sha, noop: commit.noop }) });
    // The loader upserts from the outbox (unit test: the row is there within 5 s); the mint route allows 10 per
    // minute, so poll on a 3 s cadence, five tries at most.
    for (let i = 0; i < 5 && status === 404; i += 1) {
      await page.waitForTimeout(3000);
      res = await page.request.post(MINT_URL, { headers });
      status = res.status();
    }
    expect(status, 'the loader created the bot row').toBe(201);
  }
  const minted = (await res.json()) as { token: string; createdAt: string };
  blocks.push({ method: 'POST', url: MINT_URL, status, body: JSON.stringify({ token: minted.token, createdAt: minted.createdAt }) });

  const revokeRes = await page.request.delete(MINT_URL, { headers });
  expect(revokeRes.status(), 'revoke the minted token').toBe(200);
  const revoked = (await revokeRes.json()) as { revoked: number };
  expect(revoked.revoked, 'at least the token just minted is turned off').toBeGreaterThanOrEqual(1);
  blocks.push({ method: 'DELETE', url: MINT_URL, status: 200, body: JSON.stringify({ revoked: revoked.revoked }) });

  await renderStory(page, 'p5-04-pairing-api', blocks);
  await page.context().close();
});

test('p5-04 the BOT.md the loader reads', async ({ browser }) => {
  await shoot(await signIn(browser), 'p5-04-botmd', BOTMD_PATH, fileOpen);
});

test('p5-04 the commit that fired the loader', async ({ browser }) => {
  await shoot(await signIn(browser), 'p5-04-botmd-history', BOTMD_PATH, async (page) => {
    await expect(page.getByTestId('file-view')).toBeVisible();
    await page.getByTestId('file-view').getByTestId('open-history').click();
    await expect(page.getByTestId('history').getByTestId('commit-row').first()).toBeVisible();
  });
});

test('p5-04 the roster that will show loaded bots', async ({ browser }) => {
  await shoot(await signIn(browser), 'p5-04-roster', '/settings/team/engineering/roster');
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
