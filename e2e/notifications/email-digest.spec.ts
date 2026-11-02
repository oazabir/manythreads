import { createServer, type Server } from 'node:net';
import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * The email digest (PLAN P14-09, docs/plugins/notifications.md). Rafi has been away and has an unread mention: ONE email arrives with the mention, a link
 * to the message and a signed unsubscribe link; its headers are the ones mail programs use for one-click unsubscribe (RFC 8058). The link opens a page that
 * changes nothing until its button is pressed, the button turns the digest off, and Account -> Notifications ("Email me what I missed") shows it off and
 * turns it back on. The stack has no mail catcher, so this spec runs a small SMTP sink of its own and points the server at it.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the digest is an email and a settings block');

const T = { timeout: 15_000 };
const ACCOUNT_ANCHOR = 'acc-notifications';   // joined with # where used: the lint rule against raw hex colours reads "#acc" as one

interface Received {
  headers: string;
  body: string;
}

/** A tiny SMTP server that accepts every message and keeps it (no TLS, no auth: the server's `smtp://127.0.0.1:<port>` mailer talks plain SMTP). */
async function startSmtpSink(): Promise<{ port: number; received: Received[]; close(): Promise<void> }> {
  const received: Received[] = [];
  const server: Server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 sink ESMTP\r\n');
    let buffer = '';
    let data: string | null = null;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          const text = data.replace(/^\.\./gm, '.');
          const split = text.indexOf('\r\n\r\n');
          received.push({ headers: text.slice(0, split < 0 ? text.length : split), body: split < 0 ? '' : text.slice(split + 4) });
          data = null;
          socket.write('250 queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 sink\r\n');
        else if (verb === 'DATA') {
          data = '';
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
          return;
        } else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { port, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Quoted-printable back to text (soft line breaks and =XX), and folded header lines back to one line. */
const decoded = (m: Received): { headers: string; body: string } => ({
  headers: m.headers.replace(/\r\n[ \t]+/g, ' '),
  body: m.body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))),
});

let stack: Stack;
let sink: Awaited<ReturnType<typeof startSmtpSink>>;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;
let dev = '';
let unsubscribeUrl = '';

const mailsTo = (address: string): Received[] => sink.received.filter((m) => new RegExp(`^To:.*${address}`, 'im').test(m.headers.replace(/\r\n[ \t]+/g, ' ')));
const runDigestNow = async (): Promise<void> => {
  // The job also runs every minute on its own; this only saves the wait.
  await stack.sql("SELECT id FROM app.enqueue_job('notifications.digest', '{}'::jsonb, NULL, NULL)").catch(() => undefined);
};

test.beforeAll(async ({ playwright }) => {
  sink = await startSmtpSink();
  stack = await startStack({ MANYTHREADS_SMTP_URL: `smtp://127.0.0.1:${sink.port}` });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  dev = ((await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'digest-room' })).channel.id);
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
  await sink?.close();
});

test('Account shows "Email me what I missed", on by default, and keeps a change', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/account');
  try {
    const block = page.getByTestId('notification-digest');
    await expect(block).toBeVisible(T);
    await expect(block.getByRole('heading', { name: 'Email me what I missed' })).toBeVisible();
    const toggle = block.getByRole('switch', { name: 'Send me an email about what I missed' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true', T);
    const delay = block.getByLabel('How long away before the email');
    await expect(delay).toHaveValue('60');
    await expect(delay.locator('option')).toHaveText(['30 minutes', '1 hour', '2 hours', '4 hours', '8 hours', '24 hours']);
    await expect(block.getByTestId('digest-help')).toContainText('away for 1 hour');

    await delay.selectOption('120');
    await expect(block.getByTestId('digest-help')).toContainText('away for 2 hours', T);
    await page.reload();
    await expect(page.getByTestId('notification-digest').getByLabel('How long away before the email')).toHaveValue('120', T);
    expect(await rafi.get('/api/notifications/digest')).toMatchObject({ enabled: true, delayMinutes: 120, emailAvailable: true });

    // back to an hour, so the next test is the default case
    await page.getByTestId('notification-digest').getByLabel('How long away before the email').selectOption('60');
    await expect(page.getByTestId('digest-help')).toContainText('away for 1 hour', T);
  } finally {
    await context.close();
  }
});

test('a person who has been away gets one email with the mention, a link and the one-click headers', async () => {
  // Rafi is away: no heartbeat (the API sign-in sends none and no tab is open). Nadia mentions him twice in one room; he reads neither.
  await stack.sql('DELETE FROM app.presence');
  // The digest waits five minutes after the heartbeat data starts (a fresh stack has just started it): say it started long ago.
  await stack.sql("INSERT INTO app.presence_epoch (id, started_at) VALUES (true, now() - interval '10 minutes') ON CONFLICT (id) DO UPDATE SET started_at = EXCLUDED.started_at");
  await postAs(nadia, dev, '@rafi the staging deploy is red, can you look? <b>not bold</b>');
  await postAs(nadia, dev, '@rafi and the rollback plan is in the wiki');
  await runDigestNow();
  await expect.poll(() => mailsTo('rafi@kahf.example').length, { timeout: 110_000, intervals: [1_000, 2_000, 5_000] }).toBeGreaterThan(0);
  // wait for any second one that should not come, then count
  await runDigestNow();
  await new Promise((r) => setTimeout(r, 3_000));
  const mails = mailsTo('rafi@kahf.example');
  expect(mails).toHaveLength(1);
  const { headers, body } = decoded(mails[0]!);

  expect(headers).toMatch(/^Subject: 2 new messages for you$/im);
  const listUnsubscribe = /^List-Unsubscribe: <([^>]+)>$/im.exec(headers);
  expect(listUnsubscribe, headers).not.toBeNull();
  expect(headers).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/im);
  unsubscribeUrl = listUnsubscribe![1]!;
  expect(unsubscribeUrl).toBe(`${stack.origin}/api/notifications/digest/unsubscribe/${/unsubscribe\/(v1\.[0-9a-f-]+\.[A-Za-z0-9_-]+)/.exec(unsubscribeUrl)![1]}`);

  expect(body).toContain('#digest-room');
  expect(body).toContain('the staging deploy is red');
  expect(body).toContain('and the rollback plan is in the wiki');
  expect(body).toContain(`${stack.origin}/open?channel=${dev}&message=`);
  expect(body).toContain(unsubscribeUrl);
  // markup somebody wrote never reaches the mail as markup (the stored preview is plain text, and the HTML part escapes it again: unit-tested)
  const html = body.slice(body.search(/Content-Type: text\/html/i));
  expect(html).toContain('not bold');
  expect(html).not.toContain('<b>');
  // nobody else had anything unread
  expect(mailsTo('nadia@kahf.example')).toHaveLength(0);
  expect(mailsTo('omar@kahf.example')).toHaveLength(0);
});

test('the unsubscribe link asks first, and the button turns the digest off for that person only', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto(unsubscribeUrl);
    await expect(page.getByRole('heading', { name: 'Stop these emails?' })).toBeVisible(T);
    expect((await rafi.get<{ enabled: boolean }>('/api/notifications/digest')).enabled).toBe(true);   // a visit alone changed nothing
    await page.getByRole('button', { name: 'Stop these emails' }).click();
    await expect(page.getByRole('heading', { name: 'You will no longer get these emails' })).toBeVisible(T);
    await expect(page.getByRole('link', { name: 'Turn them back on' })).toHaveAttribute('href', `${stack.origin}/account#${ACCOUNT_ANCHOR}`);
    expect((await rafi.get<{ enabled: boolean }>('/api/notifications/digest')).enabled).toBe(false);
    expect((await nadia.get<{ enabled: boolean }>('/api/notifications/digest')).enabled).toBe(true);

    // the same link again says the same thing; the mail program's own POST works without a session and is harmless a second time
    await page.goto(unsubscribeUrl);
    await expect(page.getByRole('heading', { name: 'You will no longer get these emails' })).toBeVisible(T);
    const anonymous = await browser.newContext();
    try {
      const post = await anonymous.request.post(unsubscribeUrl, { form: { 'List-Unsubscribe': 'One-Click' } });
      expect(post.status()).toBe(200);
      expect(await post.json()).toEqual({ unsubscribed: true });
    } finally {
      await anonymous.close();
    }

    // a link with a changed signature is refused with a plain page
    const bad = unsubscribeUrl.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    await page.goto(bad);
    await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible(T);
  } finally {
    await context.close();
  }
});

test('while it is off nothing is sent, and Account turns it back on', async ({ browser, playwright }) => {
  const before = mailsTo('rafi@kahf.example').length;
  await stack.sql('DELETE FROM app.presence');
  await postAs(nadia, dev, '@rafi one more thing, written while the emails are off');
  await runDigestNow();
  await new Promise((r) => setTimeout(r, 6_000));
  expect(mailsTo('rafi@kahf.example')).toHaveLength(before);

  const { page, context } = await openOn(browser, playwright, stack, 'rafi', `/account#${ACCOUNT_ANCHOR}`);
  try {
    const block = page.getByTestId('notification-digest');
    const toggle = block.getByRole('switch', { name: 'Send me an email about what I missed' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false', T);
    await expect(block.getByTestId('digest-help')).toContainText('Off.');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true', T);
    await expect(block.getByTestId('digest-status')).toHaveText('Saved.', T);
    await expect(toggle).toBeFocused();                                       // saving did not take keyboard focus away
    expect((await rafi.get<{ enabled: boolean }>('/api/notifications/digest')).enabled).toBe(true);
  } finally {
    await context.close();
  }
});
