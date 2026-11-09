// T9 · What Tariq must never be able to do (PLAN §4): read Support's email, approve a production deploy, make Brain read somebody else's Drive. Each step shows the screen that
// refuses; the ones a hand-made request could try send it from his own page and show the server's refusal.
// Brain's refusal is proved on the platform's rule, not on the stand-in's words: the stand-in's Answer cites a message of Customer support (a channel Tariq cannot read) and declares nothing
// out of scope, so the "Outside scope" list and the empty citation list are the answer plugin's own check of the citation (`buildAnswer`: a source the asker cannot reach is dropped and counted).
// There is no Drive connection of Omar's in this stack, so "Omar's Drive" itself is not reached by this journey; the ask keeps the words, the proof is the closed message.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** The message of Customer support the stand-in cites. Brain's run is Tariq's, who cannot read it. */
let closedMessage: string | undefined;

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
      id: 'brain-closed-source-asked',
      expect: TID.chatMain,
      composer: true,
      run: async ({ pages, stack, api }) => {
        // a message of a channel he cannot read, named to the stand-in through a file next to the run profiles (the stand-in's environment is the platform's allow-list: no custom variable reaches it)
        const rows = await stack.sql<{ id: string; text: string }>(
          `SELECT m.id, m.body_plain AS text FROM app.messages m JOIN app.channels c ON c.id = m.channel_id JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'customer-support' AND c.kind = 'channel' AND m.thread_root_id IS NULL AND m.body_plain ~ '[A-Za-z]{8,}' ORDER BY m.created_at LIMIT 1`,
        );
        closedMessage = rows[0]?.id;
        expect(closedMessage, 'Customer support has a message to cite').toBeTruthy();
        const word = /[A-Za-z]{8,}/.exec(rows[0]!.text)![0];
        // the control: the search of the server finds that message for a member of Customer support and does not find it for Tariq
        const found = async (who: 'sameera' | 'tariq'): Promise<boolean> => JSON.stringify(await (await api(who)).get(`/api/search?q=${encodeURIComponent(word)}`)).includes(closedMessage!);
        expect(await found('sameera'), `a member of Customer support finds "${word}"`).toBe(true);
        expect(await found('tariq'), `Tariq does not find "${word}"`).toBe(false);
        const runtimeDir = TARIQ_ENV['MANYTHREADS_RUNTIME_DIR']!;
        mkdirSync(runtimeDir, { recursive: true });
        writeFileSync(join(runtimeDir, 'closed-source.txt'), `${closedMessage!}\n${word}\n`, 'utf8');
        await arrangeBrain(stack, [ASK]);
        await pages.inTeam(TEAM).brain.open('brain');
        await pages.inTeam(TEAM).brain.input.fill(ASK);
      },
    },
    {
      id: 'brain-closed-source-outside-scope',
      expect: TID.answer,
      next: { testid: TID.answerOutside, label: 'What Brain could not reach' },
      composer: true,
      run: async ({ pages, page }) => {
        const brain = pages.inTeam(TEAM).brain;
        await brain.input.press('Enter');
        await expect(brain.botMessages.first().getByTestId(TID.answer)).toBeVisible({ timeout: 90_000 });
        await expect(brain.thinking).toHaveCount(0, { timeout: 60_000 });
        // the Answer cites nothing, and what the platform removed sits under "Outside scope" (not in the stand-in's words: it declared nothing)
        await expect(page.getByTestId(TID.answerCitation)).toHaveCount(0);
        await page.getByTestId('answer-sources').locator('summary').click();
        await expect(page.getByTestId(TID.answerOutside)).toBeVisible();
        const row = page.getByTestId('answer-outside-row');
        await expect(row).toHaveCount(1);
        await expect(row).toContainText(/message/i);
        await expect(row).toHaveAttribute('data-reason', 'not_reached');
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
    // the stored Answer, as the server built it: no citation survived, the closed message is counted as out of scope, and its id is nowhere in the stored payload
    const answers = await stack.sql<{ body: string; payload: { citations: unknown[]; outsideScope: { count: number; items: Array<{ kind: string; reason: string }> } } }>(
      `SELECT m.meta->'answer' AS payload, m.body FROM app.messages m WHERE m.meta ? 'answer' AND m.body LIKE '%I did not open anyone else%'`,
    );
    expect(answers, 'Brain answered once').toHaveLength(1);
    const stored = answers[0]!.payload;
    expect(answers[0]!.body, "the run's own search, as Tariq, found none of the closed message").toContain('found 0 messages');
    expect(stored.citations, 'nothing Tariq cannot read is cited').toHaveLength(0);
    expect(stored.outsideScope.count, 'the closed message is counted').toBe(1);
    expect(stored.outsideScope.items[0]?.kind).toBe('message');
    // the platform's reason is that the run never read it (a bot can cite only what its run read, and the run read as Tariq); the stand-in's own search, which ran as Tariq, found none of it
    expect(stored.outsideScope.items[0]?.reason).toBe('not_reached');
    expect(JSON.stringify(stored), 'the id of the closed message is not in the Answer').not.toContain(closedMessage!);
  },
});
