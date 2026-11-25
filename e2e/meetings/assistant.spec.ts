import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, enterRoom, lastMeeting, meetingsStack, openAs, say, threadLines, turnOnTranscription, type Person } from './support.ts';

/**
 * The meeting assistant in a call (PLAN P17-06, docs/plans/meeting-assistant.md), on the fake media server, desktop and 390 px. Nadia's call has no note-taker, so Brain
 * answers: she says a line (her device writes it down), opens Ask, types a question; the stand-in model answers, the answer shows in her panel and in the call's thread as
 * Brain. Rafi comes in after the line and presses Catch me up: the stand-in fast model's summary is shown to him. At 390 px the panel is a block of the call sheet and the page
 * never scrolls sideways.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let fast: Server;
const summaries: string[] = [];
let nadia: Person | undefined;
let rafi: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  // the stack's fast model: a summary that says how many lines it was given
  fast = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: Array<{ role: string; content: string }> };
        const user = body.messages?.find((m) => m.role === 'user')?.content ?? '';
        summaries.push(user);
        const n = user.split('\n').filter((l) => l.startsWith('@')).length;
        res.end(JSON.stringify({ choices: [{ message: { content: `Before you came, Nadia said ${n} thing${n === 1 ? '' : 's'}: the release ships on Thursday.` } }], usage: { prompt_tokens: 10, completion_tokens: 5 }, model: 'fake-fast' }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => fast.listen(0, '127.0.0.1', resolve));
  const port = (fast.address() as { port: number }).port;
  stack = await meetingsStack('content', { MANYTHREADS_LITELLM_URL: `http://127.0.0.1:${port}` });
  omar = await apiOn(playwright, stack, 'omar');
  await stack.sql(`INSERT INTO app.llm_aliases (workspace_id, alias, provider_id, model, fallbacks) SELECT id, 'fast', NULL, 'fake/fast', '{}' FROM app.workspaces ON CONFLICT DO NOTHING`);
  // the workspace Brain is made by the bots plugin's job at start; wait for it
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.bots WHERE scope = 'workspace' AND slug = 'brain' AND status = 'active'`)).length, { timeout: 60_000 }).toBe(1);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await closePerson(rafi);
  await omar?.ctx.dispose();
  await stack?.stop();
  await new Promise<void>((resolve) => (fast ? fast.close(() => resolve()) : resolve()));
});

test('Brain answers a typed question from the call so far; a late joiner is caught up', async ({ browser, playwright, isMobile }) => {
  const room = isMobile ? 'assistant-phone' : 'assistant-desk';
  await omar.post('/api/teams/engineering/channels', { name: room });
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${room}`, { mobile: isMobile });
  await enterRoom(nadia);
  const page = nadia.page;
  if (isMobile) await page.getByRole('button', { name: 'Show call details' }).click();
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');
  await say(nadia, 'The release ships on Thursday.');
  const meeting = await lastMeeting(stack, room);
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND text <> ''`, [meeting.id])).length, { timeout: 20_000 }).toBeGreaterThan(0);

  await page.getByTestId('call-assistant').click();
  const panel = page.getByTestId('assistant-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Ask Brain');
  await panel.getByTestId('assistant-question').fill('When does the release ship?');
  await panel.getByTestId('assistant-ask').click();
  await expect(panel.getByTestId('assistant-ask-item').first()).toContainText('When does the release ship?');
  await expect(panel.getByTestId('assistant-answer').first()).toContainText('we ship on Thursday morning', { timeout: 90_000 });
  await expect.poll(async () => (await threadLines(stack, meeting.id)).some((m) => m.kind === 'bot' && m.body.includes('Nadia asked Brain')), { timeout: 20_000 }).toBe(true);
  // the phone: nothing is wider than the screen
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath(`ask-panel-${isMobile ? 390 : 1440}.png`) });

  // Rafi comes in after the line and asks what he missed
  rafi = await openAs(browser, playwright, stack, 'rafi', `/t/engineering/c/${room}`, { mobile: isMobile });
  await enterRoom(rafi);
  if (isMobile) await rafi.page.getByRole('button', { name: 'Show call details' }).click();
  await rafi.page.getByTestId('call-assistant').click();
  const his = rafi.page.getByTestId('assistant-panel');
  await his.getByTestId('assistant-catchup-btn').click();
  await expect(his.getByTestId('assistant-catchup-text')).toContainText('the release ships on Thursday', { timeout: 30_000 });
  expect(summaries.at(-1)).toContain('The release ships on Thursday.');
  expect(await rafi.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // the summary is his only
  await expect(page.getByTestId('assistant-catchup-text')).toHaveCount(0);
});
