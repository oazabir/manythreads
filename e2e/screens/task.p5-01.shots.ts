import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-01 (slack-compat door) on the live site. The input: a root message in #dev,
 * then the spike reply delivered through the PUBLIC door
 * `POST /api/slack-compat/chat.postMessage` with a freshly minted pairing token
 * (the exact shape the Hermes `manythreads` adapter sends). The output: the bot
 * reply readable in the thread, plus the API story. The lead persona signs in
 * like a person (the screenshot password from the environment); the token is
 * revoked in the same run and redacted in the picture.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-01-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const DESKTOP = { width: 1440, height: 900 };
const MINT_URL = '/api/teams/engineering/bots/coder/pairing-tokens';
const DOOR_URL = '/api/slack-compat/chat.postMessage';
const ROOT_TEXT = '[spike P5-01] Hermes adapter check — the reply below arrives through the public door';
const REPLY_TEXT = '[spike P5-01] delivered through chat.postMessage (pairing token, thread_ts)';

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

interface StoryBlock {
  method: string;
  url: string;
  status: number;
  body: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The mint answer and the door call carry the raw token: show the round trip without keeping it in the picture. */
function redact(body: string): string {
  return body.replace(/"token"\s*:\s*"[^"]*"/, '"token": "<redacted: shown once, sha256 stored>"');
}

function blockHtml(b: StoryBlock): string {
  const cls = b.status >= 200 && b.status < 300 ? 's-ok' : 's-bad';
  return `<div class="req"><div class="line"><span class="m">${escapeHtml(b.method)}</span> <span>${escapeHtml(b.url)}</span></div><div class="line"><span class="${cls}">${b.status}</span> <span>${escapeHtml(redact(b.body))}</span></div></div>`;
}

/** Renders the recorded API round trip as a page and screenshots it. */
async function renderStory(page: Page, name: string, blocks: StoryBlock[]): Promise<void> {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>slack-compat door on the live site</title><style>
body { font-family: Consolas, 'Courier New', monospace; margin: 40px; background: rgb(250, 250, 249); color: rgb(28, 28, 30); }
h1 { font-family: system-ui, sans-serif; font-size: 20px; margin-bottom: 4px; }
p { font-family: system-ui, sans-serif; font-size: 13px; color: rgb(90, 90, 92); }
.req { background: rgb(255, 255, 255); border: 1px solid rgb(222, 222, 218); border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
.line { margin: 2px 0; }
.m { font-weight: bold; }
.s-ok { color: rgb(20, 110, 50); font-weight: bold; }
.s-bad { color: rgb(170, 30, 30); font-weight: bold; }
</style></head><body><h1>slack-compat door on the live site</h1><p>Mint a pairing token, post the root, deliver the reply through the public door, revoke.</p>${blocks.map(blockHtml).join('')}</body></html>`;
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true, animations: 'disabled' });
}

test('p5-01 door delivery on live', async ({ browser }) => {
  const page = await signIn(browser);
  const headers = await csrfHeaders(page);
  const blocks: StoryBlock[] = [];

  // The coder row has lived on live since P5-04; a fresh deploy keeps the table,
  // so this mint is a 201 — a 404 would mean the loader never saw a BOT.md commit.
  const mintRes = await page.request.post(MINT_URL, { headers });
  expect(mintRes.status(), 'mint a pairing token for coder on live').toBe(201);
  const minted = (await mintRes.json()) as { token: string };
  blocks.push({ method: 'POST', url: MINT_URL, status: 201, body: JSON.stringify({ token: minted.token }) });

  const dirRes = await page.request.get('/api/teams/engineering/channels', { headers });
  expect(dirRes.status(), 'read the engineering directory on live').toBe(200);
  const dir = (await dirRes.json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> };
  const devId = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'dev')?.id;
  expect(devId, 'the #dev channel id on live').toBeTruthy();

  const rootRes = await page.request.post(`/api/channels/${devId}/messages`, {
    headers,
    data: { channelId: devId, body: ROOT_TEXT, threadRootId: null },
  });
  expect(rootRes.status(), 'post the root message on live').toBe(201);
  const rootId = ((await rootRes.json()) as { id: string }).id;
  blocks.push({ method: 'POST', url: `/api/channels/<dev>/messages`, status: 201, body: JSON.stringify({ threadRootId: null }) });

  // The spike path itself: no session, no cookies — a fresh anonymous context, the
  // shape Hermes calls with. (page.request would carry the sign-in session cookie,
  // and the host answers cookie-without-CSRF with 403 by design.)
  const anon = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const doorRes = await anon.request.post(`${BASE}${DOOR_URL}`, {
    data: { token: minted.token, channel: devId, thread_ts: rootId, text: REPLY_TEXT },
  });
  await anon.close();
  expect(doorRes.status(), 'deliver through the public door on live').toBe(200);
  const door = (await doorRes.json()) as { ts: string };
  blocks.push({ method: 'POST', url: DOOR_URL, status: 200, body: JSON.stringify({ ok: true, ts: door.ts }) });

  // The reply reads back through the normal messages API, then on screen.
  let found = false;
  for (let i = 0; i < 10 && !found; i += 1) {
    const listRes = await page.request.get(`/api/channels/${devId}/messages`, {
      headers,
      params: { threadRootId: rootId, limit: '50' },
    });
    if (listRes.status() === 200) {
      const items = ((await listRes.json()) as { items: Array<{ body: string }> }).items;
      found = items.some((m) => m.body === REPLY_TEXT);
    }
    if (!found) await page.waitForTimeout(1000);
  }
  expect(found, 'the door reply is readable in the thread on live').toBe(true);

  await page.goto(`/t/engineering/c/dev?panel=thread:${rootId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('thread-view')).toContainText(REPLY_TEXT, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, 'p5-01-thread.png'), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });

  const revokeRes = await page.request.delete(MINT_URL, { headers });
  expect(revokeRes.status(), 'revoke the minted token').toBe(200);
  blocks.push({ method: 'DELETE', url: MINT_URL, status: 200, body: await revokeRes.text() });

  await renderStory(page, 'p5-01-door-api', blocks);
  await page.context().close();
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
