import { expect, test } from '@playwright/test';
import type { Stack } from '../fixtures/stack.ts';
import { apiOn, type StackApi } from '../support/stack-browser.ts';
import { answerConsent, closePerson, endForEveryone, enterRoom, lastMeeting, meetingsStack, openAs, say, turnOnTranscription, type Person } from './support.ts';

/**
 * Mark action item and the end-of-call review (PLAN P17-06 step 2, docs/plans/meeting-assistant.md), on the fake media server, desktop and 390 px. Nadia presses the flag
 * before anything was said (the bar says why not), says a line and presses it again (the bar shows what was kept), and ends the call. The review opens (the job is asked at
 * once: in the stack the Scribe's notes would make it wait up to ten minutes); on the meeting page she changes the item's words, gives it to herself and confirms.
 * The screenshots are the `meetings/review` baseline's source.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: Person | undefined;

test.beforeAll(async ({ playwright }) => {
  stack = await meetingsStack('content');
  omar = await apiOn(playwright, stack, 'omar');
});
test.afterAll(async () => {
  await closePerson(nadia);
  await omar?.ctx.dispose();
  await stack?.stop();
});

test('a mark in the call becomes an action item to confirm after it', async ({ browser, playwright, isMobile }) => {
  const room = isMobile ? 'review-phone' : 'review-desk';
  await omar.post('/api/teams/engineering/channels', { name: room });
  nadia = await openAs(browser, playwright, stack, 'nadia', `/t/engineering/c/${room}`, { mobile: isMobile });
  await enterRoom(nadia);
  const page = nadia.page;
  if (isMobile) await page.getByRole('button', { name: 'Show call details' }).click();
  await turnOnTranscription(nadia);
  await answerConsent(nadia, 'yes');

  // nothing said yet: the bar says why not
  await page.getByTestId('call-mark').click();
  await expect(page.getByTestId('call-mark-note')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('call-mark-note')).toContainText('Nothing was written down in the last 30 seconds');

  await say(nadia, 'I will send the release notes by Friday.');
  const meeting = await lastMeeting(stack, room);
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_segments WHERE meeting_id = $1 AND text <> ''`, [meeting.id])).length, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByTestId('call-mark').click();
  await expect(page.getByTestId('call-mark-note')).toHaveAttribute('data-state', 'marked');
  await expect(page.getByTestId('call-mark-note')).toContainText('Nadia: I will send the release notes by Friday.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await endForEveryone(nadia);
  await stack.sql(`SELECT app.enqueue_job('meetings.review', jsonb_build_object('meetingId', id::text, 'workspaceId', workspace_id::text), now(), NULL) FROM app.meetings WHERE id = $1`, [meeting.id]);
  await expect.poll(async () => (await stack.sql(`SELECT 1 FROM app.meeting_reviews WHERE meeting_id = $1`, [meeting.id])).length, { timeout: 30_000 }).toBe(1);

  await page.goto(`/meetings/${meeting.id}`);
  const review = page.getByTestId('meeting-review');
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review.getByTestId('review-item')).toHaveCount(1);
  await expect(review.getByTestId('review-confirm')).toHaveText('Confirm before sending: 1 action item');
  await review.getByTestId('review-text').fill('Send the release notes by Friday');
  await review.getByTestId('review-owner').selectOption({ label: 'Nadia' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: test.info().outputPath(`review-${isMobile ? 390 : 1440}.png`) });
  await review.getByTestId('review-confirm').click();
  await expect(review.getByTestId('review-confirmed')).toHaveText('Confirmed by Nadia · 1 action item');
  await expect(review.getByTestId('review-confirmed-item')).toContainText('Send the release notes by Friday');
  const events = await stack.sql(`SELECT payload FROM app.events WHERE type = 'meetings.action_items.confirmed' AND payload->>'meetingId' = $1`, [meeting.id]);
  expect(events).toHaveLength(1);
});
