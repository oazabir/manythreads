import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P8-36, the support journey, shot on the live site. The story the e2e spec (e2e/email/support-journey.spec.ts) proves with a scripted Hermes, here with the
 * team's real bots: Omar looks at the two mail bots, the knowledge base `manuals` and the mail connection `support-mail`, a customer's email comes in through the
 * admin delivery door of the dummy mailbox, the Support email bot posts it in #support-inbox, the Customer support bot answers from the manuals, the reply waits in the
 * Approvals inbox, Sameera or Omar approves it and one mail leaves the mailbox. Then a second customer asks something the manuals do not cover: the case goes to a person
 * and nothing is sent. The last picture is the phone.
 *
 * It needs the Customer support team made from the template (its bots `support-email` and `customer-support`, the channel #support-inbox) and its two bots answering
 * (their runner up). It makes what is missing and nothing else: the connection `support-mail` (a placeholder credential: the mailbox is the dummy one) and, when the base
 * `manuals` has no document, one small FAQ file that is removed again at the end. The two mails stay in the dummy mailbox as a record (their customers are `.example`
 * addresses). It POSTS real messages and approves one real approval on the live site. Deploy, when the bot page has the button (P8-34), is shot too.
 * Environment: MANYTHREADS_LIVE_PASSWORD (the screenshot password, from the environment only), MANYTHREADS_LIVE_URL, MANYTHREADS_JOURNEY_TEAM (default customer-support).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.p8-email.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p8-email-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const TEAM = process.env['MANYTHREADS_JOURNEY_TEAM'] ?? 'customer-support';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const WAIT_BOT_MS = 240_000;
const RAND = Date.now().toString(36);
const SUPPORT_ADDRESS = 'support@journey.example';
const CUSTOMER = `ayesha-${RAND}@customer.example`;
const OTHER_CUSTOMER = `bilal-${RAND}@customer.example`;
const FAQ_NAME = `Journey FAQ ${RAND}.md`;
const FAQ = `# Orders and delivery\n\n## Changing your delivery address\n\nYou can change the delivery address of an order until it has shipped. Open the order in your account, choose Change delivery address and save the new address. Once the order has shipped, contact the carrier with your tracking number.\n`;

type Res = { status: number; text: string; json: unknown };
interface Api {
  get: (path: string) => Promise<Res>;
  post: (path: string, data?: unknown) => Promise<Res>;
  send: (method: 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown) => Promise<Res>;
  upload: (path: string, body: Buffer, type: string) => Promise<Res>;
}
interface Message {
  id: string;
  body: string;
  threadRootId: string | null;
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);
test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
});

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE,
    ignoreHTTPSErrors: true,
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
  const csrf = async (): Promise<string> => (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const parse = async (res: Awaited<ReturnType<Page['request']['get']>>): Promise<Res> => {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status(), text, json };
  };
  return {
    get: async (p) => parse(await page.request.get(p)),
    post: async (p, d) => parse(await page.request.post(p, { data: d ?? {}, headers: { 'x-csrf-token': await csrf() } })),
    send: async (m, p, d) => parse(await page.request.fetch(p, { method: m, data: d ?? {}, headers: { 'x-csrf-token': await csrf() } })),
    upload: async (p, body, type) => parse(await page.request.post(p, { data: body, headers: { 'x-csrf-token': await csrf(), 'content-type': type } })),
  };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `p8-email-${name}.png`), animations: 'disabled' });
}

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(ms / 1000)} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
};

let omar: Page;
let omarApi: Api;
let inboxChannelId = '';
let inboxChannelName = 'support-inbox';
let approvalId = '';
let rootId = '';
let escalationRootId = '';
let addedFaq = '';

const messages = async (threadRootId?: string): Promise<Message[]> =>
  ((await omarApi.get(`/api/channels/${inboxChannelId}/messages?limit=100${threadRootId ? `&threadRootId=${threadRootId}` : ''}`)).json as { items?: Message[] } | null)?.items ?? [];
const pending = async (): Promise<Array<{ id: string; tool: string; summary: string }>> =>
  ((await omarApi.get(`/api/teams/${TEAM}/approvals?status=pending`)).json as { items?: Array<{ id: string; tool: string; summary: string }> } | null)?.items ?? [];

test('0 · the team, the two bots, the base and the connection are there (what is missing is made)', async ({ browser }) => {
  omar = await signIn(browser, 'omar');
  omarApi = apiOf(omar);

  const bots = ((await omarApi.get(`/api/teams/${TEAM}/bots`)).json as { bots?: Array<{ slug: string; status: string }> } | null)?.bots ?? [];
  for (const slug of ['support-email', 'customer-support']) {
    expect(bots.find((b) => b.slug === slug)?.status, `the bot ${slug} is active on ${TEAM} (make the team from the Customer support template first)`).toBe('active');
  }
  const groups = ((await omarApi.get(`/api/teams/${TEAM}/channels`)).json as { groups?: Array<{ channels: Array<{ id: string; name: string }> }> } | null)?.groups ?? [];
  const inbox = groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'support-inbox');
  expect(inbox, '#support-inbox exists').toBeTruthy();
  inboxChannelId = inbox!.id;
  inboxChannelName = inbox!.name.replace(/^#/, '');

  // the base: when it has no document, one small FAQ is added (and removed at the end)
  const base = await omarApi.get(`/api/teams/${TEAM}/knowledge/manuals`);
  if (base.status === 404) expect((await omarApi.post(`/api/teams/${TEAM}/knowledge`, { slug: 'manuals', name: 'Manuals' })).status).toBeLessThan(300);
  const docs = ((await omarApi.get(`/api/teams/${TEAM}/knowledge/manuals`)).json as { documents?: unknown[] } | null)?.documents ?? [];
  if (docs.length === 0) {
    const up = await omarApi.upload(`/api/teams/${TEAM}/knowledge/manuals/documents?name=${encodeURIComponent(FAQ_NAME)}`, Buffer.from(FAQ), 'text/markdown');
    expect(up.status, up.text).toBeLessThan(300);
    addedFaq = ((up.json as { document?: { id?: string } } | null)?.document?.id) ?? '';
  }

  // the connection: the dummy mailbox, with a placeholder credential, switched on
  const connections = ((await omarApi.get(`/api/teams/${TEAM}/connections`)).json as { connections?: Array<{ id: string; slug: string; status: string }> } | null)?.connections ?? [];
  let mail = connections.find((c) => c.slug === 'support-mail');
  if (!mail) {
    const created = await omarApi.post(`/api/teams/${TEAM}/connections`, { kind: 'email', name: 'Support mailbox', slug: 'support-mail' });
    expect(created.status, created.text).toBe(201);
    mail = (created.json as { connection: { id: string; slug: string; status: string } }).connection;
    expect((await omarApi.send('PUT', `/api/connections/${mail.id}/credentials/password`, { value: 'placeholder-for-the-dummy-mailbox' })).status).toBe(200);
  }
  if (mail.status !== 'enabled') expect((await omarApi.send('PATCH', `/api/connections/${mail.id}`, { status: 'enabled' })).status).toBe(200);
});

test('1 · the two bots, the knowledge base and the mail connection', async () => {
  await omar.goto(`/t/${TEAM}/bots`);
  await expect(omar.locator('[data-testid="bot-row"][data-bot="support-email"]')).toBeVisible(T);
  await expect(omar.locator('[data-testid="bot-row"][data-bot="customer-support"]')).toBeVisible(T);
  await shot(omar, '01-the-two-mail-bots');

  await omar.goto(`/t/${TEAM}/bots/customer-support?tab=knowledge`);
  await expect(omar.getByTestId('knowledge-base').first()).toBeVisible(T);
  await shot(omar, '02-manuals-knowledge-base');

  await omar.goto(`/settings/team/${TEAM}/connections`);
  await expect(omar.locator('[data-testid="connection-row"][data-connection="support-mail"]')).toBeVisible(T);
  await shot(omar, '03-support-mail-connection');

  await omar.goto(`/t/${TEAM}/bots/support-email`);
  await expect(omar.getByTestId('bot-page')).toBeVisible(T);
  // Deploy (P8-34): shot only when this build of the bot page has the button
  const deploy = omar.getByTestId('bot-deploy');
  if ((await deploy.count()) > 0) {
    await deploy.click();
    await expect(omar.getByTestId('deploy-result')).toBeVisible({ timeout: 60_000 });
    await shot(omar, '04-deploy-three-outcomes');
  } else {
    await shot(omar, '04-support-email-bot-page');
  }
});

test('2 · a customer’s email comes in; the Support email bot posts it and tags the Customer support bot', async () => {
  const sent = await omarApi.post(`/api/teams/${TEAM}/connections/support-mail/mail`, {
    from: CUSTOMER,
    to: SUPPORT_ADDRESS,
    subject: `Change my delivery address (${RAND})`,
    body: 'Hello, how do I change the delivery address of my order? I moved house last week. Thanks, Ayesha',
    messageRef: `<journey-${RAND}-1@customer.example>`,
  });
  expect(sent.status, sent.text).toBe(201);

  const post = await until(async () => (await messages()).find((m) => m.threadRootId === null && m.body.includes(CUSTOMER)), WAIT_BOT_MS, 'the Support email bot to post the mail in #support-inbox');
  rootId = post.id;
  expect(post.body).toContain('@customer-support');
  await omar.goto(`/t/${TEAM}/c/${inboxChannelName}`);
  await expect(omar.getByTestId('message').filter({ hasText: CUSTOMER }).first()).toBeVisible(T);
  await shot(omar, '05-the-mail-in-support-inbox');
});

test('3 · the Customer support bot answers from the manuals; the reply waits in the Approvals inbox', async () => {
  const answer = await until(async () => (await messages(rootId)).find((m) => m.id !== rootId && m.body.includes('@support-email')), WAIT_BOT_MS, 'the Customer support bot to answer and tag the Support email bot');
  expect(answer.body.toLowerCase()).toContain('shipped');
  await omar.goto(`/t/${TEAM}/c/${inboxChannelName}?thread=${rootId}`);
  await expect(omar.getByTestId('thread-view')).toBeVisible(T);
  await shot(omar, '06-answer-in-the-thread');

  const card = await until(async () => (await pending()).find((a) => a.tool === 'email.send' && a.summary.includes(CUSTOMER)), WAIT_BOT_MS, 'the send to be held for approval');
  approvalId = card.id;
  await omar.goto(`/t/${TEAM}/approvals?approval=${approvalId}`);
  await expect(omar.getByTestId('approval-card')).toBeVisible(T);
  await expect(omar.getByTestId('approval-summary')).toContainText(CUSTOMER);
  await shot(omar, '07-reply-waits-for-approval');
});

test('4 · a person approves; exactly one mail leaves the mailbox', async () => {
  await omar.getByTestId('approval-approve').click();
  await expect(omar.getByTestId('approval-state')).toHaveAttribute('data-status', 'approved', T);
  await expect(omar.getByTestId('approval-outcome')).toContainText(/sent|ran|done|made/i, { timeout: 120_000 });
  await shot(omar, '08-approved-and-sent');
  const left = (await pending()).filter((a) => a.id === approvalId);
  expect(left).toEqual([]);
});

test('5 · the escalation branch: the manuals do not cover it, a person gets it, the customer gets no mail', async () => {
  const before = (await pending()).length;
  const sent = await omarApi.post(`/api/teams/${TEAM}/connections/support-mail/mail`, {
    from: OTHER_CUSTOMER,
    to: SUPPORT_ADDRESS,
    subject: `Gift cards for my grandmother (${RAND})`,
    body: 'Hello, do you sell gift cards? It is my grandmother’s birthday next week. Thanks, Bilal',
    messageRef: `<journey-${RAND}-2@customer.example>`,
  });
  expect(sent.status, sent.text).toBe(201);
  const post = await until(async () => (await messages()).find((m) => m.threadRootId === null && m.body.includes(OTHER_CUSTOMER)), WAIT_BOT_MS, 'the Support email bot to post the second mail');
  escalationRootId = post.id;
  const handover = await until(async () => (await messages(escalationRootId)).find((m) => m.id !== escalationRootId), WAIT_BOT_MS, 'the Customer support bot to answer');
  expect(handover.body, 'the bot hands the case to a person and does not tag the Support email bot').not.toContain('@support-email');
  await omar.goto(`/t/${TEAM}/c/${inboxChannelName}?thread=${escalationRootId}`);
  await expect(omar.getByTestId('thread-view')).toBeVisible(T);
  await shot(omar, '09-escalated-to-a-person');

  // no card for this customer: wait a little longer than a send would take, then look
  await omar.waitForTimeout(20_000);
  const cards = await pending();
  expect(cards.filter((a) => a.summary.includes(OTHER_CUSTOMER))).toEqual([]);
  expect(cards.length).toBe(before);
});

test('6 · the phone: the thread and the Approvals inbox', async ({ browser }) => {
  const phone = await signIn(browser, 'omar', true);
  try {
    await phone.goto(`/t/${TEAM}/c/${inboxChannelName}?thread=${rootId}`);
    await expect(phone.getByTestId('thread-view')).toBeVisible(T);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no sideways scroll on the phone').toBe(true);
    await shot(phone, '10-phone-thread');
    await phone.goto(`/t/${TEAM}/approvals?approval=${approvalId}`);
    await expect(phone.getByTestId('approvals-inbox')).toBeVisible(T);
    await shot(phone, '11-phone-approvals');
  } finally {
    await phone.context().close();
  }
});

test.afterAll(async () => {
  if (addedFaq !== '' && omarApi) await omarApi.send('DELETE', `/api/teams/${TEAM}/knowledge/manuals/documents/${addedFaq}`).catch(() => undefined);
  await omar?.context().close();
  rebuildGallery();
});

/** Rebuilds the gallery over the whole output folder, so it shows every task's screenshots, not only this run's. */
function rebuildGallery(): void {
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
}
