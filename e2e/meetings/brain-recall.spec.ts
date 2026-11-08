import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { SEED_MEETINGS } from '@manythreads/test-utils';
import type { Stack } from '../fixtures/stack.ts';
import { addBot, answeringBrainMd } from '../conversations/support.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { closePerson, meetingsStack, openAs, type Person } from './support.ts';

/**
 * Asking the Brain about a meeting (PLAN P15-17, seed v15). The `meetings` stack holds the finished Engineering stand-up. Nadia asks a Brain bot a question in
 * a conversation; the stand-in model searches the team's meetings (`meetings.search`, a tool of the run), cites the hit and finishes with an Answer. The
 * citation names the meeting, and pressing it opens the meeting's transcript at the line that was cited, marked.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own spec (mobile-web.spec.ts)');
test.describe.configure({ mode: 'serial' });

const spool = join(mkdtempSync(join(tmpdir(), 'manythreads-recall-spool-')), 'hermes.jsonl');
const meetingsBrainMd = (): string => answeringBrainMd().replace('  native: [messages.search, messages.post, answer.post]', '  native: [meetings.search, messages.post, answer.post]');

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;
let meetingId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('meetings', { HERMES_FAKE_SPOOL: spool });
  omar = await apiOn(playwright, stack, 'omar');
  await addBot(stack, omar, 'helper', meetingsBrainMd());
  meetingId = (await stack.sql<{ id: string }>(`SELECT id FROM app.meetings WHERE title = $1`, [SEED_MEETINGS.standup.title]))[0]!.id;
  // the search index of meetings is filled by the search plugin's jobs
  await expect
    .poll(async () => (await stack.sql(`SELECT 1 FROM app.search_meetings(ARRAY[$1]::text[], 'cache', 5)`, [meetingId]).catch(() => [{}])).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
});
test.afterAll(async () => {
  await closePerson(nadia);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('Nadia asks the Brain who writes the rollback note; the answer cites the stand-up and the citation opens the transcript at the line', async ({ browser, playwright }) => {
  nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/bots/helper/chat');
  const box = nadia.page.getByRole('textbox', { name: 'Message Brain' });
  await box.fill('Who writes the rollback note? ANSWER-FROM-MEETINGS rollback');
  await box.press('Enter');
  const answer = nadia.page.getByTestId('answer');
  await expect(answer).toBeVisible({ timeout: 90_000 });

  const cites = nadia.page.getByTestId('answer-citation');
  await expect(cites, `the stand-in saw: ${(() => { try { return readFileSync(spool, 'utf8').slice(-1500); } catch { return 'nothing'; } })()}`).toHaveCount(1);
  await expect(cites.first()).toContainText(SEED_MEETINGS.standup.title);

  await cites.first().click();
  await expect(nadia.page).toHaveURL(new RegExp(`/meetings/${meetingId}\\?t=\\d+`));
  const at = Number(new URL(nadia.page.url()).searchParams.get('t'));
  // the transcript is the tab that opens, and the line the citation points at is marked
  await expect(nadia.page.getByTestId('transcript')).toBeVisible();
  const marked = nadia.page.locator('[data-testid="transcript-line"][aria-current="true"]');
  await expect(marked).toHaveCount(1);
  await expect(marked).toHaveAttribute('data-start-ms', String(at));
  await expect(marked).toContainText('rollback note');
});
