import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { apiOn, channelsOf, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';
import { ORCHESTRATE } from './scripts.ts';
import { startRunsWorld, type RunsWorld } from './support.ts';

/*
 * The thread's side rail (PLAN P29-20, P29-21; docs/plans/channel-task-view.md section 10e). The world is the `runs` stack. What is real: the thread, the bot's `tasks.todo`, its
 * live run, the pictures and files uploaded to the channel and attached to replies, the files read of the threads plugin, the pushes and the web client. Pictures (Graphite dark,
 * Linen light; beside the messages at 1440 px, as an overlay sheet at 1100 px, as a bottom sheet at 390 px) go to temp/screenshots/p29 (git-ignored).
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);
test.skip(({ isMobile }) => isMobile, 'the stack is driven once; the narrow views are opened inside the tests');

const SHOTS = join(import.meta.dirname, '..', '..', 'temp', 'screenshots', 'p29');
// the Threads list takes 420 px and the sidebar 248, so the thread's pane is about 430 px wide at 1100 px: narrow enough for the overlay sheet
const TABLET = { width: 1100, height: 900 } as const;
let world: RunsWorld;
let dev = '';
let nadia: StackApi;
let omar: StackApi;
let lead: { id: string };
let token = '';
let root = '';

test.beforeAll(async ({ playwright }) => {
  mkdirSync(SHOTS, { recursive: true });
  world = await startRunsWorld();
  nadia = await apiOn(playwright, world.stack, 'nadia');
  omar = await apiOn(playwright, world.stack, 'omar');
  dev = (await channelsOf(nadia))['dev']!;
});
test.afterAll(async () => {
  await nadia?.ctx.dispose();
  await omar?.ctx.dispose();
  // the world's temp folder may still be written to when it is removed (ENOTEMPTY); the run itself is over
  await world?.close().catch((e: unknown) => {
    if (!String(e).includes('ENOTEMPTY')) throw e;
  });
});

async function openRun(slug: string): Promise<void> {
  await expect
    .poll(async () => (await world.stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bot_runs r JOIN app.bots b ON b.id = r.bot_id WHERE b.slug = $1 AND r.ended_at IS NULL`, [slug]))[0]?.n)
    .toBe('1');
}

async function tool(id: number, args: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${world.stack.origin}/api/mcp/bots/${lead.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'tasks.todo', arguments: args } }),
  });
  expect(JSON.stringify(await res.json()), 'tasks.todo').not.toContain('"isError":true');
}

async function look(palette: string, theme: string): Promise<void> {
  const res = await nadia.ctx.put('/api/me/appearance', { data: { palette, theme }, headers: await nadia.headers() });
  expect(res.status(), await res.text()).toBe(200);
}

// a small real PNG (a gradient), so the server's check of the first bytes passes and a preview has something to draw
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer): number => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(w: number, h: number, hue: number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      row[1 + x * 3] = Math.round((x / w) * 200 + hue) % 256;
      row[2 + x * 3] = Math.round((y / h) * 200);
      row[3 + x * 3] = (hue * 3) % 256;
    }
    rows.push(row);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** Omar uploads the files to the channel and posts a reply in the thread that carries them. */
async function reply(api: StackApi, body: string, files: Array<{ name: string; mime: string; bytes: Buffer }>): Promise<string> {
  const ids: string[] = [];
  for (const f of files) {
    const res = await api.ctx.post(`/api/channels/${dev}/files`, {
      data: f.bytes,
      headers: { ...(await api.headers()), 'content-type': f.mime, 'x-file-name': encodeURIComponent(f.name) },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    ids.push(((await res.json()) as { id: string }).id);
  }
  const res = await api.ctx.post(`/api/channels/${dev}/messages`, { data: { channelId: dev, body, threadRootId: root, attachments: ids }, headers: await api.headers() });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const rail = (page: Page) => page.getByTestId('thread-rail');
const box = async (page: Page, testId: string) => (await page.getByTestId(testId).boundingBox())!;

test('the rail opens and closes, is remembered, and the list in it follows the bot live', async ({ browser, playwright }) => {
  await look('graphite', 'light');
  world.script(ORCHESTRATE);
  lead = await world.bot('run-lead');
  root = (await postAs(nadia, dev, '@run-lead build the run card and test it')).id;
  await postAs(omar, dev, 'I will look at the colours meanwhile.', root);
  await openRun('run-lead');
  token = (await omar.post<{ token: string }>('/api/teams/engineering/bots/run-lead/pairing-tokens', {})).token;
  await tool(1, {
    action: 'set',
    title: 'Run card',
    items: [
      { id: 'plan', text: 'Plan the parts', status: 'done' },
      { id: 'build', text: 'Build the run card', status: 'working' },
      { id: 'docs', text: 'Write the notes', status: 'waiting' },
      { id: 'ship', text: 'Tell the team', status: 'waiting' },
    ],
  });

  const opened = await openOn(browser, playwright, world.stack, 'nadia', `/t/engineering/threads?thread=${root}`);
  const page = opened.page;
  try {
    const toggle = page.getByTestId('rail-toggle');
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    // closed to begin with: the button says so for a screen reader and points at the rail
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(rail(page)).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(rail(page)).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-controls', (await rail(page).getAttribute('id'))!);
    // a complementary landmark with a name
    await expect(page.getByRole('complementary', { name: 'Thread overview' })).toBeVisible();

    // beside the messages at this width: the rail does not cover the replies
    const col = await page.locator('.thread-col').boundingBox();
    const r = await rail(page).boundingBox();
    expect(r!.x, 'beside, not over').toBeGreaterThanOrEqual(col!.x + col!.width - 1);
    expect(Math.round(r!.width)).toBe(300);

    // the list as a timeline: the step in progress is marked, with its stage
    await expect(page.getByTestId('rail-count')).toHaveText('1 of 4 done', { timeout: 30_000 });
    await expect(rail(page).locator('.trChip')).toHaveText('In progress');
    const current = rail(page).locator('[data-testid="rail-step"][data-current="true"]');
    await expect(current).toContainText('Build the run card');
    await expect(current.getByTestId('rail-stage')).toContainText('Working on it');
    await expect(rail(page).getByTestId('rail-step')).toHaveCount(4);
    // the dock keeps one line while the rail has the details
    await expect(page.getByTestId('dock-line-rail')).toBeVisible();
    await expect(page.getByTestId('tv-todo')).toHaveCount(0);
    // nothing attached yet
    await expect(page.getByTestId('rail-no-files')).toBeVisible();

    // the bot ticks a step: the rail follows without a reload; the finished steps fold
    await tool(2, { action: 'update', id: 'build', status: 'done' });
    await expect(page.getByTestId('rail-count')).toHaveText('2 of 4 done', { timeout: 30_000 });
    await expect(page.getByTestId('rail-earlier')).toHaveText('2 earlier steps');
    await expect(rail(page).locator('[data-testid="rail-step"][data-current="true"]')).toContainText('Write the notes');
    await page.getByTestId('rail-earlier').click();
    await expect(page.getByTestId('rail-earlier-list').getByTestId('rail-step')).toHaveCount(2);
    await tool(3, { action: 'update', id: 'docs', status: 'blocked' });
    await expect(rail(page).locator('.trChip')).toHaveText('Waiting', { timeout: 30_000 });
    await tool(4, { action: 'update', id: 'docs', status: 'working' });
    await expect(rail(page).locator('.trChip')).toHaveText('In progress', { timeout: 30_000 });

    // remembered: open after a reload; the x closes it and that is remembered too
    await page.reload();
    await expect(rail(page)).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('rail-close').click();
    await expect(rail(page)).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('tv-todo')).toBeVisible(); // the dock has its cards back
    await page.reload();
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(rail(page)).toHaveCount(0);
    // the keyboard: Enter on the button opens it, Escape inside the rail closes it
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(rail(page)).toBeVisible();
    await page.getByTestId('rail-close').focus();
    await page.keyboard.press('Escape');
    await expect(rail(page)).toHaveCount(0);
  } finally {
    await opened.context.close();
  }
});

test('Outputs: an attachment appears live with a preview, the newest two pictures are previews, the rest a list', async ({ browser, playwright }) => {
  await look('graphite', 'light');
  const opened = await openOn(browser, playwright, world.stack, 'nadia', `/t/engineering/threads?thread=${root}`);
  const page = opened.page;
  try {
    await page.getByTestId('rail-toggle').click();
    await expect(page.getByTestId('rail-no-files')).toBeVisible({ timeout: 30_000 });
    // Omar attaches a picture: it is in the rail without a reload, as a preview named by its file
    await reply(omar, 'Here is the first screenshot', [{ name: 'first.png', mime: 'image/png', bytes: png(320, 240, 10) }]);
    const previews = page.getByTestId('rail-previews');
    await expect(previews).toHaveAttribute('data-count', '1', { timeout: 30_000 });
    const img = previews.locator('img');
    await expect(img).toHaveAttribute('alt', 'first.png');
    await expect(img).toHaveAttribute('loading', 'lazy');
    await expect.poll(() => img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth)).toBe(320);
    // a PDF and a second and third picture
    await reply(omar, 'The report, and two more pictures', [
      { name: 'report.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n%the report\n'.repeat(200)) },
      { name: 'second.png', mime: 'image/png', bytes: png(320, 240, 90) },
    ]);
    await reply(omar, 'And the third', [{ name: 'third.png', mime: 'image/png', bytes: png(320, 240, 170) }]);
    await expect(previews).toHaveAttribute('data-count', '2', { timeout: 30_000 });
    // the two newest pictures, newest first; the older picture and the PDF are in the list
    await expect(previews.locator('img')).toHaveCount(2);
    await expect(previews.locator('img').first()).toHaveAttribute('alt', 'third.png');
    await expect(previews.locator('img').nth(1)).toHaveAttribute('alt', 'second.png');
    const files = page.getByTestId('rail-files').getByTestId('rail-file');
    await expect(files).toHaveCount(2);
    await expect(files.first()).toContainText('report.pdf');
    await expect(files.first()).toContainText('PDF');
    await expect(files.nth(1)).toContainText('first.png');
    await expect(page.getByTestId('rail-outputs').locator('.trHCount')).toHaveText('4');
    // a preview opens the picture in the viewer; Escape closes it
    await previews.locator('button').first().click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('image-lightbox')).toHaveCount(0);
    // a person who may not read the thread's files is shown none: the route answers as the caller
    const res = await omar.ctx.get(`/api/threads/${root}/files?limit=2`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(4);
  } finally {
    await opened.context.close();
  }
});

test('every look and width: beside, over as a sheet, and a bottom sheet at 390 px', async ({ browser, playwright }) => {
  for (const [palette, theme] of [['graphite', 'dark'], ['linen', 'light']] as const) {
    await look(palette, theme);
    for (const [name, viewport, mobile] of [['wide', { width: 1440, height: 900 }, false], ['narrow', TABLET, false], ['phone', PHONE, true]] as const) {
      const opened = await openOn(browser, playwright, world.stack, 'nadia', `/t/engineering/threads?thread=${root}`, { viewport, mobile });
      const page = opened.page;
      try {
        const toggle = page.getByTestId('rail-toggle');
        await expect(toggle).toBeVisible({ timeout: 60_000 });
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await expect(rail(page)).toBeVisible();
        await expect(page.getByTestId('rail-previews')).toHaveAttribute('data-count', '2', { timeout: 30_000 });
        await expect.poll(() => page.locator('[data-testid="rail-preview"] img').evaluateAll((l) => l.every((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0))).toBe(true);
        expect(await noSidewaysScroll(page), `${palette} ${name}: no sideways scroll`).toBe(true);
        const col = (await page.locator('.thread-col').boundingBox())!;
        const r = (await rail(page).boundingBox())!;
        if (name === 'wide') expect(r.x, 'beside the messages').toBeGreaterThanOrEqual(col.x + col.width - 1);
        if (name === 'narrow') {
          expect(r.x, 'over the messages').toBeLessThan(col.x + col.width - 100);
          expect(r.height, 'the sheet is as tall as the thread').toBeGreaterThan(400);
        }
        if (name === 'phone') {
          expect(Math.round(r.width), 'a bottom sheet is as wide as the screen').toBeGreaterThanOrEqual(PHONE.width - 2);
          expect(r.y + r.height, 'on the bottom edge').toBeGreaterThan(PHONE.height - 60);
          const close = (await box(page, 'rail-close'));
          expect(close.height, 'a 44 px target').toBeGreaterThanOrEqual(43);
        }
        await page.screenshot({ path: join(SHOTS, `thread-rail.${name}.${palette}.${theme}.png`) });
      } finally {
        await opened.context.close();
      }
    }
  }
  await look('graphite', 'light');
});
