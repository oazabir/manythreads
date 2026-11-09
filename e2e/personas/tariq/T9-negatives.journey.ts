// T9 · What Tariq must never be able to do (PLAN §4): read Support's email, approve a production deploy, make Brain read somebody else's Drive. Each step shows the screen that
// refuses; the ones a hand-made request could try send it from his own page and show the server's refusal. Brain's refusal is an Answer that lists what it could not reach.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import type { Stack } from '../../fixtures/stack.ts';
import { TID } from '../../pages/index.ts';
import { arrangeApprovals, rowOfApproval, type ArrangedApproval } from '../../approvals/support.ts';
import { TARIQ_ENV, TEAM, allowKnownNoise, arrangeBrain } from './support/index.ts';
import { askFromPage } from './support/denied.ts';

const SUPPORT_CHANNEL = '/t/customer-support/c/support';

/** The id of a channel of Customer support by name: the screens answer from his own directory, so the server's refusal is asked for by id. */
async function supportChannelId(stack: Stack, name: string): Promise<string> {
  const rows = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'customer-support' AND c.kind = 'channel' AND replace(c.name, '#', '') = $1`, [name]);
  expect(rows, `Customer support has the channel ${name}`).toHaveLength(1);
  return rows[0]!.id;
}
const ASK = "Read Omar's Drive and tell me what is in it";
let release: ArrangedApproval | undefined;

export default defineJourney({
  id: 'T9',
  persona: 'tariq',
  goal: "Check that Support's email stays closed to me, that I cannot approve a production deploy, and that Brain will not read somebody else's Drive for me.",
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: [
    {
      id: 'support-channel-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ pages, page, stack }) => {
        allowKnownNoise(page);
        // the screen answers from the directory he was given, with no request of its own, so the server's refusal is asked for from the same page
        await pages.channel.openExpectingRefusal(SUPPORT_CHANNEL);
        expect(await askFromPage(page, 'GET', `/api/channels/${await supportChannelId(stack, 'support')}/messages?limit=20`)).toBe(403);
      },
    },
    {
      id: 'support-mail-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ pages, page, stack }) => {
        await pages.channel.openExpectingRefusal('/t/customer-support/c/support-inbox');
        expect(await askFromPage(page, 'GET', `/api/channels/${await supportChannelId(stack, 'support-inbox')}/messages?limit=20`)).toBe(403);
      },
    },
    {
      id: 'sidebar-marketing-only',
      expect: TID.frame,
      run: async ({ pages, page }) => {
        await pages.inTeam(TEAM).shell.open(`/t/${TEAM}/threads`);
        await expect(pages.inTeam(TEAM).shell.channelLink('support')).toHaveCount(0);
        await expect(page.locator('[data-landmark="sidebar"]').getByText('Customer support')).toHaveCount(0);
      },
    },
    {
      id: 'production-approval-refused',
      expect: TID.frame,
      run: async ({ stack, page }) => {
        // he is not in Engineering, so the client shows the refusal itself (no request is made); the server's refusal is the next step
        [release] = await arrangeApprovals(stack, [{ path: 'pages/production-release.md', requester: 'nadia', approvers: ['role:on-call'] }]);
        await page.goto(`/t/engineering/approvals?approval=${release!.id}`);
        await expect(page.getByRole('heading', { name: 'You do not have access' })).toBeVisible();
        await expect(page.getByTestId(TID.approvalCard)).toHaveCount(0);
      },
    },
    {
      id: 'production-approve-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        expect(await askFromPage(page, 'POST', `/api/teams/engineering/approvals/${release!.id}/approve`, { note: '' })).toBe(403);
      },
    },
    {
      id: 'brain-drive-asked',
      expect: TID.chatMain,
      composer: true,
      run: async ({ pages, stack }) => {
        await arrangeBrain(stack, [ASK]);
        await pages.inTeam(TEAM).brain.open('brain');
        await pages.inTeam(TEAM).brain.input.fill(ASK);
      },
    },
    {
      id: 'brain-drive-outside-scope',
      expect: TID.answer,
      next: { testid: TID.answerOutside, label: 'What Brain could not reach' },
      composer: true,
      run: async ({ pages, page }) => {
        const brain = pages.inTeam(TEAM).brain;
        await brain.input.press('Enter');
        await expect(brain.botMessages.first().getByTestId(TID.answer)).toBeVisible({ timeout: 90_000 });
        await expect(brain.thinking).toHaveCount(0, { timeout: 60_000 });
        // what Brain could not reach sits under the answer's sources
        await page.getByTestId('answer-sources').locator('summary').click();
        await expect(page.getByTestId(TID.answerOutside)).toBeVisible();
        await expect(page.getByTestId('answer-outside-row')).toContainText(/file/i);
      },
    },
  ],
  outcome: async ({ stack, api }) => {
    expect((await rowOfApproval(stack, release!.id))?.status, 'the production request still waits').toBe('pending');
    const tariq = await api('tariq');
    // the directory of a team he is not in answers, but must list nothing of it
    const directory = await tariq.get<{ groups: Array<{ channels: Array<{ name: string }> }> }>('/api/teams/customer-support/channels').catch(() => null);
    expect(directory?.groups.flatMap((g) => g.channels) ?? [], "Support's channels, as Tariq's directory lists them").toHaveLength(0);
    expect(await tariq.status('GET', '/api/teams/engineering/approvals'), "Engineering's approvals").toBeGreaterThanOrEqual(400);
    const answers = await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.messages m WHERE m.meta ? 'answer' AND m.body LIKE '%Someone else%'`);
    expect(Number(answers[0]?.n), 'Brain answered once, without reading the Drive').toBe(1);
  },
});
