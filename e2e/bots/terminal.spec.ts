import { expect, test } from '@playwright/test';
import { addBot, conversationStackEnv } from '../conversations/support.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * The terminal into a bot's sandbox in the browser (PLAN P7-09): a workspace admin opens it from the Workshop tab, types into a real shell that runs as an ordinary user with no network,
 * ends it, and finds the recording with secrets masked. A plain member does not even see the way in, and the server refuses them. Both layouts. The terminal is off unless the server is told
 * to allow it, so the stack turns it on; where the machine cannot build the sandbox (it needs Linux, Python 3 and the root user) the spec skips and says why.
 */
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let available = false;
let why = '';

const BOT_MD = [
  '---',
  'schema: 1',
  'name: Releaser',
  'role: Answers questions about the release checklist.',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - { type: mention }',
  'capabilities:',
  '  native: [messages.post, messages.search, answer.post, pages.write]',
  '---',
  '',
  'RELEASE-HELPER-BODY: you answer questions about the release checklist.',
  '',
].join('\n');

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...conversationStackEnv(), MANYTHREADS_TERMINAL_ENABLED: '1' });
  const api = await apiOn(playwright, stack, 'omar');
  try {
    await addBot(stack, api, 'releaser', BOT_MD);
    const status = await api.ctx.get('/api/teams/engineering/bots/releaser/workshop/terminal');
    expect(status.status(), await status.text()).toBe(200);
    const body = (await status.json()) as { available: boolean; reason: string | null };
    available = body.available;
    why = body.reason ?? '';
  } finally {
    await api.ctx.dispose();
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

test('an admin opens a terminal from the Workshop tab, types into the shell, ends it, and reads the recording with the secret masked', async ({ browser, playwright, isMobile }) => {
  test.skip(!available, `no terminal on this machine: ${why}`);
  test.setTimeout(180_000);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/releaser/chat?view=workshop', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    // ---- the way in is on the Workshop tab, for an admin
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    await page.getByTestId('ws-terminal-open').click();
    await expect(page).toHaveURL(/terminal=1/);
    const view = page.getByTestId('terminal-view');
    await expect(view).toBeVisible();
    await expect(view).toHaveAttribute('data-phase', 'ready');
    // what it is, in plain words, before anything is opened
    await expect(page.getByTestId('terminal-about')).toContainText('throwaway test sandbox');
    await expect(page.getByTestId('terminal-about')).toContainText('no network');
    await expect(page.getByTestId('terminal-input')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);

    // ---- open it: the keys made for the test were switched off first, and the command box takes focus
    await page.getByTestId('terminal-open').click();
    await expect(view).toHaveAttribute('data-phase', 'open', { timeout: 30_000 });
    await expect(page.getByTestId('terminal-revoked')).toContainText('switched off before it opened');
    await expect(page.getByTestId('terminal-input')).toBeFocused();
    const screen = page.getByTestId('terminal-screen');
    await expect(screen).toHaveAttribute('role', 'log');

    // ---- type with the keyboard: the shell is an ordinary user in its own folder
    const input = page.getByTestId('terminal-input');
    await input.fill('id -u; pwd; ls');
    await page.keyboard.press('Enter');
    await expect(screen).toContainText(/\b6[0-4]\d{3}\b/, { timeout: 20_000 });
    await expect(screen).toContainText('/work');
    await expect(screen).toContainText('README.txt');
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();

    // no network, and none of the server's own files or settings
    await input.fill('cat /proc/net/route | wc -l; env | grep -c MANYTHREADS; echo "key AKIAIOSFODNN7EXAMPLE end"');
    await page.keyboard.press('Enter');
    await expect(screen).toContainText('key AKIAIOSFODNN7EXAMPLE end', { timeout: 20_000 });

    // the arrow key brings the last line back
    await page.keyboard.press('ArrowUp');
    await expect(input).toHaveValue(/AKIAIOSFODNN7EXAMPLE/);
    await input.fill('');

    // Ctrl+C with nothing selected stops what is running
    await input.fill('sleep 300');
    await page.keyboard.press('Enter');
    await page.getByTestId('terminal-interrupt').click();
    await input.fill('echo back');
    await page.keyboard.press('Enter');
    await expect(screen).toContainText('back', { timeout: 20_000 });
    expect(await noSidewaysScroll(page)).toBe(true);

    // one terminal per admin: a second one is refused in words while this one is open
    const api = await apiOn(playwright, stack, 'omar');
    try {
      const second = await api.ctx.post('/api/teams/engineering/bots/releaser/workshop/terminal', { data: {}, headers: await api.headers() });
      expect(second.status()).toBe(409);
      expect(await second.text()).toMatch(/already have a terminal open/);
    } finally {
      await api.ctx.dispose();
    }

    // ---- end it
    await page.getByTestId('terminal-end').click();
    await expect(view).toHaveAttribute('data-phase', 'ended');
    await expect(page.getByTestId('terminal-ended')).toHaveText('Ended by an admin.');
    await expect(page.getByTestId('terminal-input')).toBeDisabled();

    // ---- the recording: who and when, and the text with the secret masked
    const earlier = page.getByTestId('terminal-earlier');
    await expect(earlier).toBeVisible();
    await earlier.getByRole('button', { name: 'Show the record' }).first().click();
    const record = page.getByTestId('terminal-record');
    await expect(record).toContainText(/\b6[0-4]\d{3}\b/);
    await expect(record).not.toContainText('AKIAIOSFODNN7EXAMPLE');
    await expect(record).toContainText(/redacted/i);
    expect(await noSidewaysScroll(page)).toBe(true);

    // back to the conversations
    await page.getByTestId('terminal-back').first().click();
    await expect(page.getByTestId('ws-mode-build')).toBeVisible();
    await expect(page).not.toHaveURL(/terminal=1/);
  } finally {
    await context.close();
  }
});

test('closing the page kills the shell, so the admin can open another at once', async ({ browser, playwright, isMobile }) => {
  test.skip(!available, `no terminal on this machine: ${why}`);
  test.setTimeout(120_000);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/bots/releaser/chat?view=workshop&terminal=1', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await page.getByTestId('terminal-open').click();
    await expect(page.getByTestId('terminal-view')).toHaveAttribute('data-phase', 'open', { timeout: 30_000 });
  } finally {
    await context.close();
  }
  const api = await apiOn(playwright, stack, 'omar');
  try {
    // the server notices the closed socket and frees the admin's one place
    await expect
      .poll(
        async () => {
          const res = await api.ctx.post('/api/teams/engineering/bots/releaser/workshop/terminal', { data: {}, headers: await api.headers() });
          if (res.status() === 201) {
            const id = ((await res.json()) as { session: { id: string } }).session.id;
            await api.ctx.post(`/api/teams/engineering/bots/releaser/workshop/terminal/${id}/end`, { data: {}, headers: await api.headers() });
          }
          return res.status();
        },
        { timeout: 30_000, intervals: [500, 1000] },
      )
      .toBe(201);
  } finally {
    await api.ctx.dispose();
  }
});

test('a plain member has no way in, and the server refuses them on every route', async ({ browser, playwright, isMobile }) => {
  test.setTimeout(120_000);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/bots/releaser/chat?view=workshop', isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.getByTestId('workshop-tab')).toBeVisible();
    await expect(page.getByTestId('ws-terminal-open')).toHaveCount(0);
    // the address alone gives nothing
    await page.goto('/t/engineering/bots/releaser/chat?view=workshop&terminal=1');
    await expect(page.getByTestId('ws-terminal-denied')).toHaveText('The terminal is for workspace admins only.');
    await expect(page.getByTestId('terminal-view')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
    const api = await apiOn(playwright, stack, 'nadia');
    try {
      const headers = await api.headers();
      expect((await api.ctx.get('/api/teams/engineering/bots/releaser/workshop/terminal')).status()).toBe(403);
      expect((await api.ctx.post('/api/teams/engineering/bots/releaser/workshop/terminal', { data: {}, headers })).status()).toBe(403);
    } finally {
      await api.ctx.dispose();
    }
  } finally {
    await context.close();
  }
});
